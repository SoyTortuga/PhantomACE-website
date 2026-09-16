#!/usr/bin/env node
/* ══════════════════════════════════════════════
   MENTIONS AND NOTIFICATIONS — test suite

     node server/scripts/test-forum-mentions.js

   parseMentions against the cases that matter (emails, URLs, legacy
   3-character logins, case, duplicates); resolveMentions against a
   stubbed profile store (missing, stale login, opted out); then the
   queries on a real Postgres (pglite): a mention and its notification in
   one transaction, no self-mention, no double notification, the reply
   notification createReply now writes, the notification list with its
   joins, the unread count, and mark-read scoped to one person.

   LOAD-BEARING: the self-mention skip in addMentions, the opt-out check
   in resolveMentions, and the user scope in markNotificationsRead.
   Removing any of them fails this suite by exit code.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { parseMentions, resolveMentions } from '../../functions/api/forum/mentions.js';
import {
  createThread, createReply, createComment, addMentions, listPosts, listComments,
  listNotifications, unreadCount, markNotificationsRead, moderateDeletePost, authorIds,
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

/* ── parseMentions ───────────────────────────────────────────────────── */
{
  check('a plain mention', parseMentions('hey @PhantomACE, nice pull'), ['phantomace']);
  check('lowercased and de-duplicated', parseMentions('@Samii @samii @SAMII'), ['samii']);
  check('an email is not a mention', parseMentions('mail me at foo@example.com'), []);
  check('a URL handle is not a mention', parseMentions('see https://x.tv/@handle'), []);
  check('two characters is too short', parseMentions('@ab no'), []);
  check('three characters is a legacy login', parseMentions('@bob yes'), ['bob']);
  check('twenty-six characters is too long', parseMentions('@' + 'a'.repeat(26)), []);
  check('in parentheses', parseMentions('(@samii) agreed'), ['samii']);
  check('underscores and digits', parseMentions('@user_name_1 and @other'), ['user_name_1', 'other']);
  check('across lines', parseMentions('@one\n@two'), ['one', 'two']);
  check('at most twenty', parseMentions(Array.from({ length: 30 }, (_, i) => '@name' + i).join(' ')).length, 20);
  check('nothing from nothing', parseMentions(''), []);
  check('nothing from null', parseMentions(null), []);
}

/* ── resolveMentions against a stub store ────────────────────────────── */
{
  const store = {
    'loginidx_phantomace': '77379157',
    'profile_77379157': { login: 'PhantomACE', displayName: 'PhantomACE' },
    'loginidx_samii': '200',
    'profile_200': { login: 'samii', displayName: 'Samii', mentionsEnabled: false },
    'loginidx_oldname': '300',
    'profile_300': { login: 'newname', displayName: 'Renamed' },   // index points at somebody who moved on
    'loginidx_ghost': '400',                                        // index with no record
  };
  const env = { MARKETPLACE: { get: async (k, t) => (t === 'json' ? (store[k] ?? null) : (store[k] == null ? null : String(store[k]))) } };

  check('a known login resolves', await resolveMentions(env, ['phantomace']), [{ login: 'phantomace', userId: '77379157' }]);
  check('case on the record does not matter', (await resolveMentions(env, ['phantomace']))[0].userId, '77379157');
  check('an unknown login resolves to nobody', await resolveMentions(env, ['nobody']), []);
  /* LOAD-BEARING */
  check('somebody who opted out resolves to nobody', await resolveMentions(env, ['samii']), []);
  check('a stale index entry resolves to nobody', await resolveMentions(env, ['oldname']), []);
  check('an index with no record resolves to nobody', await resolveMentions(env, ['ghost']), []);
  check('order is kept and the unresolved are simply absent',
    await resolveMentions(env, ['nobody', 'phantomace', 'samii']), [{ login: 'phantomace', userId: '77379157' }]);
  const broken = { MARKETPLACE: { get: async () => { throw new Error('store down'); } } };
  check('a failing store resolves to nobody rather than failing the post', await resolveMentions(broken, ['phantomace']), []);
}

/* ── Queries ─────────────────────────────────────────────────────────── */
const db = new PGlite();
await db.exec(SQL);
const inTx = (fn) => db.transaction((tx) => fn(tx));
const notifs = async (userId) => (await listNotifications(db, userId)).map(n => [n.kind, n.postId, n.actorId, n.read]);

