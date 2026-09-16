#!/usr/bin/env node
/* ══════════════════════════════════════════════
   PHAMILY TIME CLAIM GATING — test suite

     node server/scripts/test-phamily-time-claims.js

   test-phamily-rewards.js proves the reward TABLE is sound: the data does
   not drift from the page, every key is unique, and findReward() refuses
   anything not on it. None of that exercises the HANDLER that actually
   grants a claim — the code path that shipped two real bugs:

     - the original exploit: rewardType/rewardRarity/rewardName trusted
       from the request body, so any reward on the track was claimable at
       mythic by anyone past level 2 (findReward() closed this)
     - the regression that followed: trackFor() picked exactly one track
       per viewer and rejected a claim on the other, so a SUBSCRIBER could
       not claim their own follower-track rewards at all

   The suite would pass just as cleanly with the phamily-track gate deleted
   outright, which is exactly the gap this file exists to close. It drives
   handleClaimReward and handleClaimAll through onRequestPost, the way
   test-mtgbbb-rooms.js drives its routes, with a fake KV standing in for
   MARKETPLACE.
   ══════════════════════════════════════════════ */

import * as phamilyTime from '../../functions/api/phamily-time.js';

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
      /* addEntries() (giveaway-type rewards) and the overlay feed use
         mutate(); grantItem() does not, but a fake KV should support both
         the same way the real bindings do. */
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

/* Same UTC month key phamily-time.js computes internally. Needed to seed
   pt_<userId>_<month> directly, since the handler owns that key and does
   not export a way in. */
function monthKey(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
const MK = monthKey();

function seedUser(env, userId, { level = 0, claimedRewards = [], claimedMilestones = [] } = {}) {
  env._store.set(`pt_${userId}_${MK}`, JSON.stringify({
    userId, month: MK, hours: level, level, claimedRewards, claimedMilestones,
    attendance: {}, lastHeartbeat: 0,
  }));
}
const userData = (env, userId) => JSON.parse(env._store.get(`pt_${userId}_${MK}`));
const inventory = (env, userId) => {
  const raw = env._store.get(`inv_${userId}`);
  return raw ? JSON.parse(raw) : { items: [] };
};

const USERS = {
  /* subTier drives the gate, not role — a moderator who also subscribes
     must still get the phamily track. getSubTier() in phamily-time.js
     exists specifically so that derivation cannot happen here either. */
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

/* ── The gate itself: phamily track requires a subscription, follower does
   not — and it is ADDITIVE, not a swap. ─────────────────────────────────── */
{
  const env = makeEnv();
  seedUser(env, USERS.viewer.user_id, { level: 10 });
  seedUser(env, USERS.sub.user_id, { level: 10 });

  const refused = await post(env, 'viewer', { action: 'claim-reward', rewardKey: '6_phamily_egg_common' });
  check('a non-sub claiming a phamily-track reward is refused', refused.status, 403);
  check('and told why', refused.data.error, 'Phamily track rewards require an active subscription');
  check('claimedRewards is untouched', userData(env, USERS.viewer.user_id).claimedRewards, []);

  const followerAsViewer = await post(env, 'viewer', { action: 'claim-reward', rewardKey: '10_follower_cardback_common' });
  check('a non-sub can still claim the follower track', followerAsViewer.status, 200);

  /* THE REGRESSION THIS FILE EXISTS TO CATCH: trackFor() picked exactly one
     track per viewer and rejected the other, so a subscriber could not
     claim their own follower-track reward. */
  const followerAsSub = await post(env, 'sub', { action: 'claim-reward', rewardKey: '10_follower_cardback_common' });
  check('a sub can claim a follower-track reward — must not regress', followerAsSub.status, 200);

  const phamilyAsSub = await post(env, 'sub', { action: 'claim-reward', rewardKey: '6_phamily_egg_common' });
  check('and the same sub can also claim a phamily-track reward — additive, not a swap', phamilyAsSub.status, 200);
  check('both land in claimedRewards',
    userData(env, USERS.sub.user_id).claimedRewards.slice().sort(),
    ['10_follower_cardback_common', '6_phamily_egg_common'].sort());
  ok('and the item actually landed in inventory',
    inventory(env, USERS.sub.user_id).items.some(i => i.id === '6_phamily_egg_common'));
}

/* ── The lookup, driven through the real handler rather than findReward()
   in isolation. Same exploit test-phamily-rewards.js covers at the table
   level: a level-2 follower giveaway exists at common; the same slot at
   mythic, or with the type swapped, must not exist. ─────────────────────── */
{
  const env = makeEnv();
  seedUser(env, USERS.sub.user_id, { level: 50 });

  const richer = await post(env, 'sub', { action: 'claim-reward', rewardKey: '2_follower_giveaway_mythic' });
  check('a real level+track at a richer rarity is refused', richer.status, 400);
  check('and named as not found', richer.data.error, 'No such reward');

  const typeSwap = await post(env, 'sub', { action: 'claim-reward', rewardKey: '2_follower_egg_mythic' });
  check('a real level+track with the type swapped is refused', typeSwap.status, 400);

  check('nothing was granted from either attempt', userData(env, USERS.sub.user_id).claimedRewards, []);
}

/* ── Ordinary rejections still hold once routed through the subscription
   gate, not just around it. ─────────────────────────────────────────────── */
{
  const env = makeEnv();
  seedUser(env, USERS.sub.user_id, { level: 5 });

  check('a level not yet reached is refused',
    (await post(env, 'sub', { action: 'claim-reward', rewardKey: '10_follower_cardback_common' })).status, 400);

  const first = await post(env, 'sub', { action: 'claim-reward', rewardKey: '2_follower_giveaway_common' });
  check('the first claim succeeds', first.status, 200);
  const second = await post(env, 'sub', { action: 'claim-reward', rewardKey: '2_follower_giveaway_common' });
  check('claiming it again is refused', second.status, 400);
  check('and named as already claimed', second.data.error, 'Already claimed');
}

/* ── claim-all walks the same gate one reward at a time, so it must show
   the same shape: additive for a sub, follower-only for a non-sub. ──────── */
{
  const env = makeEnv();
  seedUser(env, USERS.viewer.user_id, { level: 20 });
  seedUser(env, USERS.sub.user_id, { level: 20 });

  const viewerAll = await post(env, 'viewer', { action: 'claim-all' });
  check('claim-all succeeds for a non-sub', viewerAll.status, 200);
  ok('and claims something', viewerAll.data.claimed > 0);
  check('none of it is phamily-track',
    viewerAll.data.rewards.some(k => k.includes('_phamily_')), false);
  check('nothing failed', viewerAll.data.failed, []);

  const subAll = await post(env, 'sub', { action: 'claim-all' });
  check('claim-all succeeds for a sub', subAll.status, 200);
  ok('and includes a follower-track reward', subAll.data.rewards.some(k => k.includes('_follower_')));
  ok('and includes a phamily-track reward', subAll.data.rewards.some(k => k.includes('_phamily_')));
  ok('and includes the milestone at level 15', subAll.data.milestones.includes(15));
  check('nothing failed', subAll.data.failed, []);
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[phamily-time-claims] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[phamily-time-claims] ${passed} assertions passed.`);
console.log('');
