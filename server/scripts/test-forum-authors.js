#!/usr/bin/env node
/* ══════════════════════════════════════════════
   FORUM AUTHORS — identity map + name-effect enrichment

     node server/scripts/test-forum-authors.js

   authorsFor() is the one place every forum surface (threads, thread posts,
   categories, the profile wall, the moderation queue) turns a set of user
   ids into the identities the client draws. Since name effects landed it
   also staples on `nameEffect` — the equipped name-effect variant or null —
   resolved once through the shared cosmetics resolver, so a name can glow in
   chat without a per-name lookup.

   This runs the real authorsFor against a mock KV and asserts: the effect is
   attached and correct, guests and unknown users resolve to null, title and
   badge still come through, the ids are batched, and a broken resolver never
   costs the page its authors.
   ══════════════════════════════════════════════ */

import { authorsFor } from '../../functions/api/forum/authors.js';

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), x = JSON.stringify(expected);
  if (a === x) { passed++; return; }
  failures.push(`${label}\n      expected ${x}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

const store = {
  profile_100: { login: 'wraith', displayName: 'Wraith', avatar: 'a.png' },
  inv_100: { items: [
      { id: 'ne1', type: 'name-effect', rarity: 'mythic', name: 'Name Effect' },
      { id: 'ti1', type: 'title', rarity: 'rare', name: 'The Bold' },
    ], equips: { profile: { 'name-effect': 'ne1', title: 'ti1' } } },

  profile_200: { login: 'sentinel', displayName: 'Sentinel', avatar: '' },
  inv_200: { items: [
      { id: 'ne2', type: 'name-effect', rarity: 'mythic', name: 'Exclusive Name Effect' },
    ], equips: { profile: { 'name-effect': 'ne2' } } },

  profile_300: { login: 'plain', displayName: 'Plain', avatar: '' },
  inv_300: { items: [], equips: { profile: {} } },   // no effect equipped
};
function envFrom(track) {
  return { MARKETPLACE: { async get(key) { if (track) track.push(key); return store[key] || null; } } };
}

/* ── The map carries the equipped variant ───────────────────────────── */
const reads = [];
const authors = await authorsFor(envFrom(reads), ['100', '200', '300', '999', 'guest_z', '100']);

check('100 mythic name effect', authors['100'].nameEffect, 'mythic');
check('200 exclusive (name wins)', authors['200'].nameEffect, 'exclusive');
check('300 nothing equipped → null', authors['300'].nameEffect, null);
check('999 no records → null', authors['999'].nameEffect, null);
check('guest → null', authors['guest_z'].nameEffect, null);

/* ── The rest of the identity is untouched ──────────────────────────── */
check('100 display name intact', authors['100'].displayName, 'Wraith');
check('100 title intact', authors['100'].title && authors['100'].title.name, 'The Bold');
check('999 anonymous fallback', authors['999'].displayName, 'Someone');
ok('every requested id answered', ['100', '200', '300', '999', 'guest_z'].every(id => id in authors));

/* ── Batched: the resolver reads a real inventory once, guests never ──── */
ok('guest inventory never read (resolver skips guests)', !reads.includes('inv_guest_z'));
/* 100 appears twice but is deduped, so its inventory is read at most twice
   overall — once by identity(), once by the resolver — never four times. */
ok('deduped: 100 inventory read at most twice', reads.filter(k => k === 'inv_100').length <= 2);
ok('real user 999 inventory considered by resolver', reads.includes('inv_999'));

/* ── A KV that throws must not reject the whole call ─────────────────── */
const brokenEnv = { MARKETPLACE: { async get() { throw new Error('KV down'); } } };
let rejected = false;
let resilient = {};
try { resilient = await authorsFor(brokenEnv, ['100']); }
catch { rejected = true; }
ok('authorsFor never rejects on KV failure', !rejected);
check('KV failure → anonymous entry', resilient['100'] && resilient['100'].displayName, 'Someone');
check('KV failure → nameEffect null', resilient['100'] && resilient['100'].nameEffect, null);

if (failures.length) {
  console.error(`\n✗ ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`✓ all ${passed} forum-authors checks passed`);
