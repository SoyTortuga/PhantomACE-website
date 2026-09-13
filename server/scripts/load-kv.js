#!/usr/bin/env node
/* ══════════════════════════════════════════════
   Load a KV dump (from dump-kv.js) into Postgres.

   Usage:
     node server/scripts/load-kv.js <dump.ndjson> [--database-url=...]

   IDEMPOTENT AND RE-RUNNABLE — every write is an upsert, which is what makes
   a full dry-run cutover possible: load into production ahead of time,
   verify, then re-run for real at the cutover and simply overwrite.

   Routing uses lib/registry.js, the same module the runtime DAL uses, so a
   value can never be written to one table and read from another.

   Keys the registry doesn't recognise are NOT silently dropped — they land
   in unmapped_kv and make this script exit non-zero, because an unrecognised
   key family is exactly the kind of thing that gets noticed only after the
   old store is gone.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import pg from 'pg';
import 'dotenv/config';
import { resolveKey, SPECIAL_MIGRATION_KEYS } from '../lib/registry.js';
import { toStorable } from '../lib/value.js';

const { Pool } = pg;

function arg(name, fallback) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

async function main() {
  const dumpPath = process.argv[2];
  const databaseUrl = arg('database-url', process.env.DATABASE_URL);
  if (!dumpPath || !databaseUrl) {
    console.error('usage: node load-kv.js <dump.ndjson> [--database-url=...]');
    console.error('(or set DATABASE_URL in server/.env)');
    process.exit(2);
  }

  const rows = fs.readFileSync(dumpPath, 'utf8')
    .split('\n').filter(Boolean).map(l => JSON.parse(l));
  console.log(`[load] ${rows.length} keys from ${dumpPath}`);
  console.log(`[load] target: ${databaseUrl.replace(/:[^:@/]+@/, ':***@')}`);

  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const discard = new Set(SPECIAL_MIGRATION_KEYS.discard);
  const { giveawayPoolPrefix, giveawayCursorPrefix, monthlyAwardPrefix } = SPECIAL_MIGRATION_KEYS;

  const stats = { tables: {}, discarded: 0, giveawayCodes: 0, monthlyAwards: 0, unmapped: 0 };
  const pools = new Map();     // tier -> codes[]
  const cursors = new Map();   // tier -> next index

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const row of rows) {
      const { name, value, expiration } = row;

      if (discard.has(name)) {
        // market_index was an artefact of KV's eventually-consistent list();
        // the listings rows are the truth and Postgres has real transactions.
        stats.discarded++;
        continue;
      }

      // gc_ptr_{tier} must be read before gc_{tier} is written, so collect
      // both and resolve after the loop.
      if (name.startsWith(giveawayCursorPrefix)) {
        cursors.set(name.slice(giveawayCursorPrefix.length), parseInt(JSON.parse(value) ?? value, 10) || 0);
        continue;
      }
      if (name.startsWith(giveawayPoolPrefix)) {
        pools.set(name.slice(giveawayPoolPrefix.length), JSON.parse(value));
        continue;
      }

      if (name.startsWith(monthlyAwardPrefix)) {
        await client.query(
          `INSERT INTO monthly_awards (month) VALUES ($1) ON CONFLICT (month) DO NOTHING`,
          [name.slice(monthlyAwardPrefix.length)]
        );
        stats.monthlyAwards++;
        continue;
      }

      const target = resolveKey(name);
      if (!target) {
        await client.query(
          `INSERT INTO unmapped_kv (key, value, expiration) VALUES ($1,$2,$3)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
          [name, value, expiration ?? null]
        );
        stats.unmapped++;
        continue;
      }

      // Expiry policy comes from the registry, NOT the dump: families whose
      // TTL was only storage hygiene get NULL even though KV reported one.
      const expiresAt = target.expiry === 'real' && expiration
        ? new Date(expiration * 1000)
        : null;

      await client.query(
        `INSERT INTO ${target.table} (key, value, expires_at, updated_at)
         VALUES ($1, $2::jsonb, $3, now())
         ON CONFLICT (key) DO UPDATE
           SET value = EXCLUDED.value,
               expires_at = EXCLUDED.expires_at,
               updated_at = now()`,
        [name, JSON.stringify(toStorable(value)), expiresAt]
      );
      stats.tables[target.table] = (stats.tables[target.table] || 0) + 1;
    }

    // gc_{tier} array + gc_ptr_{tier} cursor  ->  giveaway_codes rows.
    // Codes BELOW the cursor were already handed out and are marked claimed;
    // the rest stay available. Getting this wrong either re-issues codes
    // people already have or silently burns unused ones.
    for (const [tier, codes] of pools) {
      const cursor = cursors.get(tier) ?? 0;
      for (let i = 0; i < codes.length; i++) {
        await client.query(
          `INSERT INTO giveaway_codes (tier, code, claimed_at)
           VALUES ($1,$2,$3)
           ON CONFLICT (tier, code) DO UPDATE SET claimed_at = EXCLUDED.claimed_at`,
          [tier, codes[i], i < cursor ? new Date() : null]
        );
        stats.giveawayCodes++;
      }
      console.log(`[load] ${tier}: ${codes.length} codes, cursor ${cursor} -> ${cursor} claimed`);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  console.log('[load] rows per table:');
  for (const [t, c] of Object.entries(stats.tables).sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(c).padStart(5)}  ${t}`);
  }
  if (stats.giveawayCodes) console.log(`   ${String(stats.giveawayCodes).padStart(5)}  giveaway_codes`);
  if (stats.monthlyAwards) console.log(`   ${String(stats.monthlyAwards).padStart(5)}  monthly_awards`);
  if (stats.discarded) console.log(`   ${String(stats.discarded).padStart(5)}  (discarded by design)`);

  await pool.end();

  if (stats.unmapped) {
    console.error(`\n[load] FAILED: ${stats.unmapped} key(s) had no table mapping and were`);
    console.error('parked in unmapped_kv. Add them to lib/registry.js and re-run.');
    console.error('Do NOT cut over with unmapped keys outstanding.');
    process.exit(1);
  }
  console.log('\n[load] OK');
}

main().catch(err => { console.error('[load] fatal:', err); process.exit(1); });
