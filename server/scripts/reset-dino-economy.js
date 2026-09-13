#!/usr/bin/env node
/* ══════════════════════════════════════════════
   Reset the Dino Park ECONOMY in Cloudflare KV.

   Usage:
     node server/scripts/reset-dino-economy.js <namespace-id> <backup.ndjson>
     node server/scripts/reset-dino-economy.js <namespace-id> <backup.ndjson> --confirm

   Without --confirm it changes nothing and only reports what it would do.
   The backup is written in BOTH modes, before anything is deleted.

   WHAT THIS DOES AND DOES NOT DO
   ------------------------------
   Clears the parts of Dino Park's economy that live only on the server and
   therefore cannot be reset from the client:

     listing_*      every live marketplace listing (player dinos for sale)
     earnings_*     coin balances accrued from sales
     market_index   the listing index, so no phantom entries survive
     inv_*          Dino Park items only, surgically — other games' items
                    and all badges/titles in the same record are preserved

   It deliberately does NOT touch dino_park_* — the player saves themselves.
   Deleting those would reset nobody. The client treats "no cloud save but a
   local one exists" as a returning player and uploads the local save, so a
   server-side wipe restores itself from every player's browser. The actual
   reset is the SAVE_EPOCH bump in games/dino-park/index.html; the stale
   cloud records are overwritten by each client on its next load.

   ORDER MATTERS. Run this BEFORE deploying the SAVE_EPOCH bump. Clearing
   the marketplace first means there is nothing to buy and nowhere to sell
   during the gap. The reverse order leaves a window where players hold
   freshly reset parks while pre-reset dinos are still on sale.

   WRITE THE BACKUP OUTSIDE THE REPO. It contains player-owned inventory
   records.
   ══════════════════════════════════════════════ */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const run = promisify(execFile);
const IS_WIN = process.platform === 'win32';

const DINO_GAME_TAG = 'dino-park';

/* Same indirection as dump-kv.js: Node will not execFile a .cmd on Windows,
   and shell:true mangles the argv so wrangler never receives a usable
   namespace id and misreports it as an auth error. */
