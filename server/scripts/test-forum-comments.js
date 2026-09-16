#!/usr/bin/env node
/* ══════════════════════════════════════════════
   PROFILE COMMENTS — test suite

     node server/scripts/test-forum-comments.js

   The rule (commentRule), then the wall queries on a real Postgres
   (pglite): a comment and the owner's notification in one transaction,
   newest-first listing, the count, and — the point of sharing the posts
   table — that editing, deleting, moderating and reporting a profile
   comment all work through the code written for thread replies, with
   the thread-only bookkeeping (reply_count) correctly left alone.

   LOAD-BEARING: the owner's switch in commentRule. Removing it fails
   this suite by exit code.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { commentRule, ownPostRule, reportRule, POSTS_PER_MINUTE } from '../../functions/api/forum/rules.js';
import {
  listComments, commentCount, createComment, getPost, editPost, deleteOwnPost,
  moderateDeletePost, restorePost, reportPost, listOpenReports, recentPostCount,
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
const status = (r) => (r.ok ? 'ok' : r.status);

const viewer = { user_id: '100', login: 'viewer', subTier: 0, role: 'viewer' };
const owner = { userId: '500', login: 'host', displayName: 'Host', commentsEnabled: true };

/* ── Rule ────────────────────────────────────────────────────────────── */
{
  check('a guest cannot comment', status(commentRule({ session: null, owner })), 401);
  check('a viewer can', status(commentRule({ session: viewer, owner })), 'ok');
  check('nobody by that name is 404', status(commentRule({ session: viewer, owner: null })), 404);
  /* LOAD-BEARING */
  check('comments off refuses', status(commentRule({ session: viewer, owner, enabled: false })), 403);
  check('and refuses the owner too', status(commentRule({ session: { user_id: '500' }, owner, enabled: false })), 403);
  check('the owner may comment on their own wall when on', status(commentRule({ session: { user_id: '500' }, owner })), 'ok');
  check('the per-minute limit applies', status(commentRule({ session: viewer, owner, recentPosts: POSTS_PER_MINUTE })), 429);
  check('under it is fine', status(commentRule({ session: viewer, owner, recentPosts: POSTS_PER_MINUTE - 1 })), 'ok');
}

/* ── Queries ─────────────────────────────────────────────────────────── */
const db = new PGlite();
await db.exec(SQL);
const inTx = (fn) => db.transaction((tx) => fn(tx));
const notifications = async (userId) =>
  (await db.query(`SELECT kind, post_id FROM notifications WHERE user_id = $1 ORDER BY id`, [userId])).rows
    .map(r => ({ kind: r.kind, postId: String(r.post_id) }));

const WALL = '500';
{
  check('an empty wall', await listComments(db, WALL), { comments: [], total: 0, pages: 1 });
  check('and a zero count', await commentCount(db, WALL), 0);

  const c1 = await inTx(tx => createComment(tx, { profileId: WALL, userId: '100', body: 'gg last night' }));
  check('the owner is told', await notifications(WALL), [{ kind: 'comment', postId: c1.postId }]);
  const own = await inTx(tx => createComment(tx, { profileId: WALL, userId: WALL, body: 'thanks all' }));
  check('but not about their own comment', (await notifications(WALL)).length, 1);

  const { comments, total } = await listComments(db, WALL);
  check('two comments, newest first', [total, comments.map(c => c.body)], [2, ['thanks all', 'gg last night']]);
  check('shaped like posts', Object.keys(comments[0]).sort(), ['body', 'createdAt', 'editedAt', 'id', 'mentions', 'userId']);

  /* A comment is a post: the rules and queries for replies apply. */
  const p = await getPost(db, c1.postId);
  check('getPost sees a profile comment', [p.profileId, p.threadId, p.threadLocked, p.threadDeleted, p.isOpening],
    [WALL, null, false, false, false]);
  check('the author may edit it', status(ownPostRule({ session: viewer, post: p })), 'ok');
  check('the wall owner may not — it is not theirs', status(ownPostRule({ session: { user_id: WALL }, post: p })), 403);
  check('editPost works on it', await inTx(tx => editPost(tx, { id: c1.postId, body: 'gg last night!' })), true);
  check('and it reads back edited', (await listComments(db, WALL)).comments[1].body, 'gg last night!');

  check('the owner may report it', status(reportRule({ session: { user_id: WALL }, post: p })), 'ok');
  check('and it lands in the queue', await inTx(tx => reportPost(tx, { postId: c1.postId, reporterId: WALL, reason: 'spam' })), true);
  const q = await listOpenReports(db);
  check('marked as a profile comment, no thread', [q[0].profileId, q[0].threadId, q[0].threadTitle], [WALL, null, null]);

  /* Moderator removal on a profile comment: no thread, so no reply_count
     to touch, and the author is still told. */
  check('a moderator can remove it', await inTx(tx => moderateDeletePost(tx, { id: c1.postId, byUserId: '300', reason: 'spam' })), true);
  check('the author is told', await notifications('100'), [{ kind: 'moderation', postId: c1.postId }]);
  check('it leaves the wall', (await listComments(db, WALL)).comments.map(c => c.body), ['thanks all']);
  check('the count follows', await commentCount(db, WALL), 1);
  check('restore brings it back', await inTx(tx => restorePost(tx, { id: c1.postId })), true);
  check('newest first still holds', (await listComments(db, WALL)).comments.map(c => c.body), ['thanks all', 'gg last night!']);

  /* Own delete. */
  check('the author can delete their own', await inTx(tx => deleteOwnPost(tx, { id: c1.postId, userId: '100' })), true);
  check('and it is gone from the wall', (await listComments(db, WALL)).total, 1);
  check('the owner deleting their own', await inTx(tx => deleteOwnPost(tx, { id: own.postId, userId: WALL })), true);
  check('leaves an empty wall', await listComments(db, WALL), { comments: [], total: 0, pages: 1 });

  /* Paging and the rate window share the posts table with threads. */
  for (let i = 0; i < 25; i++) await inTx(tx => createComment(tx, { profileId: WALL, userId: '100', body: 'c' + i }));
  const p2 = await listComments(db, WALL, 2);
  check('25 comments is two pages', [p2.total, p2.pages, p2.comments.length], [25, 2, 5]);
  check('page two ends on the oldest', p2.comments[4].body, 'c0');
  check('comments count toward the per-minute window', await recentPostCount(db, '100', 1) >= 25, true);
  check('the owner heard about each', (await notifications(WALL)).length, 26);
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[forum-comments] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[forum-comments] ${passed} assertions passed.`);
console.log('');
process.exit(0);
