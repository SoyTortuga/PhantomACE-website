#!/usr/bin/env node
/* ══════════════════════════════════════════════
   FORUM MODERATION — test suite

     node server/scripts/test-forum-moderation.js

   The rules first (staffRule, reportRule, validateReason), then the
   moderation queries on a real Postgres (pglite): pin and lock, a
   moderator's removal with its reason, the notification written beside
   it, the reply count going down and coming back on restore, a whole
   topic removed and restored with its posts intact, and the report queue
   from first flag to resolution.

   LOAD-BEARING: the staff check in staffRule. Removing it — or letting
   session.role stand in for the moderator list — fails this suite by
   exit code.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { staffRule, reportRule, validateReason, REASON_MAX } from '../../functions/api/forum/rules.js';
import {
  createThread, createReply, getThread, listThreads, listPosts, getPost,
  setThreadFlags, deleteThread, restoreThread, moderateDeletePost, restorePost,
  reportPost, listOpenReports, openReportCount, resolveReports,
} from '../../functions/api/forum/queries.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SQL = fs.readFileSync(path.join(HERE, '../sql/006_forum.sql'), 'utf8');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);
const status = (r) => (r.ok ? 'ok' : r.status);

const viewer = { user_id: '100', login: 'viewer', subTier: 0, role: 'viewer' };
const modNotSub = { user_id: '300', login: 'mod', subTier: 0, role: 'moderator' };

/* ── Rules ───────────────────────────────────────────────────────────── */
{
  check('a guest is 401', status(staffRule({ session: null, staff: false })), 401);
  check('a viewer is 403', status(staffRule({ session: viewer, staff: false })), 403);
  check('staff is ok', status(staffRule({ session: modNotSub, staff: true })), 'ok');
  /* THE ROLE TRAP, again: role says moderator, the list says no. */
  check('role:moderator without the staff flag is 403', status(staffRule({ session: modNotSub, staff: false })), 403);
  check('a viewer the list says IS staff is ok — the list decides, not the role',
    status(staffRule({ session: viewer, staff: true })), 'ok');

  const post = { id: '5', userId: '200', deleted: false };
  check('a guest cannot report', status(reportRule({ session: null, post })), 401);
  check('a viewer can report somebody else\'s post', status(reportRule({ session: viewer, post })), 'ok');
  check('not their own', status(reportRule({ session: { user_id: '200' }, post })), 400);
  check('not a missing post', status(reportRule({ session: viewer, post: null })), 404);
  check('not a removed post', status(reportRule({ session: viewer, post: { ...post, deleted: true } })), 410);

  check('a reason is trimmed and collapsed', validateReason('  off   topic \n'), { value: 'off topic' });
  ok('an empty reason errors', validateReason('').error);
  ok('a missing reason errors', validateReason(undefined).error);
  ok('a reason over the cap errors', validateReason('x'.repeat(REASON_MAX + 1)).error);
  check('a reason at the cap is fine', validateReason('x'.repeat(REASON_MAX)).value.length, REASON_MAX);
}

/* ── Queries ─────────────────────────────────────────────────────────── */
const db = new PGlite();
await db.exec(SQL);
const inTx = (fn) => db.transaction((tx) => fn(tx));
const notifications = async (userId) =>
  (await db.query(`SELECT kind, post_id FROM notifications WHERE user_id = $1 ORDER BY id`, [userId])).rows
    .map(r => ({ kind: r.kind, postId: String(r.post_id) }));

const MOD = '300';
const { threadId, postId: opId } = await inTx(tx => createThread(tx, { categoryId: 'general', userId: '100', title: 'Topic', body: 'op' }));
const r1 = await inTx(tx => createReply(tx, { threadId, userId: '200', body: 'reply one' }));
const r2 = await inTx(tx => createReply(tx, { threadId, userId: '200', body: 'reply two' }));
const other = await inTx(tx => createThread(tx, { categoryId: 'general', userId: '200', title: 'Other', body: 'x' }));

/* Pin and lock. */
{
  check('pin', await inTx(tx => setThreadFlags(tx, threadId, { pinned: true })), true);
  check('reads back pinned', (await getThread(db, threadId)).pinned, true);
  check('and leads the board', (await listThreads(db, 'general')).threads[0].id, threadId);
  check('lock', await inTx(tx => setThreadFlags(tx, threadId, { locked: true })), true);
  check('reads back locked, still pinned', [(await getThread(db, threadId)).locked, (await getThread(db, threadId)).pinned], [true, true]);
  let err = null;
  try { await inTx(tx => createReply(tx, { threadId, userId: '100', body: 'x' })); } catch (e) { err = e; }
  check('a locked topic refuses a reply at the query too', err && err.code, 'locked');
  check('unlock and unpin', await inTx(tx => setThreadFlags(tx, threadId, { locked: false, pinned: false })), true);
  check('no flags given is a no-op', await inTx(tx => setThreadFlags(tx, threadId, {})), false);
  check('flags on a missing topic', await inTx(tx => setThreadFlags(tx, '9999', { pinned: true })), false);
}

