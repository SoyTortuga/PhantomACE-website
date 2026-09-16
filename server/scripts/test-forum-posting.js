#!/usr/bin/env node
/* ══════════════════════════════════════════════
   FORUM POSTING — test suite

     node server/scripts/test-forum-posting.js

   Two halves. The rules (functions/api/forum/rules.js) are pure and are
   checked case by case: who may start a topic where, who may reply, who
   may touch a post, and where the rate limits bite. Then the write
   queries that step 3 added — getPost, editPost, deleteOwnPost,
   pageOfPost — run against a real Postgres (pglite) with 006 applied.

   The rate limit is the check most likely to be quietly lost in a
   refactor, because nothing visible breaks without it. The test is
   arranged so that removing either limit from rules.js fails the suite:
   see the cases marked LOAD-BEARING and run the mutation by hand
   (comment the check out, run, expect exit 1, put it back).
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import {
  POSTS_PER_MINUTE, THREADS_PER_TEN_MINUTES, isSubscriber, threadRule, replyRule, ownPostRule,
} from '../../functions/api/forum/rules.js';
import {
  createThread, createReply, getThread, listPosts, getPost, editPost, deleteOwnPost, pageOfPost,
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
const sub = { user_id: '200', login: 'sub', subTier: 1, role: 'sub_tier1' };
/* A moderator whose ROLE says moderator but who is NOT a subscriber, and
   whose staffness comes from the moderator list (the `staff` flag), never
   from the role. */
const modNotSub = { user_id: '300', login: 'mod', subTier: 0, role: 'moderator' };
const open = { id: 'general', staffOnly: false, subOnly: false };
const subsOnly = { id: 'highlights', staffOnly: false, subOnly: true };
const staffOnly = { id: 'announcements', staffOnly: true, subOnly: false };

/* ── isSubscriber ────────────────────────────────────────────────────── */
{
  check('a sub is a sub', isSubscriber(sub), true);
  check('a viewer is not', isSubscriber(viewer), false);
  check('a moderator with no subscription is not, whatever the role says', isSubscriber(modNotSub), false);
  check('no session is not', isSubscriber(null), false);
  check('subTier as a string still counts', isSubscriber({ subTier: '2' }), true);
}

/* ── threadRule ──────────────────────────────────────────────────────── */
{
  check('a guest cannot start a topic', status(threadRule({ session: null, staff: false, category: open })), 401);
  check('a viewer can, on an open board', status(threadRule({ session: viewer, staff: false, category: open })), 'ok');
  check('nobody can on a board that does not exist', status(threadRule({ session: viewer, staff: false, category: null })), 404);

  check('a viewer cannot on a subscribers board', status(threadRule({ session: viewer, staff: false, category: subsOnly })), 403);
  check('a sub can', status(threadRule({ session: sub, staff: false, category: subsOnly })), 'ok');
  check('staff can without subscribing', status(threadRule({ session: modNotSub, staff: true, category: subsOnly })), 'ok');
  /* THE ROLE TRAP. role:"moderator" with staff:false is somebody whose
     cookie says moderator and whose moderator-list check said no. */
  check('role:moderator without the staff flag is NOT staff on a subscribers board',
    status(threadRule({ session: modNotSub, staff: false, category: subsOnly })), 403);

  check('a sub cannot on a staff board', status(threadRule({ session: sub, staff: false, category: staffOnly })), 403);
  check('staff can on a staff board', status(threadRule({ session: modNotSub, staff: true, category: staffOnly })), 'ok');
  check('role:moderator without the staff flag is NOT staff on a staff board',
    status(threadRule({ session: modNotSub, staff: false, category: staffOnly })), 403);

  /* LOAD-BEARING: remove the thread limit from rules.js and these fail. */
  check('one recent topic is within the limit',
    status(threadRule({ session: viewer, staff: false, category: open, recentThreads: THREADS_PER_TEN_MINUTES - 1 })), 'ok');
  check('at the thread limit, refused with 429',
    status(threadRule({ session: viewer, staff: false, category: open, recentThreads: THREADS_PER_TEN_MINUTES })), 429);
  check('the thread limit applies to staff too',
    status(threadRule({ session: modNotSub, staff: true, category: open, recentThreads: THREADS_PER_TEN_MINUTES })), 429);
  /* LOAD-BEARING: remove the post limit from threadRule and this fails. */
  check('a topic also counts as a post for the per-minute limit',
    status(threadRule({ session: viewer, staff: false, category: open, recentPosts: POSTS_PER_MINUTE })), 429);
  check('the error carries a message a person can read',
    typeof threadRule({ session: viewer, staff: false, category: open, recentThreads: 99 }).error, 'string');
}

/* ── replyRule ───────────────────────────────────────────────────────── */
{
  const t = { id: '1', locked: false };
  const locked = { id: '2', locked: true };
  check('a guest cannot reply', status(replyRule({ session: null, staff: false, category: open, thread: t })), 401);
  check('a viewer can', status(replyRule({ session: viewer, staff: false, category: open, thread: t })), 'ok');
  check('not to a topic that is gone', status(replyRule({ session: viewer, staff: false, category: open, thread: null })), 404);
  check('not on a subscribers board as a viewer', status(replyRule({ session: viewer, staff: false, category: subsOnly, thread: t })), 403);
  check('a sub can on a subscribers board', status(replyRule({ session: sub, staff: false, category: subsOnly, thread: t })), 'ok');
  check('a locked topic refuses a viewer', status(replyRule({ session: viewer, staff: false, category: open, thread: locked })), 403);
  check('and refuses staff too — a lock is a lock', status(replyRule({ session: modNotSub, staff: true, category: open, thread: locked })), 403);
  /* LOAD-BEARING: remove the post limit from replyRule and these fail. */
  check('under the per-minute limit is fine',
    status(replyRule({ session: viewer, staff: false, category: open, thread: t, recentPosts: POSTS_PER_MINUTE - 1 })), 'ok');
  check('at the per-minute limit, 429',
    status(replyRule({ session: viewer, staff: false, category: open, thread: t, recentPosts: POSTS_PER_MINUTE })), 429);
  check('the limit applies to staff too',
    status(replyRule({ session: modNotSub, staff: true, category: open, thread: t, recentPosts: POSTS_PER_MINUTE })), 429);
}

