#!/usr/bin/env node
/* ══════════════════════════════════════════════
   GRANT A BADGE TO EVERYONE WHO ALREADY REDEEMED ITS CODE

     node server/scripts/grant-badge-from-codes.js --service phantomace-web
     node server/scripts/grant-badge-from-codes.js --service phantomace-web --confirm

   Remediation for the Undead Executioner badge codes that redeemed without
   actually granting a usable badge (the codes lacked type:'badge'; see
   mint-badge-code.js). Every item code stores a `redeemedBy` list, so the
   accounts that claimed those codes are known. This reads that list and grants
   the CORRECT badge — the exact shape a raid-earned copy has (raid-badges.js)
   — to each of them, idempotently: an account that already holds the badge
   (earned, or from a good code) is left untouched.

   WHICH CODES:
     (default)         every item code whose item.id is an Undead Executioner
                       tier is matched, and its redeemers granted that tier.
     --badge <id>      only that tier (e.g. undead-executioner-gold), and — if
                       combined with --code — grant that tier regardless of what
                       the code's own (possibly malformed) item.id says.
     --code CODE       only this one code. Use with --badge when the broken
                       code's stored item.id is wrong and can't be inferred.

   Dry run unless --confirm: it prints exactly who would be granted what.
   ══════════════════════════════════════════════ */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

import { createPool, waitForDatabase } from '../lib/db.js';
import { createKVStore } from '../lib/kv.js';
import { resolveDatabaseUrl } from '../lib/service-env.js';
import { RAID_REDEMPTION_TIERS } from '../../functions/api/raid-badges.js';

const line = (s = '') => console.log(s);
function arg(name, fallback = null) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return process.argv.includes(`--${name}`) ? true : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const TIER_BY_ID = new Map(RAID_REDEMPTION_TIERS.map(t => [t.id, t]));

/** The inventory item a granted badge must be — identical to raid-badges.js's
    awardTiersUpTo(), so a coded copy and an earned copy are the same thing. */
function badgeItem(tier) {
  return {
    id: tier.id, game: tier.game, type: 'badge', name: tier.name, rarity: tier.rarity,
    consumable: false, quantity: 1, grantedAt: Date.now(), source: 'code-backfill',
    meta: { image: tier.image },
  };
}

/** Grant one tier to one account, only if not already held. Returns true if
    it actually added the badge. Idempotent and safe to re-run. */
async function grantOnce(env, userId, tier) {
  let added = false;
  await env.MARKETPLACE.mutate(`inv_${userId}`, (current) => {
    const inv = current || { userId: String(userId), items: [], equips: {} };
    if (!Array.isArray(inv.items)) inv.items = [];
    if (inv.items.some(i => i && i.id === tier.id && i.type === 'badge')) return undefined;
    inv.items.push(badgeItem(tier));
    added = true;
    return inv;
  });
  return added;
}

async function main() {
  const onlyBadge = arg('badge');
  if (onlyBadge && onlyBadge !== true && !TIER_BY_ID.has(onlyBadge)) {
    line(`Unknown --badge "${onlyBadge}". Known tiers:`);
    for (const t of RAID_REDEMPTION_TIERS) line(`  ${t.id}`);
    process.exit(1);
  }
  const onlyCode = arg('code');
  const forcedTier = (onlyBadge && onlyBadge !== true) ? TIER_BY_ID.get(onlyBadge) : null;

  const databaseUrl = resolveDatabaseUrl({ service: arg('service'), fallback: arg('database-url') });
  if (!databaseUrl) {
    line('No DATABASE_URL. Pass --service phantomace-web, or set it in server/.env.');
    process.exit(1);
  }
  const dbName = (databaseUrl.split('/').pop() || '').split('?')[0];

  const pool = createPool(databaseUrl);
  await waitForDatabase();
  const env = { MARKETPLACE: createKVStore(pool) };

  /* Which code records to look at. */
  let records;
  if (onlyCode && onlyCode !== true) {
    const rec = await env.MARKETPLACE.get(`item_code_${String(onlyCode).toUpperCase()}`, 'json');
    records = rec ? [rec] : [];
    if (!rec) line(`No code record found for ${onlyCode}.`);
  } else {
    /* listValues returns { name, value } rows — unwrap to the code records. */
    const rows = await env.MARKETPLACE.listValues({ prefix: 'item_code_' });
    records = rows.map(r => r.value);
  }

  /* Build the work list: (userId, tier) pairs, deduped. */
  const work = new Map();          // userId -> Set of tierId
  const codesMatched = [];
  for (const rec of records) {
    if (!rec || !rec.item) continue;
    const tier = forcedTier || TIER_BY_ID.get(rec.item.id);
    if (!tier) continue;           // not an Undead Executioner badge code (or id unknown and no --badge)
    const redeemers = Array.isArray(rec.redeemedBy) ? rec.redeemedBy : [];
    if (!redeemers.length) continue;
    codesMatched.push({ code: rec.code, tier: tier.id, redeemers: redeemers.length });
    for (const uid of redeemers) {
      if (!work.has(String(uid))) work.set(String(uid), new Set());
      work.get(String(uid)).add(tier.id);
    }
  }

  line('');
  line(`  database   ${dbName}${dbName.endsWith('-dev') ? '  (dev — pass --service for production)' : ''}`);
  line(`  codes      ${codesMatched.length} matched`);
  for (const c of codesMatched) line(`               ${c.code}  →  ${c.tier}  (${c.redeemers} redeemer${c.redeemers === 1 ? '' : 's'})`);
  const totalGrants = [...work.values()].reduce((n, s) => n + s.size, 0);
  line(`  accounts   ${work.size}  (${totalGrants} badge grant${totalGrants === 1 ? '' : 's'} to check)`);
  line('');

  if (!codesMatched.length) {
    line('  Nothing to do. If a broken code stored a wrong item.id, pass --code CODE --badge <tier>.');
    line('');
    await pool.end();
    return;
  }

  if (!has('confirm')) {
    line('  Dry run — nothing written. Re-run with --confirm to grant.');
    line('');
    await pool.end();
    return;
  }

  let granted = 0, alreadyHad = 0;
  for (const [uid, tierIds] of work) {
    for (const tid of tierIds) {
      const ok = await grantOnce(env, uid, TIER_BY_ID.get(tid));
      if (ok) { granted++; line(`  granted   ${tid}  →  ${uid}`); }
      else alreadyHad++;
    }
  }
  await pool.end();

  line('');
  line(`  DONE. ${granted} granted, ${alreadyHad} already held (left as-is).`);
  line('');
}

main().catch((err) => {
  console.error('[grant-badge-from-codes] FAILED:', err.message);
  process.exit(1);
});
