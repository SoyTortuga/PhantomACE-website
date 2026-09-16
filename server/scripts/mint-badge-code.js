#!/usr/bin/env node
/* ══════════════════════════════════════════════
   Mint a public, long-lived item code for a BADGE.

   Usage (dry run prints the plan and writes nothing):
     node server/scripts/mint-badge-code.js --badge dino-park-beta
     node server/scripts/mint-badge-code.js --badge dino-park-beta --confirm

     --days N        how long the code stays claimable (default 7)
     --service phantomace-web
                     read DATABASE_URL from that Windows service's own
                     environment rather than server/.env, so a dev .env
                     cannot send this at the wrong database
     --list          show the badges this script knows about and exit

   HOW THIS DIFFERS FROM A DROP CODE. A drop lives five minutes and is meant
   to be caught. This is the opposite: PUBLIC (no restrictedTo, so anyone who
   sees it in chat can use it), claimable ONCE PER ACCOUNT via the code
   record's redeemedBy list, and alive for days rather than minutes. Nothing
   new is needed for any of that — createItemCode() already omits the
   restriction for a public code and activateItemCode() takes a duration in
   seconds. The only reason this script exists is that seven days in seconds
   is not a number anyone should be typing by hand at 2am.

   The code is NOT posted to chat. Announcing is a separate, deliberate act —
   this prints the message to paste, or use the Bot Control panel.
   ══════════════════════════════════════════════ */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

import { createPool, waitForDatabase } from '../lib/db.js';
import { createKVStore } from '../lib/kv.js';
import { resolveDatabaseUrl } from '../lib/service-env.js';
import { createItemCode, activateItemCode } from '../../functions/api/item-codes.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');

/* Badges this script can mint. Adding one here is the deliberate step: the
   artwork path is checked against the repo before anything is written, so a
   typo cannot mint a code for a badge that renders as a broken image. */
const BADGES = {
  'dino-park-beta': {
    id: 'dino-park-beta',
    game: 'profile',
    type: 'badge',
    name: 'Dino Park Beta',
    rarity: 'rare',
    image: '/assets/badges/dino-park-beta.png',
    blurb: 'For everyone who broke Dino Park before it was finished.',
  },

  'agate-hunt': {
    id: 'agate-hunt',
    game: 'profile',
    type: 'badge',
    name: 'Agate Hunt',
    rarity: 'rare',
    image: '/assets/badges/agate-hunt.png',
    blurb: 'For everyone who came rock hunting.',
  },
  'mtgbbb-winner': {
    name: 'Booster Box Bingo Champion',
    description: 'Won a game of MTGBBB while a sealed box was cracked on stream.',
    rarity: 'mythic',
    image: '/assets/badges/mtgbbb-winner.png',
  },
};

function arg(name, fallback = null) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return (next && !next.startsWith('--')) ? next : true;
}
const has = (name) => process.argv.includes('--' + name);

async function main() {
  if (has('list')) {
    console.log('\nBadges this script can mint:\n');
    for (const [key, b] of Object.entries(BADGES)) {
      console.log(`  ${key.padEnd(20)} ${b.name} (${b.rarity})  ${b.image}`);
    }
    console.log('');
    return;
  }

  const key = arg('badge');
  if (!key || key === true) {
    console.error('Which badge? Pass --badge <name>, or --list to see them.');
    process.exit(1);
  }
  const badge = BADGES[key];
  if (!badge) {
    console.error(`Unknown badge "${key}". Run with --list.`);
    process.exit(1);
  }

  /* The artwork has to exist on disk. A code minted against a missing file
     grants a badge that renders as nothing, and by the time anyone notices
     it is already in inventories. */
  const artPath = path.join(REPO, badge.image.replace(/^\//, ''));
  if (!existsSync(artPath)) {
    console.error(`Artwork missing: ${artPath}`);
    console.error('Add the file before minting — a code cannot be un-granted.');
    process.exit(1);
  }

  const days = Number(arg('days', 7));
  if (!Number.isFinite(days) || days <= 0 || days > 90) {
    console.error('--days must be between 1 and 90.');
    process.exit(1);
  }
  const seconds = Math.round(days * 24 * 60 * 60);

  const service = arg('service');
  const databaseUrl = resolveDatabaseUrl({ service, fallback: arg('database-url') });
  if (!databaseUrl) {
    console.error('No DATABASE_URL. Pass --service phantomace-web, or set it in server/.env.');
    process.exit(1);
  }
  const dbName = (databaseUrl.split('/').pop() || '').split('?')[0];

  console.log('');
  console.log(`  badge     ${badge.name} (${badge.rarity})`);
  console.log(`  artwork   ${badge.image}`);
  console.log(`  claimable ${days} day${days === 1 ? '' : 's'}, once per account, by anyone`);
  console.log(`  database  ${dbName}`);
  console.log('');

  if (dbName.endsWith('-dev')) {
    console.log('  NOTE: this is the dev database. Pass --service for production.');
    console.log('');
  }

  if (!has('confirm')) {
    console.log('  Dry run — nothing written. Re-run with --confirm to mint.');
    console.log('');
    return;
  }

  const pool = createPool(databaseUrl);
  await waitForDatabase();
  const env = { MARKETPLACE: createKVStore(pool) };

  const record = await createItemCode(env, {
    id: badge.id,
    game: badge.game,
    type: badge.type,
    name: badge.name,
    rarity: badge.rarity,
    image: badge.image,
  });

  const active = await activateItemCode(env, record.code, seconds);
  await pool.end();

  const until = new Date(active.expiresAt);
  console.log(`  CODE      ${active.code}`);
  console.log(`  expires   ${until.toUTCString()}`);
  console.log('');
  console.log('  Post in chat:');
  console.log('');
  console.log(`    ${badge.blurb} Claim the ${badge.name} badge at ` +
              `phantomace.tv/redeem with code ${active.code} — open to everyone ` +
              `for the next ${days} days, one per account.`);
  console.log('');
}

main().catch((err) => {
  console.error('[mint-badge-code] FAILED:', err.message);
  process.exit(1);
});
