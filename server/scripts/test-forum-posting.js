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
  commentRule, editMentionRule,
} from '../../functions/api/forum/rules.js';
import {
  createThread, createReply, getThread, listPosts, getPost, editPost, deleteOwnPost, pageOfPost,
  ForumError, underLimit, postingWindow, recentPostCount, createComment, addMentions, editOwnPost,
  recentMentionEditCount,
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

/* ── editMentionRule ─────────────────────────────────────────────────── */
{
  /* LOAD-BEARING: remove the check from editMentionRule and these fail. */
  check('an edit naming nobody new is free even at the limit',
    status(editMentionRule({ adding: 0, recentPosts: POSTS_PER_MINUTE })), 'ok');
  check('an edit naming somebody new under the limit is fine',
    status(editMentionRule({ adding: 3, recentPosts: POSTS_PER_MINUTE - 1 })), 'ok');
  check('an edit naming somebody new at the limit is 429',
    status(editMentionRule({ adding: 1, recentPosts: POSTS_PER_MINUTE })), 429);
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

/* ── The rate limit is judged INSIDE the transaction ─────────────────────
   The routes used to count the window with one query and write with a
   transaction after it, so a burst of simultaneous requests all counted the
   same window and all got through. They now call underLimit() as the first
   thing in the posting transaction (lock, count, rule), which is what these
   reproduce. pglite is a single connection, so the advisory lock itself is
   not contended here; what IS proved is that the count is taken in the same
   transaction as the write and that a refusal rolls it back. The "old
   shape" case shows the suite can tell the difference. */
{
  const tryAll = (n, fn) => Promise.allSettled(Array.from({ length: n }, (_, i) => fn(i)));
  const fulfilled = (rs) => rs.filter(r => r.status === 'fulfilled').length;
  const refusedWith = (rs, code) => rs.filter(r => r.status === 'rejected' && r.reason instanceof ForumError && r.reason.status === code).length;

  const { threadId } = await inTx(tx => createThread(tx, { categoryId: 'general', userId: 'host', title: 'Burst', body: 'go' }));
  const t = await getThread(db, threadId);
  const burster = { user_id: 'burst1', subTier: 0 };

  /* The old shape: count first, outside, then write. */
  const old = await tryAll(POSTS_PER_MINUTE + 3, async (i) => {
    const recentPosts = await recentPostCount(db, 'burst0', 1);
    const rule = replyRule({ session: { user_id: 'burst0' }, staff: false, category: open, thread: t, recentPosts });
    if (!rule.ok) throw new ForumError('refused', rule.error, rule.status);
    return inTx(tx => createReply(tx, { threadId, userId: 'burst0', body: 'old ' + i }));
  });
  check('the old shape lets a burst past the limit (why it moved)', fulfilled(old) > POSTS_PER_MINUTE, true);

  /* LOAD-BEARING: the new shape. */
  const burst = await tryAll(POSTS_PER_MINUTE + 3, (i) => inTx(async (tx) => {
    await underLimit(tx, 'burst1', w => replyRule({ session: burster, staff: false, category: open, thread: t, recentPosts: w.recentPosts }));
    return createReply(tx, { threadId, userId: 'burst1', body: 'new ' + i });
  }));
  check('a burst of replies: exactly the allowance gets through', fulfilled(burst), POSTS_PER_MINUTE);
  check('and the rest are refused with 429', refusedWith(burst, 429), 3);
  check('nothing refused was written', await recentPostCount(db, 'burst1', 1), POSTS_PER_MINUTE);

  /* Topics: two per ten minutes, under the same lock. */
  const topics = await tryAll(4, (i) => inTx(async (tx) => {
    await underLimit(tx, 'burst2',
      w => threadRule({ session: { user_id: 'burst2' }, staff: false, category: open, recentThreads: w.recentThreads, recentPosts: w.recentPosts }),
      { threads: true });
    return createThread(tx, { categoryId: 'general', userId: 'burst2', title: 'T' + i, body: 'b' });
  }));
  check('a burst of topics: exactly two', fulfilled(topics), THREADS_PER_TEN_MINUTES);
  check('the rest 429', refusedWith(topics, 429), 2);

  /* Profile comments. */
  const owner = { userId: 'wall1' };
  const comments = await tryAll(POSTS_PER_MINUTE + 2, (i) => inTx(async (tx) => {
    await underLimit(tx, 'burst3', w => commentRule({ session: { user_id: 'burst3' }, owner, enabled: true, recentPosts: w.recentPosts }));
    return createComment(tx, { profileId: 'wall1', userId: 'burst3', body: 'c' + i });
  }));
  check('a burst of comments: exactly the allowance', fulfilled(comments), POSTS_PER_MINUTE);

  /* Edits that named somebody new spend from the same window. */
  const { postId } = await inTx(tx => createThread(tx, { categoryId: 'general', userId: 'burst4', title: 'E', body: 'start' }));
  await inTx(tx => createReply(tx, { threadId, userId: 'burst4', body: 'two' }));
  await inTx(tx => createReply(tx, { threadId, userId: 'burst4', body: 'three' }));
  await inTx(tx => editOwnPost(tx, { id: postId, userId: 'burst4', body: 'hi @n1', resolved: [{ login: 'n1', userId: 'n1id' }] }));
  check('a mention-adding edit is counted', await recentMentionEditCount(db, 'burst4', 1), 1);
  check('a post\'s own mentions are not counted as an edit', await (async () => {
    await inTx(async (tx) => {
      const out = await createReply(tx, { threadId, userId: 'burst5', body: '@n1' });
      await addMentions(tx, { postId: out.postId, byUserId: 'burst5', userIds: ['n1id'] });
    });
    return recentMentionEditCount(db, 'burst5', 1);
  })(), 0);
  check('the window adds them up: 3 posts + 1 naming edit', (await inTx(tx => postingWindow(tx, 'burst4'))).recentPosts, 4);
  await inTx(tx => createReply(tx, { threadId, userId: 'burst4', body: 'four' }));
  let refused = null;
  try {
    await inTx(async (tx) => {
      await underLimit(tx, 'burst4', w => replyRule({ session: { user_id: 'burst4' }, staff: false, category: open, thread: t, recentPosts: w.recentPosts }));
      return createReply(tx, { threadId, userId: 'burst4', body: 'five' });
    });
  } catch (err) { refused = err; }
  check('so after 4 posts and a naming edit, the next write is refused', refused && refused.status, 429);
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
