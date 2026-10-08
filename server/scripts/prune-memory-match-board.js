#!/usr/bin/env node
/* ══════════════════════════════════════════════
   RESET THE MEMORY MATCH LEADERBOARDS BEFORE THE NOV 1 PAYOUT

     node server/scripts/prune-memory-match-board.js --service phantomace-web
     node server/scripts/prune-memory-match-board.js --service phantomace-web --confirm

   Memory Match games are now dealt and checked by the server
   (functions/api/memory-match.js), and lb_memory_match / _15 / _10 are
   serverOnly. Every entry sitting on lb_memory_match today was written by the
   OLD client, which submitted its own move count — unverifiable, and therefore
   not safe to let win the monthly award that settles on 2026-11-01 PT.

   This overwrites the three Memory Match board keys with an empty list. The
   rows stay in place; the boards simply start empty and re-fill with
   server-dealt scores over the rest of the month. Nothing else is touched.
   Dry run unless --confirm.
   ══════════════════════════════════════════════ */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

import { createPool, waitForDatabase } from '../lib/db.js';
import { createKVStore } from '../lib/kv.js';
import { resolveDatabaseUrl } from '../lib/service-env.js';

const KEYS = ['lb_memory_match', 'lb_memory_match_15', 'lb_memory_match_10'];
const line = (s = '') => console.log(s);

function arg(name, fallback = null) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return process.argv.includes(`--${name}`) ? true : fallback;
}

async function main() {
  const confirm = arg('confirm') === true;

  const databaseUrl = resolveDatabaseUrl({ service: arg('service'), fallback: arg('database-url') });
  if (!databaseUrl) { console.error('[reset-mm] No DATABASE_URL. Use --service phantomace-web.'); process.exit(2); }

  const pool = createPool(databaseUrl);
  const info = await waitForDatabase();
  line(`Database: ${info.db}`);
  line('');

  const kv = createKVStore(pool);
  let total = 0;
  const nonEmpty = [];
  for (const key of KEYS) {
    let board = null;
    try { board = await kv.get(key, 'json'); } catch { board = null; }
    const n = Array.isArray(board) ? board.length : 0;
    line(`  ${key.padEnd(22)} ${n} entr${n === 1 ? 'y' : 'ies'}`);
    if (n > 0) { nonEmpty.push(key); total += n; }
  }
  line('');
  line(`Boards with entries: ${nonEmpty.length}; entries to clear: ${total}`);

  if (!nonEmpty.length) { line('All Memory Match boards are already empty. Nothing to do.'); await pool.end(); return; }
  if (!confirm) { line('DRY RUN — nothing written. Re-run with --confirm.'); await pool.end(); return; }

  /* Written through mutate() for the lock, not to preserve anything: the
     mutator returns [] regardless, so a score landing between the count above
     and this write IS discarded. That is the intent — the whole point is that
     nothing written before the reset survives it — but it is worth saying
     plainly rather than implying a safety that is not there. Anyone caught by
     it can simply play again; the month has weeks left. */
  for (const key of nonEmpty) {
    await kv.mutate(key, () => []);
    line(`cleared ${key}`);
  }
  line('');
  line(`Reset ${nonEmpty.length} Memory Match board(s) to empty. They will re-fill with server-dealt scores.`);
  await pool.end();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error('[reset-mm]', err.message); process.exit(1); });
}
