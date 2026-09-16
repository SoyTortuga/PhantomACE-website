#!/usr/bin/env node
/* ══════════════════════════════════════════════
   FORUM SCHEMA — test suite

     node server/scripts/test-forum-schema.js

   The first test in this codebase that runs against a real database. Every
   other suite stubs env.MARKETPLACE, which works because those handlers
   only ever ask a key-value question. The forum asks relational ones, and
   a stub that answers "does the CHECK constraint refuse a body of 8001
   characters" is a stub that has re-implemented Postgres.

   So this runs Postgres 18 itself, in-process, through pglite. No server,
   no service, no DATABASE_URL: the database is created empty in memory,
   006_forum.sql is applied to it, and it is thrown away at the end. It is
   the "scratch database" the plan calls for, on a machine that has none.

   Two kinds of claim are checked. Constraints: what the schema refuses.
   Indexes: whether each query the pages will run can use one, judged by
   EXPLAIN at twenty thousand rows — at ten rows the planner seq-scans
   everything and the test would prove nothing.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SQL = fs.readFileSync(path.join(HERE, '../sql/006_forum.sql'), 'utf8');

let passed = 0;
const failures = [];
const ok = (label, cond, note = '') => { if (cond) passed++; else failures.push(label + (note ? `\n      ${note}` : '')); };

async function rejects(db, sql, params) {
  try { await db.query(sql, params); return null; } catch (e) { return e.message; }
}
async function planOf(db, sql) {
  return (await db.query('EXPLAIN ' + sql)).rows.map(r => r['QUERY PLAN']).join('\n');
}
const usesIndex = (plan) => /Index/.test(plan) && !/Seq Scan/.test(plan);

const db = new PGlite();

/* ── The migration itself ─────────────────────────────────────────────── */
{
  let err = null;
  try { await db.exec(SQL); } catch (e) { err = e.message; }
  ok('006_forum.sql applies to an empty database', !err, err);
  if (err) report();

  err = null;
  try { await db.exec(SQL); } catch (e) { err = e.message; }
  ok('and applies a second time without complaint', !err, err);

  const cats = (await db.query('SELECT id, staff_only, sub_only FROM forum_categories ORDER BY position')).rows;
  ok('six categories, seeded once', cats.length === 6);
  ok('announcements is staff-only', cats[0].id === 'announcements' && cats[0].staff_only === true);
  ok('nothing is sub-only at launch', cats.every(c => c.sub_only === false));
}

/* ── What the schema refuses ──────────────────────────────────────────── */
const tid = (await db.query(
  `INSERT INTO forum_threads (category_id, user_id, title) VALUES ('general', 'u1', 'Hello') RETURNING id`
)).rows[0].id;
{
  ok('a title over 120 is refused',
    !!(await rejects(db, `INSERT INTO forum_threads (category_id, user_id, title) VALUES ('general', 'u1', $1)`, ['x'.repeat(121)])));
  ok('an empty title is refused',
    !!(await rejects(db, `INSERT INTO forum_threads (category_id, user_id, title) VALUES ('general', 'u1', '')`)));
  ok('a thread in a category that does not exist is refused',
    !!(await rejects(db, `INSERT INTO forum_threads (category_id, user_id, title) VALUES ('nope', 'u1', 'x')`)));

  ok('an empty body is refused',
    !!(await rejects(db, `INSERT INTO forum_posts (thread_id, user_id, body) VALUES ($1, 'u1', '')`, [tid])));
  ok('a body over 8000 is refused',
    !!(await rejects(db, `INSERT INTO forum_posts (thread_id, user_id, body) VALUES ($1, 'u1', $2)`, [tid, 'x'.repeat(8001)])));
  ok('a body of exactly 8000 is accepted',
    !(await rejects(db, `INSERT INTO forum_posts (thread_id, user_id, body) VALUES ($1, 'u1', $2)`, [tid, 'x'.repeat(8000)])));

  /* one_home: a post hangs in a thread OR on a profile, never both, never neither. */
  ok('a thread reply is accepted',
    !(await rejects(db, `INSERT INTO forum_posts (thread_id, user_id, body) VALUES ($1, 'u2', 'reply')`, [tid])));
  ok('a profile comment is accepted',
    !(await rejects(db, `INSERT INTO forum_posts (profile_id, user_id, body) VALUES ('u9', 'u2', 'hi')`)));
  ok('a post with neither home is refused',
    !!(await rejects(db, `INSERT INTO forum_posts (user_id, body) VALUES ('u2', 'x')`)));
  ok('a post with both homes is refused',
    !!(await rejects(db, `INSERT INTO forum_posts (thread_id, profile_id, user_id, body) VALUES ($1, 'u9', 'u2', 'x')`, [tid])));

  ok('an unknown notification kind is refused',
    !!(await rejects(db, `INSERT INTO notifications (user_id, kind) VALUES ('u1', 'spam')`)));
  ok('a report with no reason is refused',
    !!(await rejects(db, `INSERT INTO forum_reports (post_id, reporter_id, reason) VALUES (1, 'u2', '')`)));
  ok('a category with threads in it cannot be deleted',
    !!(await rejects(db, `DELETE FROM forum_categories WHERE id = 'general'`)));
}

