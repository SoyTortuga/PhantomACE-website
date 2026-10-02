#!/usr/bin/env node
/* ══════════════════════════════════════════════
   FORUM SOCIAL — test suite

     node server/scripts/test-forum-social.js   (run from server/: node scripts/test-forum-social.js)

   Runs the social half of functions/api/forum/queries.js against a real
   Postgres (pglite, in-process) with 006_forum.sql AND 009_forum_social.sql
   applied. Mirrors test-forum-queries.js: this is where the behaviour lives,
   so this is where it is checked — search matching and ranking, follow →
   notified on reply, unread then caught up, reaction add/dedupe/remove with
   tallies, a soft-delete → restore round-trip, and the moderation log.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import {
  validateQuery, searchForum,
  createThread, createReply, deleteOwnPost, listPosts, getThread,
  followThread, unfollowThread, isFollowing, followedAmong, listFollowedThreads, notifyFollowers,
  markThreadRead, unreadAmong, unreadFollowCount,
  REACTION_IDS, isReaction, addReaction, removeReaction, reactionsForPosts, reactionsForPost,
  logModAction, listModLog, listDeletedPosts, moderateDeletePost, restorePost,
  listNotifications, unreadCount,
} from '../../functions/api/forum/queries.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SQL006 = fs.readFileSync(path.join(HERE, '../sql/006_forum.sql'), 'utf8');
const SQL009 = fs.readFileSync(path.join(HERE, '../sql/009_forum_social.sql'), 'utf8');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

const db = new PGlite();
await db.exec(SQL006);
await db.exec(SQL009);
/* 009 is idempotent: applying it twice must change nothing. */
let reapply = null;
try { await db.exec(SQL009); } catch (e) { reapply = e.message; }
ok('009_forum_social.sql applies twice', !reapply, reapply);

const inTx = (fn) => db.transaction((tx) => fn(tx));
const kinds = (list) => list.map(n => n.kind).sort();

/* ── Validators ──────────────────────────────────────────────────────── */
{
  ok('a one-char search is refused', validateQuery('a').error);
  check('a search is trimmed', validateQuery('  deck  '), { value: 'deck' });
  ok('a 101-char search is refused', validateQuery('x'.repeat(101)).error);
  check('the twelve reactions', REACTION_IDS.length, 12);
  ok('skull is a reaction', isReaction('skull'));
  ok('a made-up reaction is not', !isReaction('nope'));
  ok('an empty reaction is not', !isReaction(''));
}

/* ── Search ──────────────────────────────────────────────────────────── */
let deckThread, randomThread;
{
  deckThread = await inTx(tx => createThread(tx, { categoryId: 'gaming', userId: 'u1', title: 'My Commander deck list', body: 'Sliver tribal, nothing fancy.' }));
  randomThread = await inTx(tx => createThread(tx, { categoryId: 'general', userId: 'u2', title: 'Hello everyone', body: 'A post that mentions a deck in its body only.' }));
  await inTx(tx => createThread(tx, { categoryId: 'general', userId: 'u3', title: 'Unrelated', body: 'Nothing to see.' }));

  const r = await searchForum(db, 'deck');
  check('two topics match deck', r.total, 2);
  check('the title match ranks first', r.results[0].id, deckThread.threadId);
  check('and is matched in the title', r.results[0].matchedIn, 'title');
  check('the body-only match is second', r.results[1].id, randomThread.threadId);
  check('matched in a post', r.results[1].matchedIn, 'post');
  ok('a body match carries a snippet', typeof r.results[1].snippet === 'string' && r.results[1].snippet.toLowerCase().includes('deck'));
  check('a title match needs no snippet', r.results[0].snippet, null);

  const none = await searchForum(db, 'xyzzy');
  check('a search that matches nothing', [none.total, none.results.length], [0, 0]);

  /* ILIKE specials are literal, not wildcards. */
  await inTx(tx => createThread(tx, { categoryId: 'general', userId: 'u4', title: '100% effort', body: 'b' }));
  const pct = await searchForum(db, '100%');
  check('a percent sign is matched literally', pct.total, 1);
  const under = await searchForum(db, '_');
  check('an underscore matches nothing by itself here', under.total, 0);

  /* A removed topic is not found. */
  await db.query(`UPDATE forum_threads SET deleted_at = now() WHERE id = $1`, [randomThread.threadId]);
  const afterDel = await searchForum(db, 'deck');
  check('a removed topic drops out of search', afterDel.total, 1);
  await db.query(`UPDATE forum_threads SET deleted_at = NULL WHERE id = $1`, [randomThread.threadId]);
}