async function wrangler(args) {
  const cmd = IS_WIN ? 'cmd.exe' : 'wrangler';
  const argv = IS_WIN ? ['/c', 'wrangler.cmd', ...args] : args;
  const { stdout } = await run(cmd, argv, {
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}

/* --remote is mandatory on every call. Without it wrangler reads a LOCAL
   simulated store and reports results that look real but are not — which
   previously led to a confident, wrong conclusion that production KV was
   empty. */
function ns(nsId) {
  return [`--namespace-id=${nsId}`, '--remote'];
}

async function getValue(nsId, key) {
  try {
    return await wrangler(['kv', 'key', 'get', key, ...ns(nsId)]);
  } catch {
    return null; // expected for a key that expired between list and read
  }
}

async function main() {
  const [nsId, backupPath, ...rest] = process.argv.slice(2);
  const confirm = rest.includes('--confirm');

  if (!nsId || !backupPath) {
    console.error('usage: node reset-dino-economy.js <namespace-id> <backup.ndjson> [--confirm]');
    process.exit(2);
  }
  if (fs.existsSync(backupPath)) {
    console.error(`[reset] refusing to overwrite an existing backup: ${backupPath}`);
    process.exit(2);
  }

  console.log('[reset] listing keys...');
  const listed = JSON.parse(await wrangler(['kv', 'key', 'list', ...ns(nsId)]));
  const names = listed.map(k => k.name);

  const listings  = names.filter(n => n.startsWith('listing_'));
  const earnings  = names.filter(n => n.startsWith('earnings_'));
  const index     = names.filter(n => n === 'market_index');
  const inventories = names.filter(n => n.startsWith('inv_'));

  console.log(`[reset] ${names.length} keys total`);
  console.log(`          ${String(listings.length).padStart(4)}  listing_*      -> delete`);
  console.log(`          ${String(earnings.length).padStart(4)}  earnings_*     -> delete`);
  console.log(`          ${String(index.length).padStart(4)}  market_index   -> delete`);
  console.log(`          ${String(inventories.length).padStart(4)}  inv_*          -> strip ${DINO_GAME_TAG} items`);
  console.log(`          ${String(names.filter(n => n.startsWith('dino_park_')).length).padStart(4)}  dino_park_*    -> LEFT ALONE (see header)`);

  // ── back up everything we are about to touch, first ────────────────────
  const affected = [...listings, ...earnings, ...index, ...inventories];
  const out = fs.createWriteStream(backupPath, { flags: 'wx' });
  let backedUp = 0;
  for (const key of affected) {
    const value = await getValue(nsId, key);
    if (value === null) continue;
    out.write(JSON.stringify({ name: key, value }) + '\n');
    backedUp++;
  }
  await new Promise(res => out.end(res));
  console.log(`[reset] backed up ${backedUp} of ${affected.length} key(s) to ${backupPath}`);

  // ── work out the inventory edits before changing anything ──────────────
  const invEdits = [];
  for (const key of inventories) {
    const raw = await getValue(nsId, key);
    if (!raw) continue;
    let inv;
    try { inv = JSON.parse(raw); } catch {
      console.warn(`[reset] ${key}: unparseable, SKIPPING rather than guessing`);
      continue;
    }
    const before = Array.isArray(inv.items) ? inv.items.length : 0;
    const items = (inv.items || []).filter(i => i && i.game !== DINO_GAME_TAG);
    const hadEquips = !!(inv.equips && inv.equips[DINO_GAME_TAG]);
    if (items.length === before && !hadEquips) continue;

    const next = { ...inv, items };
    if (next.equips) { next.equips = { ...next.equips }; delete next.equips[DINO_GAME_TAG]; }
    invEdits.push({ key, removed: before - items.length, hadEquips, value: JSON.stringify(next) });
  }
  for (const e of invEdits) {
    console.log(`[reset] ${e.key}: -${e.removed} ${DINO_GAME_TAG} item(s)${e.hadEquips ? ', clearing equips' : ''}`);
  }

  if (!confirm) {
    console.log('');
    console.log('[reset] DRY RUN — nothing was changed. Re-run with --confirm to apply.');
    console.log('[reset] Remember: run this BEFORE deploying the SAVE_EPOCH bump.');
    return;
  }

  // ── apply ──────────────────────────────────────────────────────────────
  /* Deleted one at a time rather than via `kv bulk delete`. The key count
     here is ~20, so the extra process spawns cost a second or two, and in
     exchange every deletion is individually visible and individually
     recoverable if one fails partway through. */
  let deleted = 0;
  for (const key of [...listings, ...earnings, ...index]) {
    await wrangler(['kv', 'key', 'delete', key, ...ns(nsId), '--force']);
    deleted++;
    console.log(`[reset] deleted ${key}`);
  }

  let rewritten = 0;
  for (const e of invEdits) {
    /* Written via --path. Passing a JSON document as a command-line
       argument invites quoting corruption on Windows, and a corrupted
       inventory write would destroy badges and items belonging to other
       games that this reset is supposed to preserve. */
    const tmp = path.join(os.tmpdir(), `phamreset_${Date.now()}_${rewritten}.json`);
    fs.writeFileSync(tmp, e.value, 'utf8');
    try {
      await wrangler(['kv', 'key', 'put', e.key, `--path=${tmp}`, ...ns(nsId)]);
      rewritten++;
      console.log(`[reset] rewrote ${e.key}`);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }

  console.log('');
  console.log(`[reset] done: ${deleted} deleted, ${rewritten} inventory record(s) rewritten`);
  console.log(`[reset] backup: ${backupPath}`);
  console.log('[reset] NEXT: deploy the SAVE_EPOCH bump so player saves reset too.');
  console.log('[reset] Until that deploy lands, players keep their old parks.');
}

main().catch(err => {
  console.error('[reset] FAILED:', err.message);
  console.error('[reset] Check the backup file before retrying — a partial run is');
  console.error('[reset] safe to repeat, since deletes and rewrites are idempotent.');
  process.exit(1);
});
