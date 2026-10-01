#!/usr/bin/env node
/* Draw the big MONTHLY giveaway winner for a SPECIFIC month, from the rig.

   The dashboard's "Draw Monthly Winner" button only ever draws the CURRENT UTC
   month. Because the ledger rolls on the UTC calendar, a broadcaster west of UTC
   can cross into the next month (locally still "this month") before they draw —
   leaving the just-ended month undrawable from the UI. This script closes that
   gap: it draws any month's ledger and writes the SAME giveaway_monthly_winner
   record the button writes, so afterwards the Overlay Dashboard's
   "Replay last reveal (monthly)" and Bot Control's "Give Code to Winner" both
   work normally.

     node server/scripts/draw-monthly-giveaway.js --service phantomace-web
     node server/scripts/draw-monthly-giveaway.js --service phantomace-web --confirm
     Optional: --month 2026-09  (defaults to the PREVIOUS UTC month)

   Dry-run unless --confirm. Re-running overwrites the record (re-draws). */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });
import { createPool, waitForDatabase } from '../lib/db.js';
import { createKVStore } from '../lib/kv.js';
import { resolveDatabaseUrl } from '../lib/service-env.js';
import { drawMonthlyWinner, buildWeightedReelPool } from '../../functions/api/giveaway-entries.js';

const MONTHLY_WINNER_KEY = 'giveaway_monthly_winner';

const arg = (n) => { const h = process.argv.find(a => a.startsWith(`--${n}=`)); if (h) return h.slice(n.length + 3); const i = process.argv.indexOf(`--${n}`); if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1]; return process.argv.includes(`--${n}`) || false; };

/* The UTC month before now, 'YYYY-MM'. */
function prevMonth() { const d = new Date(); const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1; return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; }

async function main() {
  const service = arg('service'), confirm = arg('confirm') === true;
  const month = (typeof arg('month') === 'string' && arg('month')) || prevMonth();
  const url = resolveDatabaseUrl({ service, fallback: arg('database-url') });
  if (!url) { console.error('No DATABASE_URL. Use --service phantomace-web.'); process.exit(2); }
  const pool = createPool(url); const info = await waitForDatabase(); console.log('Database:', info.db);
  const kv = createKVStore(pool);
  const env = { MARKETPLACE: kv };

  console.log(`Drawing monthly giveaway for ${month} ...`);
  const draw = await drawMonthlyWinner(env, { month });
  if (!draw.winner) {
    console.log(`\nNobody (non-guest) entered in ${month} — nothing to draw.`);
    await pool.end(); return;
  }

  console.log(`\nEntrants (${draw.totalPeople}, ${draw.totalEntries} entries total):`);
  for (const e of draw.entrants.slice(0, 20)) console.log(`   ${e.username || e.userId}  ${e.entries} entr${e.entries === 1 ? 'y' : 'ies'}`);
  console.log(`\n>>> WINNER: ${draw.winner.username || draw.winner.userId}  (${draw.winner.entries} entries)`);

  const reel = buildWeightedReelPool(draw.entrants, draw.winner);
  const reveal = {
    entrants: reel.pool,
    winnerIndex: reel.winnerIndex,
    rarity: 'mythic',
    who: draw.winner.username,
    label: 'Monthly Giveaway',
    note: `Drawn from ${draw.totalEntries} entries across ${draw.totalPeople} ${draw.totalPeople === 1 ? 'person' : 'people'}`,
  };
  const winner = {
    userId: draw.winner.userId,
    username: draw.winner.username,
    entries: draw.winner.entries,
    month: draw.month,
    totalEntries: draw.totalEntries,
    totalPeople: draw.totalPeople,
    rarity: 'mythic',
    pickedAt: Date.now(),
    sent: false,
    reveal,
  };

  if (confirm) {
    await kv.put(MONTHLY_WINNER_KEY, winner);
    console.log('\nStored giveaway_monthly_winner. Next:');
    console.log('  • Overlay Dashboard → "Replay last reveal (monthly)" to fire the reel on stream.');
    console.log('  • Bot Control → "Give Code to Winner" to send the mythic code.');
  } else {
    console.log('\nDRY RUN — re-run with --confirm to store this winner for the UI to send/replay.');
  }
  await pool.end();
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) { main().catch(e => { console.error(e.message); process.exit(1); }); }
