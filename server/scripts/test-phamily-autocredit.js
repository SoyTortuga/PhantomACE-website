#!/usr/bin/env node
/* ══════════════════════════════════════════════
   PHAMILY TIME AUTO-CREDIT + STREAK BONUSES — test suite

     node server/scripts/test-phamily-autocredit.js

   Two behaviours that have to be exactly-once, and were easy to get wrong:

   PART A — giveaway-entry rewards are "added automatically". The reward copy
   has always said so, but entries used to be granted only when the viewer
   CLAIMED the reward. Now the watch heartbeat credits every giveaway level the
   viewer has reached and not yet been credited for, tracked by a per-month
   ratchet (giveawayCredited) so a second heartbeat at the same level pays
   nothing. A manual claim of a giveaway reward is a no-op, and a viewer who
   CLAIMED giveaway rewards under the old model (before this shipped) must not
   be re-credited — giveawayCredited is seeded from those claims on first touch.
   Non-giveaway rewards still require a manual claim.

   PART B — stream check-in streaks pay a bonus at 3/5/10 (…/20/50) consecutive
   streams. The payout is once per tier PER RUN: staying on a streak never
   re-pays, but a streak that breaks and climbs back re-earns the tiers.

   Fake KV stands in for MARKETPLACE exactly as test-phamily-time-claims.js
   does — per-key serialised mutate(), unlocked get/put — so the real
   read-modify-write ordering is exercised.
   ══════════════════════════════════════════════ */

/* ── A clock the tests control: noon Pacific on Oct 3rd, same as the claims
   suite, so monthKey() is '2026-10'. ────────────────────────────────────── */
const RealDate = Date;
let FAKE_NOW = RealDate.parse('2026-10-03T19:00:00Z');
globalThis.Date = class extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(FAKE_NOW); }
  static now() { return FAKE_NOW; }
};

import * as phamilyTime from '../../functions/api/phamily-time.js';
import { ledgerKey } from '../../functions/api/giveaway-entries.js';
import { monthKey } from '../../functions/api/season-time.js';
import { recordStream, recordCheckin, getCheckinStats, STREAK_TIERS } from '../../functions/api/checkin-rewards.js';

const MK = monthKey();

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

