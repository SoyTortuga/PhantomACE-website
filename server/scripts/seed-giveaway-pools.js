#!/usr/bin/env node
/* ══════════════════════════════════════════════
   Fill the giveaway code pools.

   Usage:
     node server/scripts/seed-giveaway-pools.js
     node server/scripts/seed-giveaway-pools.js --confirm
     node server/scripts/seed-giveaway-pools.js --confirm --database-url=...

   WHY THIS MATTERS MORE THAN IT LOOKS
   hype-train.js pulls codes and returns early if it gets none — no chat
   message, no drop record, no log line. An empty pool therefore made a hype
   train do NOTHING AT ALL, with no error anywhere to explain it. The pools
   have been empty since the migration, so every drop so far would have
   silently failed.

   The running server now tops pools up on its own, including from empty, so
   this script is really about doing the first fill deliberately and being
   able to see the result rather than discovering it mid-stream.

   The codes in _private/giveaway-codes/*.txt are NOT used and must not be:
   they were publicly downloadable from the site until 2026-09-13. Everything
   here is freshly minted.
   ══════════════════════════════════════════════ */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

import { createPool, waitForDatabase } from '../lib/db.js';
import { createKVStore } from '../lib/kv.js';

const TIERS = ['common', 'uncommon', 'rare', 'mythic'];

function parseArgs() {
  const args = process.argv.slice(2);
  const urlArg = args.find(a => a.startsWith('--database-url='));
  return {
    confirm: args.includes('--confirm'),
    databaseUrl: urlArg ? urlArg.slice('--database-url='.length) : process.env.DATABASE_URL,
  };
}

function table(levels) {
  console.log('         tier        available   total   target   low-water');
  for (const t of TIERS) {
    const l = levels[t];
    console.log(
      `         ${t.padEnd(12)}${String(l.available).padStart(6)}${String(l.total).padStart(9)}` +
      `${String(l.target).padStart(9)}${String(l.low).padStart(11)}`
    );
  }
}

async function main() {
  const { confirm, databaseUrl } = parseArgs();
  if (!databaseUrl) {
    console.error('[pools] No DATABASE_URL. Set it in server/.env or pass --database-url=');
    process.exit(2);
  }

  const pool = createPool(databaseUrl);
  const info = await waitForDatabase();
  console.log(`[pools] connected: ${info.db}`);
  console.log('');

  const store = createKVStore(pool);

  console.log('[pools] BEFORE');
  const before = await store.giveawayPoolLevels();
  table(before);
  console.log('');

  if (!confirm) {
    const wanted = TIERS
      .filter(t => before[t].available < before[t].target)
      .map(t => `${t} +${before[t].target - before[t].available}`);
    console.log(wanted.length
      ? `[pools] would mint: ${wanted.join(', ')}`
      : '[pools] every tier is already at target — nothing to do');
    console.log('[pools] DRY RUN — nothing written. Re-run with --confirm.');
    await pool.end().catch(() => {});
    return;
  }

  let total = 0;
  for (const tier of TIERS) {
    /* force:true so a tier sitting above its low-water mark but below target
       still gets filled. The automatic top-up deliberately waits for the
       low-water mark; an explicit seed should not. */
    const added = await store.topUpGiveawayCodes(tier, true);
    total += added;
    console.log(`[pools] ${tier.padEnd(10)} +${added}`);
  }

  console.log('');
  console.log('[pools] AFTER');
  table(await store.giveawayPoolLevels());
  console.log('');
  console.log(`[pools] minted ${total} code(s).`);
  console.log('[pools] These are never printed anywhere — a code is revealed only when it');
  console.log('[pools] is dropped into chat, and is claimable for 5 minutes after that.');

  await pool.end().catch(() => {});
}

main().catch(err => {
  console.error('[pools] FAILED:', err.message);
  process.exit(1);
});
