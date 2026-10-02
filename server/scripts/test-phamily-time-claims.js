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
import { ledgerKey } from '../../functions/api/giveaway-entries.js';

/* ── A clock the tests control ───────────────────────────────────────
   Every month-dependent behaviour here — the themed October table, the
   grace week that lets September be claimed — is pinned to a named instant
   rather than to whatever today is. Noon Pacific on the 3rd: inside the
   seven-day grace window, and well clear of any midnight boundary. */
const RealDate = Date;
let FAKE_NOW = RealDate.parse('2026-10-03T19:00:00Z');
globalThis.Date = class extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(FAKE_NOW); }
  static now() { return FAKE_NOW; }
};
const setNow = (iso) => { FAKE_NOW = RealDate.parse(iso); };

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
      /* Per-key serialised, like the real advisory-locked mutate(): the
         next mutator for a key does not start until the previous one has
         written. get()/put() stay unlocked and yield, so any code still
         doing get-then-put races here exactly as it does in production. */
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

/* The same season month key phamily-time.js computes internally (SEASON_TZ, not
   UTC). Needed to seed pt_<userId>_<month> directly, since the handler owns that
   key and does not export a way in. */
import { monthKey } from '../../functions/api/season-time.js';
const MK = monthKey();

function seedUser(env, userId, { level = 0, claimedRewards = [], claimedMilestones = [], month = MK, lastHeartbeat = 0 } = {}) {
  env._store.set(`pt_${userId}_${month}`, JSON.stringify({
    userId, month, hours: level, level, claimedRewards, claimedMilestones,
    attendance: {}, lastHeartbeat,
  }));
}
const userData = (env, userId, month = MK) => {
  const raw = env._store.get(`pt_${userId}_${month}`);
  return raw ? JSON.parse(raw) : null;
};
const seedInventory = (env, userId, items) =>
  env._store.set(`inv_${userId}`, JSON.stringify({ userId, items, equips: {} }));
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

/* ══ N4 — PARALLEL CLAIMS PAY ONCE ════════════════════════════════════
   Every claim used to be get -> check -> put with nothing held between. Two
   requests for the same key both read "not claimed" and both paid. The
   check now lives inside the locked mutate, so exactly one wins. */
check('the test clock is in October', MK, '2026-10');
{
  const env = makeEnv();
  const uid = USERS.sub.user_id;
  seedUser(env, uid, { level: 100 });

  const N = 6;
  const many = (body) => Promise.all(Array.from({ length: N }, () => post(env, 'sub', body)));

  const dice = await many({ action: 'claim-reward', rewardKey: '95_phamily_dice_rare' });
  check('six parallel claims of a cosmetic: exactly one succeeds', dice.filter(r => r.status === 200).length, 1);
  check('the rest are told it is already claimed',
    dice.filter(r => r.status !== 200).map(r => r.data.error), Array(N - 1).fill('Already claimed'));
  check('one dice item in the inventory',
    inventory(env, uid).items.filter(i => i.type === 'dice').length, 1);

  const egg = await many({ action: 'claim-reward', rewardKey: '6_phamily_egg_common' });
  check('six parallel claims of a consumable: exactly one succeeds', egg.filter(r => r.status === 200).length, 1);
  check('and the egg stack is one, not six',
    inventory(env, uid).items.find(i => i.id === '6_phamily_egg_common').quantity, 1);

  const ga = await many({ action: 'claim-reward', rewardKey: '2_follower_giveaway_common' });
  check('six parallel claims of giveaway entries: exactly one succeeds', ga.filter(r => r.status === 200).length, 1);
  check('and the ledger holds one payout (2 entries), not six',
    JSON.parse(env._store.get(ledgerKey(uid, MK))).entries, 2);

  const ms = await many({ action: 'claim-milestone', milestoneLevel: 15 });
  check('six parallel milestone claims: exactly one succeeds', ms.filter(r => r.status === 200).length, 1);
  check('one title', inventory(env, uid).items.filter(i => i.type === 'title').length, 1);
  check('and its bonus egg once',
    inventory(env, uid).items.find(i => i.id === 'ms_15_egg_2026-10').quantity, 1);

  const row = userData(env, uid);
  check('each key recorded once',
    row.claimedRewards.filter((k, i, a) => a.indexOf(k) !== i), []);
  check('the milestone recorded once', row.claimedMilestones, [15]);
  check('all-time counts the four real claims, not twenty-four',
    JSON.parse(env._store.get(`pt_alltime_${uid}`)).totalRewardsClaimed, 4);
}

