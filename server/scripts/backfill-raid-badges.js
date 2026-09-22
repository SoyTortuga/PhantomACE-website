#!/usr/bin/env node
/* ══════════════════════════════════════════════
   UNDEAD EXECUTIONER BADGES — retroactive backfill

     node server/scripts/backfill-raid-badges.js --service phantomace-web
     node server/scripts/backfill-raid-badges.js --service phantomace-web --confirm

   The badge ladder (see functions/api/raid-badges.js) only started counting
   the moment its code shipped. Anyone who redeemed "Summon Raid Boss"
   before then has real, Twitch-recorded history this site never saw. This
   reads that history straight from Twitch and reconciles each account's
   count up to match it -- backfillRaidRedemptions() takes the MAX of what
   is already stored and what Twitch reports, so this is safe to run before
   the live path has seen anyone, after it has, or run twice by mistake.

   ONLY status=FULFILLED REDEMPTIONS COUNT. A CANCELED one was refunded --
   Twitch gave the points back -- exactly like a live refusal never
   advances the ladder in raid-badges.js. UNFULFILLED (still sitting in the
   request queue, unlikely but possible if the webhook never ran) is
   deliberately excluded too: it has not actually happened yet.

   Dry run unless --confirm. The read from Twitch is always read-only.
   ══════════════════════════════════════════════ */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

import { createPool, waitForDatabase } from '../lib/db.js';
import { createKVStore } from '../lib/kv.js';
import { resolveDatabaseUrl, readServiceEnv } from '../lib/service-env.js';

const REDEMPTIONS_URL = 'https://api.twitch.tv/helix/channel_points/custom_rewards/redemptions';
const REWARDS_URL = 'https://api.twitch.tv/helix/channel_points/custom_rewards';

function arg(name, fallback = null) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return process.argv.includes(`--${name}`) ? true : fallback;
}
const line = (s = '') => console.log(s);

async function helixGet(token, clientId, url) {
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token, 'Client-Id': clientId } });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
  return { ok: res.ok, status: res.status, data, raw: text };
}