/* ── Follows and notify-on-reply ─────────────────────────────────────── */
let followThreadId;
{
  const t = await inTx(tx => createThread(tx, { categoryId: 'general', userId: 'starter', title: 'Follow me', body: 'opening' }));
  followThreadId = t.threadId;

  check('nobody follows a fresh topic', await isFollowing(db, followThreadId, 'fan'), false);
  check('follow returns true the first time', await inTx(tx => followThread(tx, { threadId: followThreadId, userId: 'fan' })), true);
  check('and false the second (already following)', await inTx(tx => followThread(tx, { threadId: followThreadId, userId: 'fan' })), false);
  check('now they follow', await isFollowing(db, followThreadId, 'fan'), true);

  /* starter follows their own topic too — must not be double-notified. */
  await inTx(tx => followThread(tx, { threadId: followThreadId, userId: 'starter' }));

  /* A reply by somebody else: starter gets 'reply', fan gets 'follow',
     replier gets nothing, starter is NOT also sent 'follow'. */
  const reply = await inTx(async (tx) => {
    const out = await createReply(tx, { threadId: followThreadId, userId: 'replier', body: 'here is a reply' });
    const n = await notifyFollowers(tx, { threadId: followThreadId, postId: out.postId, actorId: 'replier' });
    return { out, n };
  });
  check('exactly one follower is notified (fan, not starter, not replier)', reply.n, 1);
  check("starter's notifications are one 'reply'", kinds(await listNotifications(db, 'starter')), ['reply']);
  check("fan's notifications are one 'follow'", kinds(await listNotifications(db, 'fan')), ['follow']);
  check('the replier hears nothing', (await listNotifications(db, 'replier')).length, 0);

  /* A follower who replies is not notified about their own reply. */
  await inTx(tx => followThread(tx, { threadId: followThreadId, userId: 'fan2' }));
  const reply2 = await inTx(async (tx) => {
    const out = await createReply(tx, { threadId: followThreadId, userId: 'fan', body: 'fan replies' });
    return notifyFollowers(tx, { threadId: followThreadId, postId: out.postId, actorId: 'fan' });
  });
  check('fan2 is notified of fan\'s reply, fan is not', reply2, 1);

  /* Unfollow stops it. */
  check('unfollow returns true', await inTx(tx => unfollowThread(tx, { threadId: followThreadId, userId: 'fan2' })), true);
  check('unfollowing again is false', await inTx(tx => unfollowThread(tx, { threadId: followThreadId, userId: 'fan2' })), false);

  /* followedAmong over a set. */
  const some = await followedAmong(db, 'fan', [followThreadId, deckThread.threadId]);
  check('followedAmong reports only what is followed', some, [followThreadId]);
  check('followedAmong for a guest is empty', await followedAmong(db, null, [followThreadId]), []);
}

/* ── Unread markers ──────────────────────────────────────────────────── */
{
  /* Board markers (unreadAmong): only a topic you have OPENED and which has
     since moved is marked. A never-opened topic is not. */
  check('a never-opened topic is not marked unread', await unreadAmong(db, 'reader', [followThreadId]), []);
  await markThreadRead(db, { threadId: followThreadId, userId: 'reader' });
  check('just-read, nothing new, not unread', await unreadAmong(db, 'reader', [followThreadId]), []);

  await inTx(async (tx) => {
    const out = await createReply(tx, { threadId: followThreadId, userId: 'someone', body: 'new activity' });
    return notifyFollowers(tx, { threadId: followThreadId, postId: out.postId, actorId: 'someone' });
  });
  check('after a reply it is unread', await unreadAmong(db, 'reader', [followThreadId]), [followThreadId]);
  await markThreadRead(db, { threadId: followThreadId, userId: 'reader' });
  check('reading it again clears the marker', await unreadAmong(db, 'reader', [followThreadId]), []);

  /* Following list (unreadFollowCount): a followed topic you have never
     opened DOES count — you followed it to keep up with it. */
  await inTx(tx => followThread(tx, { threadId: deckThread.threadId, userId: 'reader' }));
  await inTx(tx => followThread(tx, { threadId: followThreadId, userId: 'reader' }));
  const beforeRead = await unreadFollowCount(db, 'reader');
  ok('a followed, never-opened topic counts toward the follow badge', beforeRead >= 1);
  const list = await listFollowedThreads(db, 'reader', 1);
  ok('the followed list carries an unread flag', list.threads.some(t => typeof t.unread === 'boolean'));
  const deckRow = list.threads.find(t => t.id === deckThread.threadId);
  check('the never-opened followed topic is flagged unread', deckRow.unread, true);
  const followRow = list.threads.find(t => t.id === followThreadId);
  check('the just-read followed topic is not', followRow.unread, false);
}