{
  const { threadId, postId: opId } = await inTx(tx => createThread(tx, { categoryId: 'general', userId: '100', title: 'Topic', body: 'hi @two and @two again, and me @one' }));
  /* The route resolves logins to ids before the transaction; here the
     ids are given directly. '100' is the author. */
  const added = await inTx(tx => addMentions(tx, { postId: opId, byUserId: '100', userIds: ['200', '200', '100'] }));
  check('one mention recorded: the duplicate and the self-mention are not', added, 1);
  check('and one notification, for the person named', await notifs('200'), [['mention', opId, '100', false]]);
  /* LOAD-BEARING */
  check('the author is not told they mentioned themselves', await notifs('100'), []);
  check('naming them again on the same post is a no-op', await inTx(tx => addMentions(tx, { postId: opId, byUserId: '100', userIds: ['200'] })), 0);
  check('so still one notification', (await notifs('200')).length, 1);
  check('the post carries who it named', (await listPosts(db, threadId)).posts[0].mentions, ['200']);
  check('authorIds includes the mentioned, for the client to link them', authorIds((await listPosts(db, threadId)).posts).sort(), ['100', '200']);

  /* A reply tells the topic's author. */
  const r = await inTx(tx => createReply(tx, { threadId, userId: '200', body: 'a reply' }));
  check('the topic author is told about a reply', await notifs('100'), [['reply', r.postId, '200', false]]);
  const own = await inTx(tx => createReply(tx, { threadId, userId: '100', body: 'my own reply' }));
  check('but not about their own reply', (await notifs('100')).length, 1);
  check('a reply with no mentions carries none', (await listPosts(db, threadId)).posts[1].mentions, []);

  /* A comment with a mention: the owner hears once (comment), the named
     person hears once (mention). */
  const c = await inTx(async (tx) => {
    const out = await createComment(tx, { profileId: '300', userId: '200', body: 'hey @one' });
    await addMentions(tx, { postId: out.postId, byUserId: '200', userIds: ['100'] });
    return out;
  });
  check('the wall owner hears a comment', await notifs('300'), [['comment', c.postId, '200', false]]);
  check('the named person hears a mention', (await notifs('100'))[0], ['mention', c.postId, '200', false]);
  check('a comment carries its mentions', (await listComments(db, '300')).comments[0].mentions, ['100']);

  /* The list: newest first, with what the client needs to say it. */
  const list = await listNotifications(db, '100');
  check('newest first', list.map(n => n.kind), ['mention', 'reply']);
  check('a reply names its topic', [list[1].threadId, list[1].threadTitle, list[1].excerpt], [threadId, 'Topic', 'a reply']);
  check('a comment mention names the profile, not a topic', [list[0].profileId, list[0].threadId], ['300', null]);
  check('unread count', await unreadCount(db, '100'), 2);

  /* Mark read: some, then all — and only mine. */
  check('marking one', await inTx(tx => markNotificationsRead(tx, '100', [list[1].id])), 1);
  check('leaves one unread', await unreadCount(db, '100'), 1);
  check('and it reads as read', (await listNotifications(db, '100'))[1].read, true);
  /* LOAD-BEARING */
  check('somebody else cannot mark mine by id', await inTx(tx => markNotificationsRead(tx, '200', [list[0].id])), 0);
  check('so it is still unread', await unreadCount(db, '100'), 1);
  check('marking all', await inTx(tx => markNotificationsRead(tx, '100')), 1);
  check('leaves none', await unreadCount(db, '100'), 0);
  check('marking all again marks nothing', await inTx(tx => markNotificationsRead(tx, '100')), 0);
  check('bad ids mark nothing', await inTx(tx => markNotificationsRead(tx, '200', ['999999'])), 0);

  /* A removal shows its reason; a removed post's notification stays but
     says so. */
  await inTx(tx => moderateDeletePost(tx, { id: r.postId, byUserId: '900', reason: 'off topic' }));
  const after = await listNotifications(db, '200');
  const mod = after.find(n => n.kind === 'moderation');
  check('the author of a removed post is told, with the reason', [mod.postId, mod.reason], [r.postId, 'off topic']);
  const stale = (await listNotifications(db, '100')).find(n => n.postId === r.postId);
  check('the reply notification for the removed post still lists, flagged', [stale.kind, stale.postDeleted], ['reply', true]);
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[forum-mentions] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[forum-mentions] ${passed} assertions passed.`);
console.log('');
process.exit(0);
