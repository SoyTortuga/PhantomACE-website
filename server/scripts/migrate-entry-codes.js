#!/usr/bin/env node
/* ══════════════════════════════════════════════
   Credit the Phamily Time entry-codes people are already holding.

   Phamily Time used to grant giveaway rewards as an inventory item carrying
   a real code pulled from the giveaway pool. Nothing ever registered those
   codes as redeemable — only chat drops call registerDropCode — so the
   giveaway page told holders to "claim it in the box above" and the box
   always answered "invalid code".

   The site no longer works that way: rewards add entries to the monthly
   ledger directly. This credits the entries that were owed to everyone still
   holding one of the old items.

   Entries land in the CURRENT month. They were never spendable in the month
   they were earned, so there is no past total to correct — the only useful
   thing to do with them is make them count now.

   IDEMPOTENT. Each migrated item keeps its record with meta.code cleared and
   meta.creditedAt set; anything already carrying creditedAt is skipped. Safe
   to re-run, and safe to dry-run first (it does, unless you pass --confirm).

   The stranded codes are NOT returned to the pool, deliberately: the pool
   refills itself when it runs low, so they cost nothing but a few unused
   strings, and un-claiming a code somebody has already seen in their
   inventory is not worth the care it would need.

   Usage:
     node server/scripts/migrate-entry-codes.js --service phantomace-web
     node server/scripts/migrate-entry-codes.js --service phantomace-web --confirm
   ══════════════════════════════════════════════ */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

import { createPool, waitForDatabase } from '../lib/db.js';
import { createKVStore } from '../lib/kv.js';
import { resolveDatabaseUrl } from '../lib/service-env.js';
import { addEntries, monthKey } from '../../functions/api/giveaway-entries.js';

function arg(name, fallback = null) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return process.argv.includes(`--${name}`) ? true : fallback;
}

/* An item owed entries: a Phamily Time entry-code that still carries a code
   and has not already been credited. The creditedAt check is what makes
   re-running safe. Exported so both halves can be tested without a database
   — getting this predicate wrong either double-credits people or silently
   skips them, and neither is visible in the output. */
export const isDeadEntryCode = (item) =>
  !!(item && item.type === 'entry-code' && item.meta && item.meta.code && !item.meta.creditedAt);

/* Same table the rewards were minted from. */
const RARITY_ENTRIES = { common: 2, uncommon: 5, rare: 15, mythic: 50 };

/**
 * What one item is worth.
 *
 * meta.entries should always be set — the old mapper wrote it — but falling
 * back to 0 would mean an item with it missing gets marked credited having
 * delivered nothing, which is both silent and unrepeatable. Rarity is the
 * same number by another route.
 */
export function entriesFor(item) {
  const n = Number(item && item.meta && item.meta.entries);
  if (Number.isFinite(n) && n > 0) return n;
  return RARITY_ENTRIES[item && item.rarity] || RARITY_ENTRIES.common;
}

/** @returns {{key,userId,items,entries}[]} one row per account owed entries */
export function planMigration(rows) {
  const plan = [];
  for (const { key, value } of rows) {
    if (!value || !Array.isArray(value.items)) continue;
    const dead = value.items.filter(isDeadEntryCode);
    if (!dead.length) continue;
    plan.push({
      key,
      userId: value.userId || String(key).replace(/^inv_/, ''),
      items: dead,
      entries: dead.reduce((s, i) => s + entriesFor(i), 0),
    });
  }
  return plan;
}

/** The credited form of an inventory, used by the writer below. */
export function creditInventory(current, now) {
  if (!current || !Array.isArray(current.items)) return undefined;
  return {
    ...current,
    items: current.items.map(i => (isDeadEntryCode(i)
      ? { ...i, meta: { ...i.meta, code: null, creditedAt: now, creditedEntries: entriesFor(i) } }
      : i)),
  };
}

async function main() {
  const service = arg('service');
  const confirm = arg('confirm') === true;
  const databaseUrl = resolveDatabaseUrl({ service, fallback: arg('database-url') });

  if (!databaseUrl) {
    console.error('[migrate] No DATABASE_URL. Use --service phantomace-web.');
    process.exit(2);
  }

  const pool = createPool(databaseUrl);
  const info = await waitForDatabase();
  console.log(`Database: ${info.db}`);
  console.log(`Entries will be credited to: ${monthKey()}`);
  console.log('');

  const env = { MARKETPLACE: createKVStore(pool) };
  const rows = await env.MARKETPLACE.listValues({ prefix: 'inv_' });

  const plan = planMigration(rows);

  if (!plan.length) {
    console.log('Nothing to migrate — no uncredited entry-code items found.');
    await pool.end().catch(() => {});
    return;
  }

  let totalEntries = 0;
  let totalItems = 0;
  for (const p of plan) {
    totalEntries += p.entries;
    totalItems += p.items.length;
    console.log(`  ${String(p.userId).padEnd(12)} ${String(p.items.length).padStart(2)} item(s)  +${p.entries} entries`);
  }
  console.log('');
  console.log(`${plan.length} account(s), ${totalItems} item(s), ${totalEntries} entries total.`);

  if (!confirm) {
    console.log('');
    console.log('DRY RUN — nothing written. Re-run with --confirm.');
    await pool.end().catch(() => {});
    return;
  }

  console.log('');
  for (const p of plan) {
    /* Credit first, then mark. If this dies in between, the worst case is an
       account credited twice on a re-run — visible and correctable. Marking
       first would risk the opposite: items marked as credited whose entries
       were never actually added, which is silent and unrecoverable without
       knowing which accounts to look at. */
    const total = await addEntries(env, p.userId, '', p.entries, 'phamily:legacy entry codes');

    await env.MARKETPLACE.mutate(p.key, (current) => creditInventory(current, Date.now()));

    console.log(`  ${String(p.userId).padEnd(12)} +${p.entries} → ${total} entries this month`);
  }

  console.log('');
  console.log('Done. Re-running is safe — credited items are skipped.');
  await pool.end().catch(() => {});
}

/* Only when run directly, so the exported helpers above can be imported by a
   test without the script connecting to a database and migrating anything. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error('[migrate] FAILED:', err.message);
    process.exit(1);
  });
}
