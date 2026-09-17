#!/usr/bin/env node
/* ══════════════════════════════════════════════
   CHECK-IN BADGE BACKFILL — test suite

     node server/scripts/test-grant-checkin-badge.js

   This script hands out something that cannot be taken back, on a live
   broadcast, against real inventories. The two ways it could go wrong are
   equally bad and equally invisible from the output: granting a badge to
   somebody who did not earn it, and quietly missing somebody who did.

   The rule it has to hold: each person is judged AT THEIR CHECK-IN TIME,
   not at the moment the script runs. That is the same answer the live
   handler would have given had it been deployed, which is the whole point
   of a backfill — it repairs a deploy gap, it does not invent a new way to
   earn the badge.

   No database: the KV shim is faked in memory.
   ══════════════════════════════════════════════ */

import { planBackfill, applyBackfill } from './grant-checkin-badge.js';
import { CHECKIN_BADGES } from '../../functions/api/checkin-badges.js';

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

const AGATE = CHECKIN_BADGES.find(b => b.id === 'agate-hunt');
const HOUR = 3600000;

function makeEnv(seed = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
  const chains = new Map();
  return {
    MARKETPLACE: {
      async get(k, t) { if (!store.has(k)) return null; const r = store.get(k); return t === 'json' ? JSON.parse(r) : r; },
      async put(k, v) { store.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
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

const badges = (env, userId) => {
  const raw = env._store.get('inv_' + userId);
  return raw ? JSON.parse(raw).items.map(i => i.id) : [];
};

/* ── Who is owed what ────────────────────────────────────────────────── */
{
  const checkins = [
    { userId: 'early', displayName: 'early', at: AGATE.from - HOUR },   // before the window
    { userId: 'inside', displayName: 'inside', at: AGATE.from + HOUR }, // during
    { userId: 'late', displayName: 'late', at: AGATE.to + HOUR },       // after it shut
  ];
  const env = makeEnv();
  const plan = await planBackfill(env, checkins);

  check('everyone is accounted for', plan.length, 3);
  check('somebody who checked in before the window gets nothing',
    plan[0].skip, 'checked in before the window opened');
  check('somebody inside it is owed the badge',
    plan[1].grant.map(b => b.id), ['agate-hunt']);
  /* THE ONE THAT MATTERS. Judged at the check-in time, not at now — a
     backfill run after the window shuts must still pay the people who were
     inside it, and must still refuse the people who were not. */
  check('somebody who checked in after it shut gets nothing',
    plan[2].skip, 'checked in after it closed');
}

/* ── Already holding it ──────────────────────────────────────────────── */
{
  /* Granted live before the script ran, or claimed with a minted code. */
  const env = makeEnv({
    inv_has: { userId: 'has', items: [{ id: 'agate-hunt', type: 'badge', source: 'item-code' }], equips: {} },
  });
  const plan = await planBackfill(env, [{ userId: 'has', displayName: 'has', at: AGATE.from + HOUR }]);
  check('somebody who already holds it is skipped', plan[0].skip, 'already holds it');
}

/* ── Applying it ─────────────────────────────────────────────────────── */
{
  const checkins = [
    { userId: 'a', displayName: 'a', at: AGATE.from + HOUR },
    { userId: 'b', displayName: 'b', at: AGATE.from + 2 * HOUR },
    { userId: 'c', displayName: 'c', at: AGATE.from - HOUR },
  ];
  const env = makeEnv();
  const plan = await planBackfill(env, checkins);
  const granted = await applyBackfill(env, plan.filter(p => p.grant));

  check('two badges are written', granted, 2);
  check('the first of them lands', badges(env, 'a'), ['agate-hunt']);
  check('and the second', badges(env, 'b'), ['agate-hunt']);
  check('and nobody outside the window is touched', env._store.has('inv_c'), false);

  /* STAMPED WITH WHEN IT WAS EARNED, not when it was repaired. Grant order
     is the only record of who was first, and anything that ever numbers
     these copies reads it. A backfill that stamped `now` would file
     everyone it repaired behind every live grant that beat it. */
  const a = JSON.parse(env._store.get('inv_a')).items[0];
  const b = JSON.parse(env._store.get('inv_b')).items[0];
  check('the badge carries the check-in time', a.grantedAt, AGATE.from + HOUR);
  check('so arrival order survives the repair', a.grantedAt < b.grantedAt, true);

  check('and it is the exclusive rarity', a.rarity, 'exclusive');
  check('with its artwork', a.meta && a.meta.image, '/assets/badges/agate-hunt.png');
}

/* ── Safe to run twice ───────────────────────────────────────────────── */
{
  /* It will be. The first run is a dry run, the second is --confirm, and a
     nervous operator runs it a third time to check. */
  const checkins = [{ userId: 'a', displayName: 'a', at: AGATE.from + HOUR }];
  const env = makeEnv();

  const first = await applyBackfill(env, (await planBackfill(env, checkins)).filter(p => p.grant));
  check('the first run grants it', first, 1);

  const secondPlan = await planBackfill(env, checkins);
  check('the second run sees nothing to do', secondPlan[0].skip, 'already holds it');
  const second = await applyBackfill(env, secondPlan.filter(p => p.grant));
  check('and writes nothing', second, 0);
  check('leaving one badge', badges(env, 'a'), ['agate-hunt']);
}

/* ── An inventory that already has other things ──────────────────────── */
{
  const env = makeEnv({
    inv_a: { userId: 'a', items: [{ id: 'dino-park-beta', type: 'badge' }], equips: { profile: { badge: 'dino-park-beta' } } },
  });
  const plan = await planBackfill(env, [{ userId: 'a', displayName: 'a', at: AGATE.from + HOUR }]);
  await applyBackfill(env, plan.filter(p => p.grant));

  const inv = JSON.parse(env._store.get('inv_a'));
  check('the new badge is added, not substituted', inv.items.map(i => i.id), ['dino-park-beta', 'agate-hunt']);
  /* What somebody is wearing is not the backfill's business. */
  check('and what they are wearing is untouched', inv.equips.profile.badge, 'dino-park-beta');
}

/* ── A check-in with no timestamp ────────────────────────────────────── */
{
  /* Every row channel-points.js writes has one, but this reads a stored
     document and a missing field must not become NaN — which compares
     false against everything and would silently skip the person. */
  const env = makeEnv();
  const plan = await planBackfill(env, [{ userId: 'x', displayName: 'x' }]);
  ok('a check-in with no time is still decided, not dropped', plan.length === 1);
  ok('and is judged against now', plan[0].skip !== undefined || plan[0].grant !== undefined);
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[grant-checkin-badge] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[grant-checkin-badge] ${passed} assertions passed.`);
console.log('');