/* claim-all twice at once (a double click, a second tab) must not pay any
   reward twice — and a heartbeat landing in the middle of it must not put
   back the pre-claim claimedRewards list, which un-claimed rewards so the
   next claim-all paid them again. */
{
  const env = makeEnv();
  const uid = USERS.sub.user_id;
  env._store.set('twitch_live_cache', JSON.stringify({ live: true, checkedAt: Date.now() }));
  seedUser(env, uid, { level: 40, lastHeartbeat: Date.now() - 60000 });

  const [a, b, hb1, c, hb2] = await Promise.all([
    post(env, 'sub', { action: 'claim-all' }),
    post(env, 'sub', { action: 'claim-all' }),
    post(env, 'sub', { action: 'heartbeat' }),
    post(env, 'sub', { action: 'claim-all' }),
    post(env, 'sub', { action: 'heartbeat' }),
  ]);
  check('every parallel claim-all answers 200', [a, b, c].map(r => r.status), [200, 200, 200]);
  check('and none reports a failure', [a, b, c].flatMap(r => r.data.failed || []), []);
  const paid = [a, b, c].flatMap(r => r.data.rewards || []);
  check('no reward is paid by two of them', paid.filter((k, i) => paid.indexOf(k) !== i), []);
  const paidMs = [a, b, c].flatMap(r => r.data.milestones || []);
  check('no milestone is paid by two of them', paidMs.filter((k, i) => paidMs.indexOf(k) !== i), []);

  const row = userData(env, uid);
  check('everything paid is still recorded after the heartbeats', paid.filter(k => !row.claimedRewards.includes(k)), []);
  check('milestones too', paidMs.filter(l => !row.claimedMilestones.includes(l)).length, 0);
  ok('the heartbeats still credited time', row.hours > 40 && hb1.status === 200 && hb2.status === 200);
  const eggs = inventory(env, uid).items.filter(i => i.type === 'egg');
  check('every egg stack is exactly one', eggs.filter(e => e.quantity !== 1).map(e => e.id), []);
  const again = await post(env, 'sub', { action: 'claim-all' });
  check('a later claim-all finds nothing un-claimed', again.data.nothingToClaim, true);
}

/* ══ N5 — A GRACE CLAIM PAYS THE MONTH THAT EARNED IT ══════════════════
   claim-prev looked the key up in THIS month's table, so in October's
   grace week a September key paid October content. */
{
  const env = makeEnv();
  const uid = USERS.sub.user_id;
  seedUser(env, uid, { level: 100, month: '2026-09' });
  seedUser(env, uid, { level: 100 });

  const skull = await post(env, 'sub', { action: 'claim-prev', type: 'reward', rewardKey: '85_follower_skull-skin_rare' });
  check('a grace claim of a September skull skin succeeds', skull.status, 200);
  check('and reports September\'s reward', skull.data.granted.name, 'Skull Skin');
  const skins = inventory(env, uid).items.filter(i => i.type === 'skull-skin').map(i => i.id);
  check('it grants September\'s Blood skull, not October\'s Bonewhite', skins, ['blood']);

  await post(env, 'sub', { action: 'claim-prev', type: 'reward', rewardKey: '48_phamily_dice_rare' });
  check('a September dice grace claim grants Phyrexian, not Graveslate',
    inventory(env, uid).items.filter(i => i.type === 'dice').map(i => i.id), ['phyrexian']);

  const room = await post(env, 'sub', { action: 'claim-prev', type: 'reward', rewardKey: '4_follower_room-piece_common' });
  check('a September room-piece grace claim succeeds', room.status, 200);
  check('and grants September\'s first-tenth piece, not October\'s',
    inventory(env, uid).items.filter(i => i.type === 'room-piece').map(i => [i.id, i.meta.piece]),
    [['room-piece-snacks-r1c1', 'snacks-r1c1']]);
  await post(env, 'sub', { action: 'claim-reward', rewardKey: '4_follower_room-piece_common' });
  check('and the October claim of the same key is a new piece, not a dedupe',
    inventory(env, uid).items.filter(i => i.type === 'room-piece').map(i => i.id),
    ['room-piece-snacks-r1c1', 'room-piece-snacks-r1c8']);

  await post(env, 'sub', { action: 'claim-prev', type: 'reward', rewardKey: '10_follower_cardback_common' });
  const cb = inventory(env, uid).items.filter(i => i.type === 'cardback');
  check('a September card back grace claim grants Basic, not Cobweb', cb.map(i => i.name), ['Basic Card Back']);

  const ms = await post(env, 'sub', { action: 'claim-prev', type: 'milestone', milestoneLevel: 60 });
  check('a September milestone grace claim succeeds', ms.status, 200);
  const items = inventory(env, uid).items;
  const title = items.find(i => i.id === 'ms_60_title_2026-09');
  check('its title is September\'s', title && title.name, 'Guardian');
  const badge = items.find(i => i.id === 'ms_60_badge_2026-09');
  check('its badge is September\'s, with the plain art',
    badge && [badge.name, badge.meta.image], ['Guardian Badge', '/assets/badges/milestones/ms-60.png']);
  ok('its bonus dice are September\'s Crimson, not Bloodletter',
    items.some(i => i.type === 'dice' && i.id === 'crimson') && !items.some(i => i.type === 'dice' && i.id === 'blood'));

  await post(env, 'sub', { action: 'claim-prev', type: 'milestone', milestoneLevel: 45 });
  const banner = inventory(env, uid).items.find(i => i.id === 'ms_45_banner_2026-09');
  check('a September banner bonus carries no Halloween theme', banner && banner.meta, undefined);

  const sep = userData(env, uid, '2026-09');
  check('the claims landed on September\'s row',
    sep.claimedRewards.slice().sort(), ['10_follower_cardback_common', '48_phamily_dice_rare', '4_follower_room-piece_common', '85_follower_skull-skin_rare']);
  check('and September\'s milestones', sep.claimedMilestones, [60, 45]);
  check('October\'s row has only its own claim', userData(env, uid).claimedRewards, ['4_follower_room-piece_common']);

  /* The same key, claimed for October, is October's. */
  await post(env, 'sub', { action: 'claim-reward', rewardKey: '85_follower_skull-skin_rare' });
  check('and an October claim of the same key grants Bonewhite alongside it',
    inventory(env, uid).items.filter(i => i.type === 'skull-skin').map(i => i.id), ['blood', 'bonewhite']);
}

