#!/usr/bin/env node
/* ══════════════════════════════════════════════
   UNDEAD EXECUTIONER BADGE LADDER — test suite

     node server/scripts/test-raid-badges.js

   The ladder is a lifetime COUNT, not a flag, and it is fed from two
   different places: the live webhook (one redemption at a time) and a
   one-off backfill script (a historical total, possibly already past
   several thresholds at once). Both have to land on the exact same
   inventory shape, neither may ever grant a tier twice, and a refunded
   redemption -- Twitch charged for it, but the fight was already going --
   must not advance the ladder at all.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RAID_REDEMPTION_TIERS, recordRaidRedemption, backfillRaidRedemptions, getRaidRedemptionCount,
  recordRaidKill, getRaidKillCount,
} from '../../functions/api/raid-badges.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

function fakeKV(seed = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    store,
    read(k) { return store.has(k) ? JSON.parse(store.get(k)) : null; },
    async get(k, t) { const v = store.get(k); return v === undefined ? null : (t === 'json' ? JSON.parse(v) : v); },
    async put(k, v) { store.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
    async delete(k) { store.delete(k); },
    async mutate(k, fn) { const cur = store.has(k) ? JSON.parse(store.get(k)) : null; const out = await fn(cur); if (out === undefined) return; store.set(k, JSON.stringify(out)); },
  };
}

const badgeIds = (env, userId) => {
  const inv = env.read('inv_' + userId);
  return inv ? inv.items.filter(i => i.type === 'badge').map(i => i.id) : [];
};

/* ── The table itself ────────────────────────────────────────────────── */
{
  check('five tiers', RAID_REDEMPTION_TIERS.length, 5);
  check('ascending, exactly 1st/10th/25th/50th/100th', RAID_REDEMPTION_TIERS.map(t => t.count), [1, 10, 25, 50, 100]);
  check('one entry per named tier', RAID_REDEMPTION_TIERS.map(t => t.id), [
    'undead-executioner-bronze', 'undead-executioner-silver', 'undead-executioner-gold',
    'undead-executioner-platinum', 'undead-executioner-phantom',
  ]);
  for (const t of RAID_REDEMPTION_TIERS) {
    ok(`${t.id} is a profile badge`, t.game === 'profile');
    ok(`${t.id} carries artwork`, typeof t.image === 'string' && t.image.startsWith('/assets/badges/'));
    ok(`${t.id}'s artwork exists on disk`, fs.existsSync(path.join(REPO, t.image.replace(/^\//, ''))));
  }
}

/* ── Kill-participation ladder: separate count, same badges ───────────── */
{
  const env = { MARKETPLACE: fakeKV() };

  /* A fresh account, kills only: the kill count alone grants the tiers. */
  await recordRaidKill(env, 'k2');
  check('a kill alone grants bronze', badgeIds(env.MARKETPLACE, 'k2'), ['undead-executioner-bronze']);
  check('and does not touch the summon count', await getRaidRedemptionCount(env, 'k2'), 0);
  check('the kill count advanced', await getRaidKillCount(env, 'k2'), 1);

  /* Both ladders on one account: separate counts, one shared set of badges. */
  await recordRaidRedemption(env, 'k1');                 // summon 1 -> bronze
  for (let i = 0; i < 10; i++) await recordRaidKill(env, 'k1');   // kill 10 -> silver
  check('kill count is its own', await getRaidKillCount(env, 'k1'), 10);
  check('summon count untouched by kills', await getRaidRedemptionCount(env, 'k1'), 1);
  ok('reaching 10 kills grants silver', badgeIds(env.MARKETPLACE, 'k1').includes('undead-executioner-silver'));
  check('badges are shared — no duplicates', badgeIds(env.MARKETPLACE, 'k1').length, new Set(badgeIds(env.MARKETPLACE, 'k1')).size);
}

/* ── Redeeming a kill code routes to the kill ladder (source check) ────── */
{
  const ic = fs.readFileSync(path.join(REPO, 'functions/api/item-codes.js'), 'utf8');
  ok('item-codes detects raid kill codes', /function isRaidKillCode/.test(ic) && /game === 'skull-clicker'/.test(ic));
  ok('and routes them to recordRaidKill, not the one-off grant',
     /isRaidKillCode\(record\.item\)\)[\s\S]*?recordRaidKill\(env, userId\)/.test(ic));
  const reg = fs.readFileSync(path.join(REPO, 'server/lib/registry.js'), 'utf8');
  ok('the kill count is a registered family', /prefix: 'raid_kill_count_'/.test(reg));
}

/* ── Live path: one redemption at a time ─────────────────────────────── */
{
  const env = { MARKETPLACE: fakeKV() };
  const grantsByRedemption = {};
  for (let i = 1; i <= 100; i++) {
    const earned = await recordRaidRedemption(env, 'u1');
    if (earned.length) grantsByRedemption[i] = earned.map(t => t.id);
  }
  check('badges land on exactly the five milestone redemptions, nowhere else', grantsByRedemption, {
    1: ['undead-executioner-bronze'],
    10: ['undead-executioner-silver'],
    25: ['undead-executioner-gold'],
    50: ['undead-executioner-platinum'],
    100: ['undead-executioner-phantom'],
  });
  check('all five sit in the inventory afterward', badgeIds(env.MARKETPLACE, 'u1'), [
    'undead-executioner-bronze', 'undead-executioner-silver', 'undead-executioner-gold',
    'undead-executioner-platinum', 'undead-executioner-phantom',
  ]);
  check('the count itself is exposed too', await getRaidRedemptionCount(env, 'u1'), 100);

  const again = await recordRaidRedemption(env, 'u1');
  check('a 101st redemption earns nothing new', again, []);
  check('and never regrants an existing tier', badgeIds(env.MARKETPLACE, 'u1').length, 5);
}
{
  /* Between milestones, nothing is written at all -- not an empty grant, no
     write. mutate() on a no-op leaves the stored row untouched. */
  const env = { MARKETPLACE: fakeKV() };
  await recordRaidRedemption(env, 'u2');           // 1st -- bronze, writes the inventory
  const before = env.MARKETPLACE.store.get('inv_u2');
  await recordRaidRedemption(env, 'u2');           // 2nd -- nothing due
  check('a redemption between milestones does not touch the inventory row', env.MARKETPLACE.store.get('inv_u2'), before);
}

/* ── Backfill: a historical total, possibly past several thresholds ──── */
{
  const env = { MARKETPLACE: fakeKV() };
  const earned = await backfillRaidRedemptions(env, 'u3', 37);
  check('37 historical redemptions earns bronze, silver AND gold at once', earned.map(t => t.id), [
    'undead-executioner-bronze', 'undead-executioner-silver', 'undead-executioner-gold',
  ]);
  check('but not platinum yet', badgeIds(env.MARKETPLACE, 'u3').includes('undead-executioner-platinum'), false);
  check('the count is recorded as the historical total', await getRaidRedemptionCount(env, 'u3'), 37);
}
{
  /* Never regresses a count the live path already advanced past. */
  const env = { MARKETPLACE: fakeKV() };
  for (let i = 0; i < 60; i++) await recordRaidRedemption(env, 'u4');
  const backfilled = await backfillRaidRedemptions(env, 'u4', 5);
  check('a lower historical count does not roll the ladder back', await getRaidRedemptionCount(env, 'u4'), 60);
  check('and grants nothing new -- everything due at 60 was already granted live', backfilled, []);
}
{
  /* Idempotent: running the backfill script twice (or after some live
     redemptions already landed) must not double-grant. */
  const env = { MARKETPLACE: fakeKV() };
  const first = await backfillRaidRedemptions(env, 'u5', 12);
  const second = await backfillRaidRedemptions(env, 'u5', 12);
  ok('the first run grants something', first.length > 0);
  check('re-running the same backfill grants nothing more', second, []);
}

/* ── Wiring: something actually calls this ───────────────────────────── */
{
  const cp = fs.readFileSync(path.join(REPO, 'functions/api/channel-points.js'), 'utf8');
  const handler = /'raid-boss':\s*async[\s\S]*?\n  \},/.exec(cp);
  ok('the raid-boss handler exists', !!handler);
  const body = handler ? handler[0] : '';
  ok('and records a redemption', /recordRaidRedemption\(/.test(body));
  /* Only when the boss actually spawned -- a refund must not count. */
  ok('gated on the boss having actually spawned', /if \(spawned\)/.test(body));

  const router = fs.readFileSync(path.join(REPO, 'server/router.js'), 'utf8');
  ok('the module is declared a non-route', /'api\/raid-badges\.js'/.test(router));

  const reg = fs.readFileSync(path.join(REPO, 'server/lib/registry.js'), 'utf8');
  ok('its KV prefix is registered', /prefix: 'raid_redeem_count_'/.test(reg));
}

/* ── END TO END, through the real webhook ────────────────────────────── */
{
  const { signEventSub } = await import('../lib/eventsub.js');
  const SECRET = 'a-test-eventsub-secret';
  const env = { TWITCH_EVENTSUB_SECRET: SECRET, MARKETPLACE: fakeKV() };

  async function redeem(userId, id) {
    const raw = JSON.stringify({
      subscription: { type: 'channel.channel_points_custom_reward_redemption.add' },
      event: { id, user_id: String(userId), user_name: 'viewer' + userId, reward: { id: 'rw1', title: 'Summon Raid Boss' } },
    });
    const ts = new Date().toISOString();
    const request = new Request('https://phantomace.tv/api/channel-points', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'twitch-eventsub-message-type': 'notification',
        'twitch-eventsub-message-id': id,
        'twitch-eventsub-message-timestamp': ts,
        'twitch-eventsub-message-signature': await signEventSub(SECRET, id, ts, raw),
      },
      body: raw,
    });
    const mod = await import('../../functions/api/channel-points.js');
    return mod.onRequestPost({ env, request });
  }

  const res1 = await redeem('e1', 'redemption-1');
  check('the first redemption is accepted', res1.status, 200);
  check('and earns bronze through the real webhook', badgeIds(env.MARKETPLACE, 'e1'), ['undead-executioner-bronze']);

  /* A SECOND redemption while the boss is still up must be refused and
     refunded -- and must NOT count toward the ladder. settleRedemption's
     own PATCH call fails here (no broadcaster token in this fake env),
     which is fine: the refusal itself is what this test is checking, not
     whether Twitch was successfully told about it. */
  const res2 = await redeem('e2', 'redemption-2');
  check('a second redemption while the fight is still going is still accepted', res2.status, 200);
  check('but earns the second redeemer nothing', badgeIds(env.MARKETPLACE, 'e2'), []);
  check('and does not advance the FIRST redeemer either', badgeIds(env.MARKETPLACE, 'e1'), ['undead-executioner-bronze']);

  /* End the fight, then redeem nine more times as the original viewer
     (redemption-1 was their 1st) to reach their 10th SUCCESSFUL redemption
     and earn silver. */
  for (let i = 3; i <= 11; i++) {
    env.MARKETPLACE.store.delete('sc_raid');   // each one only succeeds once the last fight is gone
    await redeem('e1', 'redemption-' + i);
  }
  check('the 10th successful redemption earns silver', badgeIds(env.MARKETPLACE, 'e1'), [
    'undead-executioner-bronze', 'undead-executioner-silver',
  ]);
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[raid-badges] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[raid-badges] ${passed} assertions passed.`);
console.log('');