/* ── The transaction a reply runs ─────────────────────────────────────── */
{
  const before = (await db.query(`SELECT reply_count FROM forum_threads WHERE id = $1`, [tid])).rows[0].reply_count;
  await db.exec('BEGIN');
  const r = await db.query(`INSERT INTO forum_posts (thread_id, user_id, body) VALUES ($1, 'u3', 'reply') RETURNING id`, [tid]);
  await db.query(`UPDATE forum_threads SET reply_count = reply_count + 1, last_post_at = now() WHERE id = $1`, [tid]);
  await db.query(`INSERT INTO forum_mentions (post_id, user_id) VALUES ($1, 'u1') ON CONFLICT DO NOTHING`, [r.rows[0].id]);
  await db.query(`INSERT INTO forum_mentions (post_id, user_id) VALUES ($1, 'u1') ON CONFLICT DO NOTHING`, [r.rows[0].id]);
  await db.query(`INSERT INTO notifications (user_id, kind, post_id) VALUES ('u1', 'reply', $1)`, [r.rows[0].id]);
  await db.exec('COMMIT');
  const after = (await db.query(`SELECT reply_count FROM forum_threads WHERE id = $1`, [tid])).rows[0].reply_count;
  ok('reply_count advances inside the post transaction', after === before + 1);
  const m = (await db.query(`SELECT count(*)::int AS n FROM forum_mentions WHERE post_id = $1`, [r.rows[0].id])).rows[0].n;
  ok('the same person mentioned twice in one post is one row', m === 1);

  /* A failed post leaves no notification behind. */
  await db.exec('BEGIN');
  await db.query(`INSERT INTO notifications (user_id, kind) VALUES ('u1', 'reply')`);
  const bad = await rejects(db, `INSERT INTO forum_posts (thread_id, user_id, body) VALUES ($1, 'u3', '')`, [tid]);
  await db.exec('ROLLBACK');
  const n = (await db.query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = 'u1'`)).rows[0].n;
  ok('a notification written alongside a post that fails is rolled back with it', !!bad && n === 1);
}

/* ── Soft delete ──────────────────────────────────────────────────────── */
{
  const pid = (await db.query(`SELECT id FROM forum_posts WHERE thread_id = $1 ORDER BY id LIMIT 1`, [tid])).rows[0].id;
  await db.query(`INSERT INTO forum_reports (post_id, reporter_id, reason) VALUES ($1, 'u2', 'rude')`, [pid]);
  ok('the same person reporting the same post twice is a no-op, not a second row',
    !!(await rejects(db, `INSERT INTO forum_reports (post_id, reporter_id, reason) VALUES ($1, 'u2', 'again')`, [pid])));

  await db.query(`UPDATE forum_posts SET deleted_at = now(), deleted_by = 'mod1', delete_reason = 'off topic' WHERE id = $1`, [pid]);
  const d = (await db.query(`SELECT deleted_by, delete_reason, body FROM forum_posts WHERE id = $1`, [pid])).rows[0];
  ok('a moderator delete records who and why', d.deleted_by === 'mod1' && d.delete_reason === 'off topic');
  ok('and keeps the body, so it can be undone', d.body.length > 0);

  const live = (await db.query(`SELECT count(*)::int AS n FROM forum_posts WHERE thread_id = $1 AND deleted_at IS NULL`, [tid])).rows[0].n;
  const all = (await db.query(`SELECT count(*)::int AS n FROM forum_posts WHERE thread_id = $1`, [tid])).rows[0].n;
  ok('deleting the opening post leaves the replies readable', live === all - 1 && live > 0);
}

/* ── Every query a page runs can use an index ─────────────────────────── */
{
  await db.exec(`INSERT INTO forum_posts (thread_id, user_id, body)
                 SELECT ${tid}, 'u' || (g % 200), 'filler' FROM generate_series(1, 20000) g`);
  await db.exec(`INSERT INTO forum_threads (category_id, user_id, title, last_post_at)
                 SELECT 'general', 'u' || (g % 200), 'thread ' || g, now() - (g || ' seconds')::interval
                 FROM generate_series(1, 5000) g`);
  await db.exec(`INSERT INTO notifications (user_id, kind)
                 SELECT 'u' || (g % 200), 'reply' FROM generate_series(1, 20000) g`);
  await db.exec(`INSERT INTO forum_reports (post_id, reporter_id, reason)
                 SELECT p.id, 'r' || g, 'x' FROM generate_series(1, 3000) g, LATERAL (SELECT id FROM forum_posts ORDER BY id LIMIT 1 OFFSET g) p`);
  await db.exec('ANALYZE');

  const q = {
    'category listing, pinned first then newest activity':
      `SELECT id FROM forum_threads WHERE category_id = 'general' AND deleted_at IS NULL ORDER BY pinned DESC, last_post_at DESC LIMIT 20`,
    'thread page, oldest first, offset paginated':
      `SELECT id FROM forum_posts WHERE thread_id = ${tid} AND deleted_at IS NULL ORDER BY created_at LIMIT 20 OFFSET 40`,
    'profile wall, newest first':
      `SELECT id FROM forum_posts WHERE profile_id = 'u9' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 20`,
    'threads started by one person':
      `SELECT id FROM forum_threads WHERE user_id = 'u7' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 20`,
    'post count for a profile':
      `SELECT count(*) FROM forum_posts WHERE user_id = 'u7'`,
    'rate-limit window (posts in the last minute)':
      `SELECT count(*) FROM forum_posts WHERE user_id = 'u7' AND created_at > now() - interval '1 minute'`,
    'unread count for the bell':
      `SELECT count(*) FROM notifications WHERE user_id = 'u7' AND read_at IS NULL`,
    'notification list':
      `SELECT id FROM notifications WHERE user_id = 'u7' ORDER BY created_at DESC LIMIT 30`,
    'open report queue, oldest first':
      `SELECT id FROM forum_reports WHERE resolved_at IS NULL ORDER BY created_at LIMIT 50`,
  };
  for (const [label, sql] of Object.entries(q)) {
    const plan = await planOf(db, sql);
    ok(`${label} uses an index`, usesIndex(plan), plan.split('\n').slice(0, 3).join(' | '));
  }
}

report();

function report() {
  console.log('');
  if (failures.length) {
    console.log(`[forum-schema] ${passed} passed, ${failures.length} FAILED`);
    console.log('');
    for (const f of failures) console.log(`  FAIL: ${f}`);
    console.log('');
    process.exit(1);
  }
  console.log(`[forum-schema] ${passed} assertions passed.`);
  console.log('');
  process.exit(0);
}