/* Outside the grace week, claim-prev is still refused. */
{
  const env = makeEnv();
  setNow('2026-10-12T19:00:00Z');
  seedUser(env, USERS.sub.user_id, { level: 100, month: '2026-09' });
  const late = await post(env, 'sub', { action: 'claim-prev', type: 'reward', rewardKey: '85_follower_skull-skin_rare' });
  check('a grace claim after day seven is refused', late.status, 400);
  setNow('2026-10-03T19:00:00Z');
}

/* ══ N6 — OCTOBER'S CARD BACKS AND EMOTE PACKS ARE NEW ITEMS ══════════
   These were granted with the reward key as their id. September's Basic
   Card Back and October's Cobweb Card Back share a key, so grantItem saw
   the second as a duplicate and granted nothing. */
{
  const env = makeEnv();
  const uid = USERS.sub.user_id;
  seedUser(env, uid, { level: 60 });
  /* What a September claim left behind, in the shape the old code stored. */
  seedInventory(env, uid, [
    { id: '10_follower_cardback_common', game: 'memory-match', type: 'cardback', name: 'Basic Card Back', consumable: false },
    { id: '22_follower_emote_uncommon', game: 'memory-match', type: 'emote-pack', name: 'Emote Pack', consumable: false },
    { id: '10_phamily_cardback_uncommon', game: 'memory-match', type: 'cardback', name: 'Phamily Card Back', consumable: false },
  ]);

  for (const rewardKey of ['10_follower_cardback_common', '22_follower_emote_uncommon', '55_follower_cardback_rare',
    '10_phamily_cardback_uncommon', '22_phamily_emote_uncommon', '55_phamily_cardback_rare']) {
    const r = await post(env, 'sub', { action: 'claim-reward', rewardKey });
    check(`October ${rewardKey} claims`, r.status, 200);
  }
  const inv = inventory(env, uid).items;
  const names = (type) => inv.filter(i => i.type === type).map(i => i.name).sort();
  check('a user who owns September\'s card backs now also owns October\'s',
    names('cardback'), ['Basic Card Back', 'Bat Card Back', 'Cobweb Card Back', 'Crypt Card Back', 'Ghost Card Back', 'Phamily Card Back']);
  check('and October\'s emote packs beside September\'s',
    names('emote-pack'), ['Emote Pack', 'Haunted Emote Pack', 'Spooky Emote Pack']);
  check('the new ones carry a name-derived id',
    inv.find(i => i.name === 'Cobweb Card Back').id, 'cardback-cobweb-card-back');
}

/* A REPEAT of the same cosmetic still dedupes — under the new id, and
   against an old grant that carried the reward key as its id. */
{
  const env = makeEnv();
  const uid = USERS.viewer.user_id;
  setNow('2026-11-10T19:00:00Z');
  const NOV = '2026-11';
  seedUser(env, uid, { level: 20, month: NOV });
  seedInventory(env, uid, [
    { id: '10_follower_cardback_common', game: 'memory-match', type: 'cardback', name: 'Basic Card Back', consumable: false },
  ]);
  const r = await post(env, 'viewer', { action: 'claim-reward', rewardKey: '10_follower_cardback_common' });
  check('November\'s Basic Card Back claims', r.status, 200);
  check('but is not granted twice to someone who owns it under the old id',
    inventory(env, uid).items.filter(i => i.type === 'cardback').length, 1);

  const env2 = makeEnv();
  seedUser(env2, uid, { level: 20, month: NOV });
  seedInventory(env2, uid, [
    { id: 'cardback-basic-card-back', game: 'memory-match', type: 'cardback', name: 'Basic Card Back', consumable: false },
  ]);
  await post(env2, 'viewer', { action: 'claim-reward', rewardKey: '10_follower_cardback_common' });
  check('nor under the new id',
    inventory(env2, uid).items.filter(i => i.type === 'cardback').length, 1);
  setNow('2026-10-03T19:00:00Z');
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
