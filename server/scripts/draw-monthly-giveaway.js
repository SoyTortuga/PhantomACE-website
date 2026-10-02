#!/usr/bin/env node
/* Draw the big MONTHLY giveaway winner for a SPECIFIC month, from the rig.

   Bot Control's "Draw Monthly Winner" draws the current month, and "Draw Last
   Month" covers the previous month only during the grace window (days 1..7 of
   the new month, Pacific). This script is the rig-side escape hatch for any
   month: it draws that month's ledger and writes the SAME per-month record the
   panel writes (giveaway_monthly_winner_<YYYY-MM>, no expiry), so afterwards
   the Overlay Dashboard's "Replay last reveal (monthly)" and Bot Control's
   "Give Code to Winner" both work normally for that month.

     node server/scripts/draw-monthly-giveaway.js --service phantomace-web
     node server/scripts/draw-monthly-giveaway.js --service phantomace-web --confirm
     Optional: --month 2026-09  (defaults to the PREVIOUS month on the Pacific
               season calendar, functions/api/season-time.js)
     Optional: --force          re-draw a month whose code was ALREADY SENT
               (hands out a second prize — only when that is really intended)

   Dry-run unless --confirm. Re-running over an UNSENT winner re-rolls it (the
   replaced winner is kept in the record's history); over a SENT winner it is
   refused without --force. */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });
import { createPool, waitForDatabase } from '../lib/db.js';
import { createKVStore } from '../lib/kv.js';
import { resolveDatabaseUrl } from '../lib/service-env.js';
import { drawMonthlyWinner, buildWeightedReelPool } from '../../functions/api/giveaway-entries.js';
import { monthKey, prevMonthKey } from '../../functions/api/season-time.js';
import {
  readMonthlyWinner, storeMonthlyWinner, redrawRefusal, buildMonthlyWinnerRecord, monthlyWinnerKey,
} from '../../functions/api/bot/giveaway.js';

const arg = (n) => { const h = process.argv.find(a => a.startsWith(`--${n}=`)); if (h) return h.slice(n.length + 3); const i = process.argv.indexOf(`--${n}`); if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1]; return process.argv.includes(`--${n}`) || false; };

/**
 * Draw `month` against `env` and, when `confirm`, store it. Returns what
 * happened so the CLI (and tests) can report it.
 */
export async function runMonthlyDraw(env, { month = prevMonthKey(), confirm = false, force = false, rng } = {}) {
  if (!/^\d{4}-\d{2}$/.test(String(month))) return { status: 'bad-month', month };

  const existing = await readMonthlyWinner(env, month);
  /* The rig operator stands in for the broadcaster, so --force is honoured. */
  const refusal = redrawRefusal(existing, { force, broadcaster: true });
  if (refusal) return { status: 'refused', month, error: refusal.error, existing };

  const draw = await drawMonthlyWinner(env, { month, rng });
  if (!draw.winner) return { status: 'empty', month };

  const record = buildMonthlyWinnerRecord(draw, {
    currentMonth: monthKey(), previous: existing, buildReel: buildWeightedReelPool,
  });
  if (confirm) await storeMonthlyWinner(env, record);
  return { status: confirm ? 'stored' : 'dry-run', month, draw, record, existing };
}

async function main() {
  const service = arg('service'), confirm = arg('confirm') === true, force = arg('force') === true;
  const month = (typeof arg('month') === 'string' && arg('month')) || prevMonthKey();
  const url = resolveDatabaseUrl({ service, fallback: arg('database-url') });
  if (!url) { console.error('No DATABASE_URL. Use --service phantomace-web.'); process.exit(2); }
  const pool = createPool(url); const info = await waitForDatabase(); console.log('Database:', info.db);
  const env = { MARKETPLACE: createKVStore(pool) };

  console.log(`Drawing monthly giveaway for ${month} ...`);
  const r = await runMonthlyDraw(env, { month, confirm, force });

  if (r.status === 'bad-month') { console.error(`--month must be YYYY-MM, got "${month}".`); await pool.end(); process.exit(2); }
  if (r.status === 'refused') { console.error(`\nREFUSED: ${r.error}\nRe-run with --force only if a second prize is really intended.`); await pool.end(); process.exit(1); }
  if (r.status === 'empty') { console.log(`\nNobody (non-guest) entered in ${month} — nothing to draw.`); await pool.end(); return; }

  const { draw, existing } = r;
  console.log(`\nEntrants (${draw.totalPeople}, ${draw.totalEntries} entries total):`);
  for (const e of draw.entrants.slice(0, 20)) console.log(`   ${e.username || e.userId}  ${e.entries} entr${e.entries === 1 ? 'y' : 'ies'}`);
  if (existing) console.log(`\nReplacing the previous ${month} winner ${existing.username}${existing.sent ? ' (code ALREADY SENT — forced)' : ' (no code sent yet)'}.`);
  console.log(`\n>>> WINNER: ${draw.winner.username || draw.winner.userId}  (${draw.winner.entries} entries)`);

  if (r.status === 'stored') {
    console.log(`\nStored ${monthlyWinnerKey(month)}. Next:`);
    console.log('  • Overlay Dashboard → "Replay last reveal (monthly)" to fire the reel on stream.');
    console.log(`  • Bot Control → "Give Code to Winner" for ${month} to send the mythic code.`);
  } else {
    console.log('\nDRY RUN — re-run with --confirm to store this winner for the UI to send/replay.');
  }
  await pool.end();
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) { main().catch(e => { console.error(e.message); process.exit(1); }); }