/* ── ownPostRule ─────────────────────────────────────────────────────── */
{
  const mine = { id: '5', userId: '100', deleted: false, threadLocked: false, threadDeleted: false };
  check('a guest cannot touch a post', status(ownPostRule({ session: null, post: mine })), 401);
  check('the author can', status(ownPostRule({ session: viewer, post: mine })), 'ok');
  check('somebody else cannot', status(ownPostRule({ session: sub, post: mine })), 403);
  check('user ids are compared as strings', status(ownPostRule({ session: { user_id: 100 }, post: mine })), 'ok');
  check('a missing post is 404', status(ownPostRule({ session: viewer, post: null })), 404);
  check('an already-removed post is 410', status(ownPostRule({ session: viewer, post: { ...mine, deleted: true } })), 410);
  check('a post in a locked topic cannot be edited', status(ownPostRule({ session: viewer, post: { ...mine, threadLocked: true } })), 403);
  check('nor one in a deleted topic', status(ownPostRule({ session: viewer, post: { ...mine, threadDeleted: true } })), 404);
  /* Staff have no special power here yet — that is step 4, and until it
     exists the rule must not pretend. */
  check('staff cannot edit somebody else\'s post through this rule',
    status(ownPostRule({ session: modNotSub, staff: true, post: mine })), 403);
}

/* ── The write queries, on a real database ───────────────────────────── */
const db = new PGlite();
await db.exec(SQL);
const inTx = (fn) => db.transaction((tx) => fn(tx));
{
  const { threadId, postId: opId } = await inTx(tx => createThread(tx, { categoryId: 'general', userId: '100', title: 'T', body: 'opening' }));
  const r1 = await inTx(tx => createReply(tx, { threadId, userId: '200', body: 'first reply' }));
  const r2 = await inTx(tx => createReply(tx, { threadId, userId: '100', body: 'second reply' }));

  const op = await getPost(db, opId);
  check('getPost reads the opening post', [op.userId, op.body, op.isOpening, op.deleted, op.threadLocked, op.categoryId],
    ['100', 'opening', true, false, false, 'general']);
  const reply = await getPost(db, r2.postId);
  check('and a reply is not the opening post', reply.isOpening, false);
  check('an unknown post is null', await getPost(db, '9999'), null);

  /* Edit. */
  check('editPost replaces the body', await inTx(tx => editPost(tx, { id: r2.postId, body: 'second reply, fixed' })), true);
  const edited = await getPost(db, r2.postId);
  check('with the new text', edited.body, 'second reply, fixed');
  ok('and an edited_at stamp', edited.editedAt);
  check('the opening post is not stamped by somebody else\'s edit', (await getPost(db, opId)).editedAt, null);

  /* Delete own reply: count goes back. */
  check('reply_count is 2 before', (await getThread(db, threadId)).replyCount, 2);
  check('deleteOwnPost removes a reply', await inTx(tx => deleteOwnPost(tx, { id: r1.postId, userId: '200' })), true);
  check('and the count is 1', (await getThread(db, threadId)).replyCount, 1);
  const gone = await getPost(db, r1.postId);
  check('the row is marked, not gone', [gone.deleted, gone.body], [true, 'first reply']);
  check('the tombstone reads as the author\'s doing', (await listPosts(db, threadId)).posts[1].deleted, 'author');

  check('deleting it again does nothing', await inTx(tx => deleteOwnPost(tx, { id: r1.postId, userId: '200' })), false);
  check('and the count stays 1', (await getThread(db, threadId)).replyCount, 1);
  check('editing a removed post does nothing', await inTx(tx => editPost(tx, { id: r1.postId, body: 'x' })), false);

  /* deleteOwnPost is keyed on the author: the wrong user id is a no-op,
     not a delete. The rule refuses first; this is the second lock. */
  check('the wrong user cannot delete through the query either', await inTx(tx => deleteOwnPost(tx, { id: r2.postId, userId: '999' })), false);
  check('so it is still there', (await getPost(db, r2.postId)).deleted, false);

  /* Delete own opening post: the count does not move. */
  check('deleting the opening post works', await inTx(tx => deleteOwnPost(tx, { id: opId, userId: '100' })), true);
  check('and reply_count is untouched', (await getThread(db, threadId)).replyCount, 1);
  check('the topic still reads', !!(await getThread(db, threadId)), true);

  /* pageOfPost. */
  for (let i = 0; i < 40; i++) await inTx(tx => createReply(tx, { threadId, userId: '100', body: 'r' + i }));
  const { posts, total } = await listPosts(db, threadId, 3);
  check('43 posts is three pages', [total, posts.length], [43, 3]);
  const last = posts[posts.length - 1];
  check('the last post is on page 3', await pageOfPost(db, threadId, last.id), 3);
  check('the opening post is on page 1', await pageOfPost(db, threadId, opId), 1);
  const p2 = (await listPosts(db, threadId, 2)).posts[0];
  check('the 21st post is on page 2', await pageOfPost(db, threadId, p2.id), 2);
  check('a tombstone still occupies its slot on page 1', await pageOfPost(db, threadId, r1.postId), 1);
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[forum-posting] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[forum-posting] ${passed} assertions passed.`);
console.log('');
process.exit(0);
