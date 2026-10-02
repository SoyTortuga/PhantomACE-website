#!/usr/bin/env node
/* ══════════════════════════════════════════════
   THE SEASONAL GRIMOIRE — test suite

     node server/scripts/test-grimoire.js   (from server/: node scripts/test-grimoire.js)

   test-season-manifest.js proves the SET is sound — setForMonth / ownsSetItem /
   collectionForMonth over the reward tables. None of that exercises the ROUTE,
   which is where the two decisions that matter live:

     - a complete set on your OWN profile grants the grimoire-<mk> badge, once,
       and a second view is a no-op (not a second badge)
     - that grant NEVER fires for anyone but the owner, and never without a
       session at all — a logged-out visitor still sees owned/missing

   It drives onRequestGet with a fake KV standing in for MARKETPLACE, the way
   test-profile.js and test-phamily-time-claims.js drive their handlers.

   The month is pinned to 2026-10 (themed, always in seasonMonths because it is
   in THEMED_MONTHS and ROOM_DRIP_MONTHS), so nothing here depends on today.
   ══════════════════════════════════════════════ */

import { onRequestGet as grimoireGet } from '../../functions/api/grimoire.js';
import { setForMonth, setBadgeId } from '../../functions/api/season-manifest.js';

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

const MK = '2026-10';
const SET = setForMonth(MK);
const BADGE_ID = setBadgeId(MK);

/* The full set as an inventory would hold it — the exact id + stored type each
   entry is granted under. A partial inventory is this minus its first item. */
const fullItems = () => SET.map(e => ({ id: e.itemId, type: e.storedType, name: e.name }));

