#!/usr/bin/env node
/* ══════════════════════════════════════════════
   RAID KILL-PARTICIPATION LADDER — retroactive backfill

     node server/scripts/backfill-raid-kills.js --service phantomace-web
     node server/scripts/backfill-raid-kills.js --service phantomace-web --confirm

   The raid kill-reward codes ("<boss> Raider/Slayer", minted in skull-raid.js
   with ids like raid_<raidId>_u_<uid>) used to redeem into a unique, art-less
   one-off badge — which is why nothing usable appeared. They now advance a
   kill-participation count whose thresholds (1/10/25/50/100) grant the Undead
   Executioner tier badges (raid-badges.js), a separate ladder from summoning.

   This reconciles accounts that redeemed those codes before the ladder existed:
     • counts, per account, how many raid kill codes it redeemed (each code is
       restricted to one account and redeemed once);
     • raises that account's kill count to at least the tally and grants every
       tier now due (backfillRaidKills — MAX of stored and tally, safe to re-run);
     • removes the old art-less one-off raid_* badges the broken path left in
       inventories, now superseded by the tier badges.

   Dry run unless --confirm.
   ══════════════════════════════════════════════ */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

import { createPool, waitForDatabase } from '../lib/db.js';
import { createKVStore } from '../lib/kv.js';
import { resolveDatabaseUrl } from '../lib/service-env.js';
import { backfillRaidKills } from '../../functions/api/raid-badges.js';

const line = (s = '') => console.log(s);
function arg(name, fallback = null) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return process.argv.includes(`--${name}`) ? true : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

/* Same test the redeem path uses (item-codes.js isRaidKillCode). */
function isRaidKillCode(item) {
  return !!item && typeof item.id === 'string' && item.id.startsWith('raid_')
    && item.game === 'skull-clicker' && item.type === 'badge';
}

/* Remove the art-less one-off raid_* badges the old path granted. Returns how
   many were dropped from this account. */
async function cleanupOneOffs(env, userId) {
  let removed = 0;
  await env.MARKETPLACE.mutate(`inv_${userId}`, (current) => {
    if (!current || !Array.isArray(current.items)) return undefined;
    const kept = current.items.filter(i => !isRaidKillCode(i));
    removed = current.items.length - kept.length;
    if (!removed) return undefined;
    return { ...current, items: kept };
  });
  return removed;
}

async function main() {
  const databaseUrl = resolveDatabaseUrl({ service: arg('service'), fallback: arg('database-url') });
  if (!databaseUrl) {
    line('No DATABASE_URL. Pass --service phantomace-web, or set it in server/.env.');
    process.exit(1);
  }
  const dbName = (databaseUrl.split('/').pop() || '').split('?')[0];

  const pool = createPool(databaseUrl);
  await waitForDatabase();
  const env = { MARKETPLACE: createKVStore(pool) };

  /* Tally kill-code redemptions per account. */
  const rows = await env.MARKETPLACE.listValues({ prefix: 'item_code_' });
  const tally = new Map();          // userId -> count
  let codesSeen = 0;
  for (const { value: rec } of rows) {
    if (!isRaidKillCode(rec && rec.item)) continue;
    const redeemers = Array.isArray(rec.redeemedBy) ? rec.redeemedBy : [];
    if (!redeemers.length) continue;
    codesSeen++;
    for (const uid of redeemers) {
      const k = String(uid);
      tally.set(k, (tally.get(k) || 0) + 1);
    }
  }

  line('');
  line(`  database   ${dbName}${dbName.endsWith('-dev') ? '  (dev — pass --service for production)' : ''}`);
  line(`  codes      ${codesSeen} redeemed raid kill code(s)`);
  line(`  accounts   ${tally.size} to reconcile`);
  const totalRedemptions = [...tally.values()].reduce((n, c) => n + c, 0);
  line(`  redeems    ${totalRedemptions} total (sum of per-account counts)`);
  line('');
  for (const [uid, c] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
    line(`     ${uid.padEnd(14)} ${c} redeem${c === 1 ? '' : 's'}`);
  }
  line('');

  if (!tally.size) {
    line('  Nothing to reconcile.');
    line('');
    await pool.end();
    return;
  }

  if (!has('confirm')) {
    line('  Dry run — nothing written. Re-run with --confirm to backfill.');
    line('');
    await pool.end();
    return;
  }

  let tiersGranted = 0, junkRemoved = 0;
  for (const [uid, c] of tally) {
    const granted = await backfillRaidKills(env, uid, c);
    if (granted.length) {
      tiersGranted += granted.length;
      line(`  ${uid}: count→${c}, granted ${granted.map(t => t.id.replace('undead-executioner-', '')).join(', ')}`);
    }
    const removed = await cleanupOneOffs(env, uid);
    junkRemoved += removed;
  }
  await pool.end();

  line('');
  line(`  DONE. ${tiersGranted} tier badge(s) granted across ${tally.size} account(s); ${junkRemoved} old one-off badge(s) removed.`);
  line('');
}

main().catch((err) => {
  console.error('[backfill-raid-kills] FAILED:', err.message);
  process.exit(1);
});
