#!/usr/bin/env node
/* ══════════════════════════════════════════════
   BACKFILL MILESTONE BADGE ARTWORK

     node server/scripts/backfill-milestone-badges.js --service phantomace-web
     node server/scripts/backfill-milestone-badges.js --service phantomace-web --confirm

   Milestone claims granted `type: 'badge'` items carrying no image, so every
   rank from Initiate to Eternal drew the same grey diamond wherever a badge
   is shown. New claims now name a file per level; this gives the ones
   already sitting in people's inventories the same.

   Dry run unless --confirm: it reports what it would change, per person and
   per badge, and writes nothing.

   SAFE TO RUN TWICE. It only touches items whose image is missing, so a
   second pass finds nothing to do. Each inventory is updated through
   mutate(), so a claim landing at the same moment is not overwritten by a
   copy of the inventory read seconds earlier — the failure this script
   could otherwise cause is silently deleting a reward somebody just earned.
   ══════════════════════════════════════════════ */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

import { createPool, waitForDatabase } from '../lib/db.js';
import { createKVStore } from '../lib/kv.js';
import { resolveDatabaseUrl } from '../lib/service-env.js';
import { MILESTONES } from '../../functions/api/phamily-rewards.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');

function arg(name, fallback = null) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return process.argv.includes(`--${name}`) ? true : fallback;
}

const line = (s = '') => console.log(s);

/* `ms_{level}_badge_{YYYY-MM}` — the month is part of the id because the
   track resets monthly, so one person can hold several of the same rank. */
const BADGE_ID = /^ms_(\d+)_badge_/;

const RANK = new Map(MILESTONES.map(m => [m.level, m.title]));

function artFor(level) {
  return `/assets/badges/milestones/ms-${level}.png`;
}

async function main() {
  const service = arg('service');
  const confirm = arg('confirm') === true;
  /* Checked BEFORE the database, because it needs no connection and a
     missing file is worth knowing about wherever this is run.

     Refuse before touching anything if the artwork is not actually there.
     Pointing a thousand inventory items at files that 404 would be worse
     than the grey diamond they have now. */
  const missingArt = MILESTONES
    .map(m => m.level)
    .filter(l => !fs.existsSync(path.join(REPO, artFor(l).replace(/^\//, ''))));
  if (missingArt.length) {
    console.error('[backfill] Artwork missing for levels: ' + missingArt.join(', '));
    console.error('[backfill] Refusing to point items at files that are not there.');
    process.exit(1);
  }

  const databaseUrl = resolveDatabaseUrl({ service, fallback: arg('database-url') });
  if (!databaseUrl) {
    console.error('[backfill] No DATABASE_URL. Use --service phantomace-web.');
    process.exit(2);
  }

  const pool = createPool(databaseUrl);
  const info = await waitForDatabase();
  line(`Database: ${info.db}`);
  line(`Artwork:  ${MILESTONES.length} milestone badges present`);
  line('');

  const kv = createKVStore(pool);
  const rows = await kv.listValues({ prefix: 'inv_' });
  line(`Inventories: ${rows.length}`);

  /* Worked out from the read, then applied per person. Counting first means
     the dry run reports the same numbers the real run will act on. */
  const plan = [];
  const perLevel = new Map();

  for (const row of rows) {
    const inv = row.value;
    if (!inv || !Array.isArray(inv.items)) continue;

    const needs = inv.items.filter((i) => {
      if (!i || i.type !== 'badge') return false;
      const m = BADGE_ID.exec(String(i.id || ''));
      if (!m) return false;
      if (!RANK.has(Number(m[1]))) return false;      // a rank no longer on the table
      return !(i.meta && i.meta.image);               // already done
    });

    if (!needs.length) continue;
    plan.push({ key: row.name, count: needs.length });
    for (const i of needs) {
      const level = Number(BADGE_ID.exec(i.id)[1]);
      perLevel.set(level, (perLevel.get(level) || 0) + 1);
    }
  }

  const total = plan.reduce((n, p) => n + p.count, 0);
  line(`Badges without artwork: ${total} across ${plan.length} inventories`);
  line('');
  if (total) {
    line('  by rank:');
    for (const m of MILESTONES) {
      const n = perLevel.get(m.level);
      if (n) line(`    L${String(m.level).padStart(3)}  ${m.title.padEnd(9)} ${String(n).padStart(4)}`);
    }
    line('');
  }

  if (!total) {
    line('Nothing to do.');
    await pool.end();
    return;
  }

  if (!confirm) {
    line('DRY RUN — nothing written. Re-run with --confirm.');
    await pool.end();
    return;
  }

  let changed = 0;
  let touched = 0;
  for (const p of plan) {
    /* Re-read inside the lock rather than writing the copy from the listing:
       a claim between the two would otherwise be erased. */
    await kv.mutate(p.key, (inv) => {
      if (!inv || !Array.isArray(inv.items)) return undefined;
      let n = 0;
      for (const i of inv.items) {
        if (!i || i.type !== 'badge') continue;
        const m = BADGE_ID.exec(String(i.id || ''));
        if (!m) continue;
        const level = Number(m[1]);
        if (!RANK.has(level)) continue;
        if (i.meta && i.meta.image) continue;
        /* Merged, not replaced — an item may carry meta this script knows
           nothing about. */
        i.meta = { ...(i.meta || {}), image: artFor(level), milestoneLevel: level, rank: RANK.get(level) };
        n++;
      }
      if (!n) return undefined;
      changed += n;
      touched++;
      return inv;
    });
  }

  line(`Applied: ${changed} badges across ${touched} inventories.`);
  await pool.end();
}

main().catch((err) => {
  console.error('[backfill]', err.message);
  process.exit(1);
});