function makeEnv(seed = {}) {
  const store = new Map();
  /* Mirror real KV: a string value (loginidx_) is stored raw, so a plain get()
     returns it verbatim; an object is stored as JSON for get(k,'json'). */
  for (const [k, v] of Object.entries(seed)) {
    store.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  }
  const chains = new Map();
  return {
    MARKETPLACE: {
      async get(k, t) { if (!store.has(k)) return null; const r = store.get(k); return t === 'json' ? JSON.parse(r) : r; },
      async put(k, v) { store.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
      /* Per-key serialised, like the real advisory-locked mutate(). */
      async mutate(k, fn) {
        const prev = chains.get(k) || Promise.resolve();
        const run = prev.then(async () => {
          const cur = store.has(k) ? JSON.parse(store.get(k)) : null;
          const next = await fn(cur);
          if (next === undefined) return cur;
          store.set(k, JSON.stringify(next));
          return JSON.parse(store.get(k));
        });
        chains.set(k, run.then(() => {}, () => {}));
        return run;
      },
    },
    _store: store,
  };
}

/* A GET as a given viewer (or logged out). */
function req(query, sessionUserId) {
  const headers = {};
  if (sessionUserId) {
    const cookie = 'pham_session=' + encodeURIComponent(JSON.stringify({ user_id: sessionUserId }));
    headers.Cookie = cookie;
  }
  return new Request('http://localhost/api/grimoire?' + query, { headers });
}

function monthOf(body, mk = MK) { return (body.months || []).find(m => m.month === mk); }
function invBadges(env, userId) {
  const inv = JSON.parse(env._store.get(`inv_${userId}`));
  return inv.items.filter(i => i.id === BADGE_ID && i.type === 'badge');
}

async function main() {
  ok('the month has a non-empty set to test against', SET.length > 0);

  /* ── full inventory, own profile: complete + badge granted once ── */
  {
    const env = makeEnv({
      profile_100: { login: 'ghoul', displayName: 'Ghoul' },
      inv_100: { userId: '100', items: fullItems(), equips: {} },
    });

    const res = await grimoireGet({ env, request: req('id=100', '100') });
    check('owner full view responds 200', res.status, 200);
    const body = await res.json();
    ok('response is the owner', body.isOwner === true);

    const m = monthOf(body);
    ok('the themed month is present', !!m);
    check('owned == total', m.ownedCount, m.total);
    check('nothing missing', m.missingCount, 0);
    ok('the month reads complete', m.complete === true);
    ok('the set badge reads earned', m.badgeEarned === true);
    check('the set badge id', m.badge.id, BADGE_ID);

    check('the grimoire badge was granted exactly once', invBadges(env, '100').length, 1);

    /* Second view: idempotent — still exactly one badge, still earned. */
    const res2 = await grimoireGet({ env, request: req('id=100', '100') });
    const body2 = await res2.json();
    check('a second view does not grant a second badge', invBadges(env, '100').length, 1);
    ok('still earned on the second view', monthOf(body2).badgeEarned === true);
  }

  /* ── partial inventory: right missing count, no badge ── */
  {
    const env = makeEnv({
      profile_101: { login: 'wisp', displayName: 'Wisp' },
      inv_101: { userId: '101', items: fullItems().slice(1), equips: {} },
    });
    const missingEntry = SET[0];

    const res = await grimoireGet({ env, request: req('id=101', '101') });
    const body = await res.json();
    const m = monthOf(body);

    check('exactly one item missing', m.missingCount, 1);
    check('owned + missing == total', m.ownedCount + m.missingCount, m.total);
    ok('not complete', m.complete === false);
    ok('no badge earned on a partial set', m.badgeEarned === false);
    check('the missing item is the one withheld', m.missing[0].itemId, missingEntry.itemId);
    ok('the missing item carries a name', typeof m.missing[0].name === 'string' && !!m.missing[0].name);
    ok('the missing item carries a type', !!m.missing[0].type);
    check('no grimoire badge was granted', invBadges(env, '101').length, 0);
  }

  /* ── viewing someone ELSE's complete profile never grants ── */
  {
    const env = makeEnv({
      profile_200: { login: 'owner', displayName: 'Owner' },
      inv_200: { userId: '200', items: fullItems(), equips: {} },
    });

    /* Viewer 999 looks at 200's complete grimoire. */
    const res = await grimoireGet({ env, request: req('id=200', '999') });
    const body = await res.json();
    const m = monthOf(body);

    ok('the viewer is not the owner', body.isOwner === false);
    ok('the set still reads complete for the viewer', m.complete === true);
    ok('but the badge is NOT reported as earned (owner never got it)', m.badgeEarned === false);
    check('and no badge was granted to the owner by a stranger’s view', invBadges(env, '200').length, 0);
  }

  /* ── logged-out view still returns owned/missing ── */
  {
    const env = makeEnv({
      profile_300: { login: 'anon', displayName: 'Anon' },
      inv_300: { userId: '300', items: fullItems().slice(2), equips: {} },
    });

    const res = await grimoireGet({ env, request: req('id=300') });   // no session
    check('logged-out view responds 200', res.status, 200);
    const body = await res.json();
    ok('logged-out view is not owner', body.isOwner === false);

    const m = monthOf(body);
    ok('owned list is present', Array.isArray(m.owned));
    ok('missing list is present', Array.isArray(m.missing));
    check('owned + missing == total for a logged-out view', m.ownedCount + m.missingCount, m.total);
    check('two items missing (two withheld)', m.missingCount, 2);
    check('nothing granted without a session', invBadges(env, '300').length, 0);
  }

  /* ── resolve by login, and the stale-login guard ── */
  {
    const env = makeEnv({
      loginidx_mystic: '400',
      profile_400: { login: 'mystic', displayName: 'Mystic' },
      inv_400: { userId: '400', items: [], equips: {} },
    });
    const res = await grimoireGet({ env, request: req('u=mystic') });
    check('resolves by login', res.status, 200);
    const body = await res.json();
    check('right person', body.userId, '400');

    /* A login pointer that lands on a record carrying a different login is
       stale — nobody is there. */
    const env2 = makeEnv({
      loginidx_old: '400',
      profile_400: { login: 'mystic', displayName: 'Mystic' },
    });
    const res2 = await grimoireGet({ env: env2, request: req('u=old') });
    check('a stale login pointer is 404', res2.status, 404);
  }

  /* ── unknown profile ── */
  {
    const env = makeEnv({});
    const res = await grimoireGet({ env, request: req('id=55555') });
    check('unknown profile is 404', res.status, 404);
  }

  if (failures.length) {
    console.error(`\n[grimoire] ${failures.length} FAILED:\n  - ` + failures.join('\n  - '));
    process.exit(1);
  }
  console.log(`[grimoire] ${passed} assertions passed — ${SET.length} items in ${MK}'s set.`);
}

main();
