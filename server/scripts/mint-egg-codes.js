#!/usr/bin/env node
/* ══════════════════════════════════════════════
   Mint Dino Park egg codes on demand.

   Usage:
     node server/scripts/mint-egg-codes.js --rarity rare --count 3
     node server/scripts/mint-egg-codes.js --rarity rare --count 3 --confirm
     node server/scripts/mint-egg-codes.js --rarity mythic --count 2 --mutation --confirm
     node server/scripts/mint-egg-codes.js --rarity rare --count 3 --restrict 53418405,77379157 --confirm

   Dry run unless --confirm. Refuses any database but phantomace-tv.

   THE ONE THING TO GET RIGHT: --restrict

   Without it a code is OPEN — redeemable once per account by ANYONE who sees
   it. Three open rare codes posted in chat is three rare eggs for every
   viewer who claims them, not three eggs in total. That is the right
   behaviour for a stream giveaway and very much the wrong one for "send
   these to a friend".

   With it, only the listed Twitch user ids can redeem, so a leaked code is
   inert. The compensation codes use this.

   Codes are created through the real createItemCode / activateItemCode paths
   so they cannot drift from what redemption expects.
   ══════════════════════════════════════════════ */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

import { createPool, waitForDatabase } from '../lib/db.js';
import { createKVStore } from '../lib/kv.js';
import { createItemCode, activateItemCode } from '../../functions/api/item-codes.js';

/* Site rarities the redemption path understands. 'mythic' rolls a random
   epic or legendary at redemption time; there is no direct epic/legendary. */
const RARITIES = ['common', 'uncommon', 'rare', 'mythic'];

function arg(name, fallback = null) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return process.argv.includes(`--${name}`) ? true : fallback;
}

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

async function main() {
  const rarity = String(arg('rarity', 'common')).toLowerCase();
  const count = Math.max(1, Math.min(50, parseInt(arg('count', '1'), 10) || 1));
  const days = Math.max(1, parseInt(arg('days', '30'), 10) || 30);
  const mutation = arg('mutation') === true;
  const confirm = arg('confirm') === true;
  const restrictRaw = arg('restrict', '');
  const databaseUrl = arg('database-url', process.env.DATABASE_URL);

  if (!RARITIES.includes(rarity)) {
    console.error(`[mint] --rarity must be one of: ${RARITIES.join(', ')}`);
    process.exit(2);
  }

  const restrictedTo = String(restrictRaw || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const badIds = restrictedTo.filter(id => !/^\d+$/.test(id));
  if (badIds.length) {
    console.error(`[mint] --restrict takes numeric Twitch user IDs. Not numeric: ${badIds.join(', ')}`);
    process.exit(2);
  }

  const label = mutation ? `${capitalize(rarity)} Mutation Dino Egg` : `${capitalize(rarity)} Dino Egg`;

  console.log(`[mint] ${count} x ${label}`);
  console.log(`[mint] valid for ${days} day(s)`);
  if (restrictedTo.length) {
    console.log(`[mint] LOCKED to ${restrictedTo.length} account(s): ${restrictedTo.join(', ')}`);
  } else {
    console.log('[mint] OPEN — redeemable once per account by ANYONE who sees the code.');
    console.log('[mint] That means one code can hand out one egg to every viewer who');
    console.log('[mint] claims it, not one egg in total. Use --restrict for named people.');
  }
  if (mutation) console.log('[mint] guaranteed mutation on hatch');
  console.log('');

  if (!confirm) {
    console.log('[mint] DRY RUN — nothing written. Re-run with --confirm.');
    return;
  }

  if (!databaseUrl) {
    console.error('[mint] No DATABASE_URL. Set it in server/.env or pass --database-url=');
    process.exit(2);
  }

  const pool = createPool(databaseUrl);
  const info = await waitForDatabase();
  console.log(`[mint] connected: ${info.db}`);

  if (!/phantomace-tv$/.test(info.db)) {
    console.error(`[mint] REFUSING: connected to "${info.db}", expected "phantomace-tv".`);
    process.exit(1);
  }

  const env = { ...process.env, MARKETPLACE: createKVStore(pool) };
  const made = [];

  for (let i = 0; i < count; i++) {
    const record = await createItemCode(env, {
      id: mutation ? 'dino_egg_mutation' : `dino_egg_${rarity}`,
      game: 'dino-park',
      type: 'egg',
      name: label,
      rarity,
      consumable: true,
      quantity: 1,
      guaranteedMutation: mutation,
    }, restrictedTo.length ? { restrictedTo } : {});

    /* Created codes are inactive by design — the drop flow activates them for
       five minutes. These have no drop, so activate here. */
    const active = await activateItemCode(env, record.code, days * 24 * 60 * 60);
    if (!active || !active.active) {
      console.error(`[mint] FAILED to activate ${record.code}; aborting.`);
      process.exit(1);
    }
    made.push(record.code);
  }

  console.log('');
  console.log('─'.repeat(46));
  for (const c of made) console.log(`  ${c}   ${label}`);
  console.log('─'.repeat(46));
  console.log(`Expires: ${new Date(Date.now() + days * 86400000).toISOString().slice(0, 10)}`);
  console.log('');
  console.log('Redeem at phantomace.tv/redeem (Twitch login required).');
  console.log(restrictedTo.length
    ? 'Account-locked, so safe to post anywhere — nobody else can use them.'
    : 'OPEN codes. Anyone who sees them can claim one each. Share deliberately.');

  await pool.end().catch(() => {});
}

main().catch(err => {
  console.error('[mint] FAILED:', err.message);
  process.exit(1);
});