async function main() {
  const service = arg('service');
  const confirm = arg('confirm') === true;

  const databaseUrl = resolveDatabaseUrl({ service, fallback: arg('database-url') });
  if (!databaseUrl) {
    console.error('[backfill-raid-badges] No DATABASE_URL. Use --service phantomace-web.');
    process.exit(2);
  }

  const svc = service ? readServiceEnv(service) : {};
  const clientId = svc.TWITCH_CLIENT_ID || process.env.TWITCH_CLIENT_ID;
  const clientSecret = svc.TWITCH_CLIENT_SECRET || process.env.TWITCH_CLIENT_SECRET;
  const broadcasterId = svc.TWITCH_BROADCASTER_ID || process.env.TWITCH_BROADCASTER_ID;
  if (!clientId || !clientSecret || !broadcasterId) {
    console.error('[backfill-raid-badges] Missing TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET / TWITCH_BROADCASTER_ID.');
    process.exit(2);
  }

  const pool = createPool(databaseUrl);
  const info = await waitForDatabase();
  line(`Database:    ${info.db}`);
  const kv = createKVStore(pool);
  const env = { MARKETPLACE: kv, TWITCH_CLIENT_ID: clientId, TWITCH_CLIENT_SECRET: clientSecret, TWITCH_BROADCASTER_ID: broadcasterId };

  const { getBroadcasterToken } = await import('../../functions/api/bot/send-chat.js');
  const token = await getBroadcasterToken(env);
  if (!token) {
    console.error('[backfill-raid-badges] No broadcaster token. Step 2 of /api/admin/bot-setup grants it.');
    await pool.end();
    process.exit(3);
  }
  line('Broadcaster: token obtained');

  /* Prefer the id this site minted itself (Step 3c of bot-setup); fall back
     to matching by title exactly the way channel-points.js's webhook does,
     for a reward made by hand in the dashboard instead. */
  let rewardId = arg('reward-id') || await env.MARKETPLACE.get('raid_boss_reward_id');
  if (!rewardId) {
    const all = await helixGet(token, clientId, `${REWARDS_URL}?broadcaster_id=${broadcasterId}`);
    if (!all.ok) {
      console.error(`[backfill-raid-badges] Could not list rewards: HTTP ${all.status} ${all.raw.slice(0, 200)}`);
      await pool.end();
      process.exit(4);
    }
    const rewards = (all.data && all.data.data) || [];
    const matches = rewards.filter(r => /boss|raid/i.test(r.title));
    if (matches.length !== 1) {
      console.error(`[backfill-raid-badges] Could not identify the reward uniquely by title (found ${matches.length} matching "boss"/"raid").`);
      console.error('          Pass --reward-id <id> explicitly. Rewards on the channel:');
      for (const r of rewards) console.error(`            ${r.id}  ${r.title}`);
      await pool.end();
      process.exit(5);
    }
    rewardId = matches[0].id;
    line(`Reward:      matched by title — "${matches[0].title}" (${rewardId})`);
  } else {
    line(`Reward:      ${rewardId}`);
  }
  line('');

  /* Paginate every FULFILLED redemption and count them per account. Order
     does not matter here -- backfillRaidRedemptions() only ever needs the
     final total, not the sequence they arrived in. */
  const counts = new Map();     // user_id -> count
  const names = new Map();      // user_id -> display name, for the report
  let cursor = '';
  let page = 0;
  do {
    const url = `${REDEMPTIONS_URL}?broadcaster_id=${broadcasterId}&reward_id=${rewardId}` +
      `&status=FULFILLED&first=50` + (cursor ? `&after=${cursor}` : '');
    const res = await helixGet(token, clientId, url);
    if (!res.ok) {
      console.error(`[backfill-raid-badges] Could not read redemptions: HTTP ${res.status} ${res.raw.slice(0, 200)}`);
      await pool.end();
      process.exit(6);
    }
    const rows = (res.data && res.data.data) || [];
    for (const r of rows) {
      counts.set(r.user_id, (counts.get(r.user_id) || 0) + 1);
      names.set(r.user_id, r.user_name || r.user_login || r.user_id);
    }
    cursor = res.data && res.data.pagination && res.data.pagination.cursor;
    page++;
  } while (cursor);

  line(`Redemptions: ${[...counts.values()].reduce((a, b) => a + b, 0)} fulfilled, across ${counts.size} account(s), ${page} page(s)`);
  line('');

  if (counts.size === 0) {
    line('Nothing to backfill.');
    await pool.end();
    return;
  }

  const { backfillRaidRedemptions, RAID_REDEMPTION_TIERS, getRaidRedemptionCount } = await import('../../functions/api/raid-badges.js');

  const tally = Object.fromEntries(RAID_REDEMPTION_TIERS.map(t => [t.id, 0]));
  const plan = [];
  for (const [userId, historicalCount] of counts) {
    const before = await getRaidRedemptionCount(env, userId);
    const due = RAID_REDEMPTION_TIERS.filter(t => t.count <= Math.max(before, historicalCount));
    plan.push({ userId, name: names.get(userId), before, historicalCount, due });
  }

  line('PLANNED');
  for (const p of plan) {
    if (!p.due.length) continue;
    line(`  ${p.name} (${p.userId}) — Twitch: ${p.historicalCount}, stored: ${p.before} → tiers due: ${p.due.map(t => t.id.replace('undead-executioner-', '')).join(', ')}`);
  }
  const untouched = plan.filter(p => !p.due.length).length;
  if (untouched) line(`  (+${untouched} account(s) below the first threshold — nothing to grant)`);
  line('');

  if (!confirm) {
    line('DRY RUN — nothing written. Re-run with --confirm.');
    await pool.end();
    return;
  }

  for (const p of plan) {
    const granted = await backfillRaidRedemptions(env, p.userId, p.historicalCount);
    for (const t of granted) tally[t.id]++;
  }

  line('DONE');
  for (const t of RAID_REDEMPTION_TIERS) line(`  ${t.id}: ${tally[t.id]} newly granted`);
  await pool.end();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[backfill-raid-badges]', err.message);
    process.exit(1);
  });
}