/* A moderator removes a reply. */
{
  check('reply_count is 2', (await getThread(db, threadId)).replyCount, 2);
  check('removal succeeds', await inTx(tx => moderateDeletePost(tx, { id: r1.postId, byUserId: MOD, reason: 'spam' })), true);
  const p = await getPost(db, r1.postId);
  check('marked removed, body kept', [p.deleted, p.body], [true, 'reply one']);
  const raw = (await db.query(`SELECT deleted_by, delete_reason FROM forum_posts WHERE id = $1`, [r1.postId])).rows[0];
  check('with who and why', [raw.deleted_by, raw.delete_reason], [MOD, 'spam']);
  check('the tombstone reads as a moderator\'s', (await listPosts(db, threadId)).posts[1].deleted, 'moderator');
  check('reply_count went to 1', (await getThread(db, threadId)).replyCount, 1);
  check('the author was told', await notifications('200'), [{ kind: 'moderation', postId: r1.postId }]);
  check('the moderator was not', await notifications(MOD), []);
  check('removing it again does nothing', await inTx(tx => moderateDeletePost(tx, { id: r1.postId, byUserId: MOD, reason: 'again' })), false);
  check('and sends no second notification', (await notifications('200')).length, 1);

  /* Restore: count and body come back, the reason goes. */
  check('restore', await inTx(tx => restorePost(tx, { id: r1.postId })), true);
  const back = await getPost(db, r1.postId);
  check('it is live again with its text', [back.deleted, back.body], [false, 'reply one']);
  check('reply_count is 2 again', (await getThread(db, threadId)).replyCount, 2);
  const cleared = (await db.query(`SELECT deleted_by, delete_reason FROM forum_posts WHERE id = $1`, [r1.postId])).rows[0];
  check('who and why are cleared', [cleared.deleted_by, cleared.delete_reason], [null, null]);
  check('restoring a live post does nothing', await inTx(tx => restorePost(tx, { id: r1.postId })), false);
  check('and does not inflate the count', (await getThread(db, threadId)).replyCount, 2);
}

/* A moderator removes an opening post, and their own post. */
{
  check('the opening post can be removed', await inTx(tx => moderateDeletePost(tx, { id: opId, byUserId: MOD, reason: 'rules' })), true);
  check('without touching reply_count', (await getThread(db, threadId)).replyCount, 2);
  check('the topic still reads', !!(await getThread(db, threadId)), true);
  check('restore it', await inTx(tx => restorePost(tx, { id: opId })), true);
  check('reply_count still 2', (await getThread(db, threadId)).replyCount, 2);

  const mine = await inTx(tx => createReply(tx, { threadId, userId: MOD, body: 'mod says' }));
  check('a moderator removing their own post', await inTx(tx => moderateDeletePost(tx, { id: mine.postId, byUserId: MOD, reason: 'typo' })), true);
  check('is an author delete to the reader', (await listPosts(db, threadId)).posts.find(p => p.id === mine.postId).deleted, 'author');
  check('and notifies nobody', await notifications(MOD), []);
}

/* A whole topic. */
{
  check('remove the topic', await inTx(tx => deleteThread(tx, { id: other.threadId, byUserId: MOD })), true);
  check('it no longer reads', await getThread(db, other.threadId), null);
  check('nor lists', (await listThreads(db, 'general')).threads.map(t => t.id), [threadId]);
  check('its posts are untouched', (await listPosts(db, other.threadId)).posts[0].body, 'x');
  check('flags on a removed topic are refused', await inTx(tx => setThreadFlags(tx, other.threadId, { pinned: true })), false);
  check('removing it twice does nothing', await inTx(tx => deleteThread(tx, { id: other.threadId, byUserId: MOD })), false);
  check('restore', await inTx(tx => restoreThread(tx, { id: other.threadId })), true);
  check('it is back', (await getThread(db, other.threadId)).title, 'Other');
  check('restoring a live topic does nothing', await inTx(tx => restoreThread(tx, { id: other.threadId })), false);
}

/* The report queue. */
{
  check('the queue starts empty', await openReportCount(db), 0);
  check('a report lands', await inTx(tx => reportPost(tx, { postId: r2.postId, reporterId: '100', reason: 'rude' })), true);
  check('the same person again is a no-op', await inTx(tx => reportPost(tx, { postId: r2.postId, reporterId: '100', reason: 'still rude' })), false);
  check('a second person is a second report', await inTx(tx => reportPost(tx, { postId: r2.postId, reporterId: '400', reason: 'agree' })), true);
  check('two open', await openReportCount(db), 2);

  const q = await listOpenReports(db);
  check('the queue has both, oldest first', q.map(r => [r.reporterId, r.reason]), [['100', 'rude'], ['400', 'agree']]);
  check('each knows the post and its author', [q[0].postId, q[0].authorId, q[0].threadId, q[0].threadTitle, q[0].postDeleted],
    [r2.postId, '200', threadId, 'Topic', false]);
  check('with an excerpt', q[0].excerpt, 'reply two');

  /* A removal resolves the post's reports; the route does both in one
     transaction. Here, the two steps, to see each. */
  await inTx(tx => moderateDeletePost(tx, { id: r2.postId, byUserId: MOD, reason: 'rude indeed' }));
  check('a removed post is still in the queue until resolved', (await listOpenReports(db))[0].postDeleted, true);
  check('resolving closes every report on the post', await inTx(tx => resolveReports(tx, { postId: r2.postId, byUserId: MOD })), 2);
  check('the queue is empty', await openReportCount(db), 0);
  check('resolving again closes nothing', await inTx(tx => resolveReports(tx, { postId: r2.postId, byUserId: MOD })), 0);
  const who = (await db.query(`SELECT resolved_by FROM forum_reports WHERE post_id = $1`, [r2.postId])).rows;
  check('and records who', who.map(r => r.resolved_by), [MOD, MOD]);

  /* A long body is cut to an excerpt in the queue, not shipped whole. */
  const long = await inTx(tx => createReply(tx, { threadId, userId: '200', body: 'y'.repeat(3000) }));
  await inTx(tx => reportPost(tx, { postId: long.postId, reporterId: '100', reason: 'wall' }));
  check('the queue excerpt is capped', (await listOpenReports(db))[0].excerpt.length, 240);
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[forum-moderation] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[forum-moderation] ${passed} assertions passed.`);
console.log('');
process.exit(0);