function makeEnv() {
  const store = new Map();
  const chains = new Map();
  return {
    MARKETPLACE: {
      async get(k, t) { if (!store.has(k)) return null; const r = store.get(k); return t === 'json' ? JSON.parse(r) : r; },
      async put(k, v) { store.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
      async delete(k) { store.delete(k); },
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
      async listValues() { return []; },
    },
    _store: store,
  };
}

/* A heartbeat needs a live answer; a fresh cache row with no client id keeps it
   off the network (getStreamInfo returns offline rather than fetching). We seed
   it LIVE so the beat is a realistic "counting" one. */
function seedLive(env) {
  env._store.set('twitch_live_cache', JSON.stringify({ live: true, checkedAt: FAKE_NOW }));
}

function seedUser(env, userId, { level = 0, claimedRewards, claimedMilestones = [], giveawayCredited, month = MK, lastHeartbeat = 0 } = {}) {
  const row = {
    userId, month, hours: level, level,
    claimedRewards: claimedRewards || [], claimedMilestones,
    attendance: {}, lastHeartbeat,
  };
  /* Deliberately only present when the test asks for it: a row that predates
     the feature has no giveawayCredited field, which is what exercises the
     seed-on-first-touch migration. */
  if (giveawayCredited !== undefined) row.giveawayCredited = giveawayCredited;
  env._store.set(`pt_${userId}_${month}`, JSON.stringify(row));
}
const userData = (env, userId, month = MK) => {
  const raw = env._store.get(`pt_${userId}_${month}`);
  return raw ? JSON.parse(raw) : null;
};
const ledgerEntries = (env, userId) => {
  const raw = env._store.get(ledgerKey(userId, MK));
  return raw ? JSON.parse(raw).entries : 0;
};
const inventory = (env, userId) => {
  const raw = env._store.get(`inv_${userId}`);
  return raw ? JSON.parse(raw) : { items: [] };
};

const USERS = {
  sub: { user_id: '501', display_name: 'Subby', role: 'sub_tier1', subTier: 1 },
  viewer: { user_id: '202', display_name: 'Viewer', role: 'follower', subTier: 0 },
};
const cookie = (who) => `pham_session=${encodeURIComponent(JSON.stringify(USERS[who]))}`;

async function post(env, who, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (who) headers.Cookie = cookie(who);
  const res = await phamilyTime.onRequestPost({
    env, request: new Request('https://t.local/api/phamily-time', { method: 'POST', headers, body: JSON.stringify(body) }),
  });
  return { status: res.status, data: await res.json() };
}

check('the test clock is in October', MK, '2026-10');

/* ══ A1 — reaching a giveaway level auto-credits exactly once ══════════════
   Follower giveaway level 2 is a 'common', worth 2 entries. One heartbeat at
   level 2 credits it; a second at the same level credits nothing more. */
{
  const env = makeEnv();
  seedLive(env);
  seedUser(env, USERS.viewer.user_id, { level: 2 });

  const hb1 = await post(env, 'viewer', { action: 'heartbeat' });
  check('the heartbeat answers 200', hb1.status, 200);
  check('the level-2 follower giveaway reward is credited (2 entries)', ledgerEntries(env, USERS.viewer.user_id), 2);
  check('and recorded on the ratchet', userData(env, USERS.viewer.user_id).giveawayCredited, ['2_follower_giveaway_common']);

  const hb2 = await post(env, 'viewer', { action: 'heartbeat' });
  check('a second heartbeat at the same level does NOT re-credit', ledgerEntries(env, USERS.viewer.user_id), 2);
  check('and the ratchet is unchanged', userData(env, USERS.viewer.user_id).giveawayCredited, ['2_follower_giveaway_common']);
}

/* ══ A2 — one heartbeat settles up every reached level at once ════════════ */
{
  const env = makeEnv();
  seedLive(env);
  seedUser(env, USERS.viewer.user_id, { level: 8 });

  await post(env, 'viewer', { action: 'heartbeat' });
  /* Follower giveaway at 2, 5, 8 are all 'common' = 2 entries each. */
  check('reaching level 8 credits the 2/5/8 giveaway rewards (6 entries)', ledgerEntries(env, USERS.viewer.user_id), 6);
  check('and all three keys are on the ratchet',
    userData(env, USERS.viewer.user_id).giveawayCredited.slice().sort(),
    ['2_follower_giveaway_common', '5_follower_giveaway_common', '8_follower_giveaway_common']);
  /* A non-sub never earns the phamily track. */
  check('no phamily-track giveaway key leaked onto a non-sub',
    userData(env, USERS.viewer.user_id).giveawayCredited.some(k => k.includes('_phamily_')), false);
}

/* ══ A3 — a subscriber is credited on BOTH tracks, at each track's rarity ══
   Follower L2 is common (2), phamily L2 is uncommon (5): 7 together. */
{
  const env = makeEnv();
  seedLive(env);
  seedUser(env, USERS.sub.user_id, { level: 2 });

  await post(env, 'sub', { action: 'heartbeat' });
  check('a sub is credited on both tracks (2 + 5 = 7 entries)', ledgerEntries(env, USERS.sub.user_id), 7);
  check('both track keys are on the ratchet',
    userData(env, USERS.sub.user_id).giveawayCredited.slice().sort(),
    ['2_follower_giveaway_common', '2_phamily_giveaway_uncommon']);
}

/* ══ B — a manual claim of a giveaway reward does NOT add a second credit ══ */
{
  const env = makeEnv();
  seedLive(env);
  seedUser(env, USERS.viewer.user_id, { level: 2 });

  await post(env, 'viewer', { action: 'heartbeat' });
  check('auto-credited once by the heartbeat', ledgerEntries(env, USERS.viewer.user_id), 2);

  const claim = await post(env, 'viewer', { action: 'claim-reward', rewardKey: '2_follower_giveaway_common' });
  check('a manual claim of a giveaway reward still answers 200', claim.status, 200);
  ok('and says it was auto-credited', claim.data.autoCredited === true);
  check('but adds NOTHING to the ledger', ledgerEntries(env, USERS.viewer.user_id), 2);
  check('and records nothing in claimedRewards', userData(env, USERS.viewer.user_id).claimedRewards, []);

  /* claim-all must not touch giveaway rewards either. */
  await post(env, 'viewer', { action: 'claim-all' });
  check('claim-all does not re-credit the giveaway reward', ledgerEntries(env, USERS.viewer.user_id), 2);
}

/* ══ C — a user who CLAIMED giveaway rewards before this shipped is NOT
   re-credited: the ratchet is seeded from those claims on first touch ══════ */
{
  const env = makeEnv();
  seedLive(env);
  /* A pre-feature row: giveaway keys sitting in claimedRewards, no
     giveawayCredited field, and no ledger yet. */
  seedUser(env, USERS.viewer.user_id, {
    level: 8,
    claimedRewards: ['2_follower_giveaway_common', '5_follower_giveaway_common', '8_follower_giveaway_common'],
  });

  await post(env, 'viewer', { action: 'heartbeat' });
  check('an already-claimed giveaway reward is NOT credited again', ledgerEntries(env, USERS.viewer.user_id), 0);
  check('the ratchet is seeded from the prior claims',
    userData(env, USERS.viewer.user_id).giveawayCredited.slice().sort(),
    ['2_follower_giveaway_common', '5_follower_giveaway_common', '8_follower_giveaway_common']);
}

/* ══ D — non-giveaway rewards still require a manual claim ════════════════ */
{
  const env = makeEnv();
  seedLive(env);
  seedUser(env, USERS.viewer.user_id, { level: 10 });

  await post(env, 'viewer', { action: 'heartbeat' });
  check('the heartbeat granted no inventory items (giveaway only)', inventory(env, USERS.viewer.user_id).items.length, 0);
  /* Giveaway entries were still credited: follower 2/5/8 = 6. */
  check('while still crediting the giveaway entries', ledgerEntries(env, USERS.viewer.user_id), 6);

  const claim = await post(env, 'viewer', { action: 'claim-reward', rewardKey: '10_follower_cardback_common' });
  check('the cardback still has to be claimed', claim.status, 200);
  check('and only then lands in the inventory',
    inventory(env, USERS.viewer.user_id).items.filter(i => i.type === 'cardback').length, 1);
}

/* ══ E — STREAK BONUSES: pay once at 3/5/10 per run; a reset streak re-earns ══
   Driven straight through recordCheckin with a stream log, like
   test-checkin-stream-fallback.js. Arrival position 9 is past the early-bird
   window (5), so the only entries written are the streak tiers. */
{
  const env = makeEnv();
  const uid = 'streaker';

  const T = Object.fromEntries(STREAK_TIERS.map(t => [t.streams, t.entries]));
  const checkInTo = async (sid) => {
    await recordStream(env, sid, null);
    return recordCheckin(env, { userId: uid, username: uid, streamId: sid, startedAt: null, position: 9 });
  };

  /* Climb an unbroken run of ten streams. */
  let res;
  for (let i = 1; i <= 10; i++) {
    res = await checkInTo('S' + i);
    if (i === 3) {
      check('reaching a 3-streak pays the 3 tier once', res.awards.map(a => a.entries), [T[3]]);
      check('ledger after the 3-streak', ledgerEntries(env, uid), T[3]);
    }
    if (i === 4) {
      check('staying on the streak pays nothing further', res.awards, []);
      check('ledger unchanged after a non-tier stream', ledgerEntries(env, uid), T[3]);
    }
    if (i === 5) check('ledger after the 5-streak', ledgerEntries(env, uid), T[3] + T[5]);
  }
  check('the run reached a streak of 10', res.streak, 10);
  check('ledger after the full run is 3 + 5 + 10 tiers only', ledgerEntries(env, uid), T[3] + T[5] + T[10]);

  /* Break the run: a stream the viewer misses, then one they attend. */
  await recordStream(env, 'MISS', null);
  const r1 = await checkInTo('R1');
  check('after a miss the streak resets to 1', r1.streak, 1);
  check('and the reset pays nothing yet', r1.awards, []);

  await checkInTo('R2');
  const r3 = await checkInTo('R3');
  check('the rebuilt streak reaches 3 again', r3.streak, 3);
  check('and RE-EARNS the 3 tier', r3.awards.map(a => a.entries), [T[3]]);
  check('ledger shows the re-earned tier on top of the first run', ledgerEntries(env, uid), T[3] + T[5] + T[10] + T[3]);

  check('getCheckinStats agrees on the rebuilt streak', (await getCheckinStats(env, uid)).streak, 3);
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[phamily-autocredit] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[phamily-autocredit] ${passed} assertions passed.`);
console.log('');
