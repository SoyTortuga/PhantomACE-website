#!/usr/bin/env node
/* ══════════════════════════════════════════════
   NOTIFICATION & HEADER FIXES — client logic

     node scripts/test-notif-fixes.js   (from server/)

   Three bugs in the bell and the header, all in client-only JS that the
   browser modules never export. This loads js/notifications.js into a vm with
   the few globals it touches stubbed, appends test code into the SAME script
   scope (so it can see the module's module-local `let serverNotifs` etc.), and
   checks:

     1. describeServerNotif() now returns a working link for a comment OR a
        mention on a profile wall, anchored to the post — not just threads.
     2. markAllRead() posts the SPECIFIC ids it loaded, so a notification that
        arrives after page load is not marked read unseen.
     3. (static) js/auth.js reads a real badge-meta field, not `imageUrl`.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');

let fail = 0;
function check(name, cond) {
  if (cond) { console.log('ok  -', name); }
  else { console.error('FAIL-', name); fail++; }
}

/* ── bugs 1 & 2: run notifications.js in a stubbed vm ── */
const src = fs.readFileSync(path.join(root, 'js', 'notifications.js'), 'utf8');

const fetchCalls = [];
const store = {};
const ctx = {
  console,
  document: {
    cookie: 'pham_session=x',
    getElementById: () => null,
    createElement: () => ({ textContent: '', innerHTML: '' }),
    addEventListener: () => {},
  },
  localStorage: {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
  },
  fetch: (url, opts) => { fetchCalls.push({ url, opts }); return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }); },
  setTimeout: () => {},
  getSession: () => ({ user_id: '100', login: 'carol' }),
  __out: {},
};
ctx.window = ctx;
vm.createContext(ctx);

const probe = `
  serverAuthors = { '55': { displayName: 'Alice', login: 'alice' }, '77': { displayName: 'Bob', login: 'bob' } };

  // mention in a comment on someone else's wall → resolved owner + anchor
  __out.mentionOther = describeServerNotif({ kind:'mention', actorId:'55', profileId:'77', postId:'900', threadId:null, threadTitle:null });
  // mention on your OWN wall, owner not in authors → me.login fallback + anchor
  __out.mentionMine  = describeServerNotif({ kind:'mention', actorId:'55', profileId:'100', postId:'901', threadId:null, threadTitle:null });
  // comment on your profile → your wall + anchor
  __out.comment      = describeServerNotif({ kind:'comment', actorId:'55', profileId:'100', postId:'902', threadId:null, threadTitle:null });
  // thread reply unchanged
  __out.reply        = describeServerNotif({ kind:'reply',   actorId:'55', threadId:'12', postId:'903', threadTitle:'Hi' });
  // removed post → no link
  __out.deleted      = describeServerNotif({ kind:'mention', actorId:'55', profileId:'100', postId:'904', postDeleted:true });

  // markAllRead posts only the loaded ids
  serverNotifs = [
    { id:'5', kind:'mention', read:false },
    { id:'6', kind:'comment', read:false },
    { id:'7', kind:'reply',   read:true  },
  ];
  serverUnread = 2;
  markAllRead();
`;

vm.runInContext(src + '\n' + probe, ctx);
const o = ctx.__out;

check('mention on another wall links to owner + post anchor', o.mentionOther.href === '/user/bob#post-900');
check('mention on your own wall falls back to your login + anchor', o.mentionMine.href === '/user/carol#post-901');
check('comment on your profile links to your wall + anchor', o.comment.href === '/user/carol#post-902');
check('thread reply still links to the thread', o.reply.href === '/thread/12#post-903');
check('a removed post gets no link', o.deleted.href === null);

const post = fetchCalls.find((c) => c.opts && c.opts.method === 'POST');
check('markAllRead sent a read request', !!post);
const body = post ? JSON.parse(post.opts.body) : {};
check('read request action is "read"', body.action === 'read');
check('read request carries the loaded ids (not a blanket mark-all)',
  Array.isArray(body.ids) && body.ids.length === 2 && body.ids.includes('5') && body.ids.includes('6'));

/* ── bug 3: auth.js reads a real badge-meta field ── */
const auth = fs.readFileSync(path.join(root, 'js', 'auth.js'), 'utf8');
check('auth.js no longer reads the non-existent meta.imageUrl', !/badge\.meta\.imageUrl\b/.test(auth));
check('auth.js reads image || imageUrl2x || imageUrl1x',
  /badge\.meta\.image\b/.test(auth) && /imageUrl2x/.test(auth) && /imageUrl1x/.test(auth));

if (fail) { console.error(`\n${fail} test(s) failed`); process.exit(1); }
console.log('\nAll notification & header fix tests passed.');