/* ── Reactions ───────────────────────────────────────────────────────── */
let reactPostId;
{
  const { posts } = await listPosts(db, deckThread.threadId, 1);
  reactPostId = posts[0].id;

  check('add returns true', await inTx(tx => addReaction(tx, { postId: reactPostId, userId: 'a', emoji: 'skull' })), true);
  check('adding the same again is a no-op', await inTx(tx => addReaction(tx, { postId: reactPostId, userId: 'a', emoji: 'skull' })), false);
  await inTx(tx => addReaction(tx, { postId: reactPostId, userId: 'b', emoji: 'skull' }));
  await inTx(tx => addReaction(tx, { postId: reactPostId, userId: 'a', emoji: 'flame' }));

  let state = await reactionsForPost(db, reactPostId, 'a');
  check('two skulls, one flame', [state.tallies.skull, state.tallies.flame], [2, 1]);
  check('a sees their own two marks', state.mine.sort(), ['flame', 'skull']);
  state = await reactionsForPost(db, reactPostId, 'b');
  check('b sees only their skull', state.mine, ['skull']);
  state = await reactionsForPost(db, reactPostId, null);
  check('a guest has no marks of their own', state.mine, []);

  check('remove returns true', await inTx(tx => removeReaction(tx, { postId: reactPostId, userId: 'a', emoji: 'skull' })), true);
  check('removing again is false', await inTx(tx => removeReaction(tx, { postId: reactPostId, userId: 'a', emoji: 'skull' })), false);
  state = await reactionsForPost(db, reactPostId, 'a');
  check('one skull left after a removed, flame kept', [state.tallies.skull, state.tallies.flame], [1, 1]);
  check("a's remaining mark is the flame", state.mine, ['flame']);

  /* reactionsForPosts over several at once; a post with none is absent. */
  const otherPost = (await listPosts(db, followThreadId, 1)).posts[0].id;
  const map = await reactionsForPosts(db, [reactPostId, otherPost], 'a');
  ok('the reacted post is in the map', !!map[reactPostId]);
  ok('the un-reacted post is absent', !map[otherPost]);
}

/* ── Soft-delete → restore round-trip ────────────────────────────────── */
{
  /* A reply, removed by a moderator, then restored: it leaves and returns
     to the restore bin and the thread's reply_count moves with it. */
  const before = (await getThread(db, deckThread.threadId)).replyCount;
  const r = await inTx(tx => createReply(tx, { threadId: deckThread.threadId, userId: 'victim', body: 'to be removed' }));
  const withReply = (await getThread(db, deckThread.threadId)).replyCount;
  check('the reply counts', withReply, before + 1);

  await inTx(tx => moderateDeletePost(tx, { id: r.postId, byUserId: 'mod1', reason: 'off topic' }));
  check('removing it gives the count back', (await getThread(db, deckThread.threadId)).replyCount, before);
  let bin = await listDeletedPosts(db, 50);
  const row = bin.find(p => p.id === r.postId);
  ok('the removed post is in the restore bin', !!row);
  check('the bin shows who removed it and why', [row.deletedBy, row.reason], ['mod1', 'off topic']);
  /* The author is told. */
  check("the author gets a 'moderation' notification", kinds(await listNotifications(db, 'victim')), ['moderation']);

  check('restore returns true', await inTx(tx => restorePost(tx, { id: r.postId })), true);
  check('and the count comes back with it', (await getThread(db, deckThread.threadId)).replyCount, before + 1);
  bin = await listDeletedPosts(db, 50);
  ok('a restored post is out of the bin', !bin.some(p => p.id === r.postId));

  /* An author's own delete is not a restore-bin item (only mod removals). */
  const own = await inTx(tx => createReply(tx, { threadId: deckThread.threadId, userId: 'self', body: 'my own post' }));
  await inTx(tx => deleteOwnPost(tx, { id: own.postId, userId: 'self' }));
  bin = await listDeletedPosts(db, 50);
  ok('a self-deleted post is not in the moderator restore bin', !bin.some(p => p.id === own.postId));
}

/* ── Moderation log ──────────────────────────────────────────────────── */
{
  await inTx(tx => logModAction(tx, { actorId: 'mod1', action: 'lock', targetType: 'thread', targetId: deckThread.threadId }));
  await inTx(tx => logModAction(tx, { actorId: 'mod2', action: 'delete-post', targetType: 'post', targetId: reactPostId, detail: 'spam' }));
  const log = await listModLog(db, 50);
  ok('the log has at least the two just written', log.length >= 2);
  check('newest first', log[0].action, 'delete-post');
  check('it records the actor, target and detail', [log[0].actorId, log[0].targetType, log[0].targetId, log[0].detail], ['mod2', 'post', reactPostId, 'spam']);
  const limited = await listModLog(db, 1);
  check('the limit is honoured', limited.length, 1);
}

/* ── Done ────────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[forum-social] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[forum-social] ${passed} assertions passed.`);
console.log('');
process.exit(0);
