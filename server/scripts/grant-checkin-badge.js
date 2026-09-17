#!/usr/bin/env node
/* ══════════════════════════════════════════════
   BACKFILL EVENT BADGES FOR THIS BROADCAST'S CHECK-INS

     node server/scripts/grant-checkin-badge.js --service phantomace-web
     node server/scripts/grant-checkin-badge.js --service phantomace-web --confirm

   THE GAP THIS CLOSES. The badge is granted when a redemption is
   PROCESSED, so a window whose start time is moved into the past does not
   reach backwards — anyone who redeemed Pham Check-In before the code was
   deployed earned nothing. Twitch caps that reward at once per broadcast,
   so they cannot simply redeem again. Without this they are out of luck for
   a badge they did exactly what was asked to get.

   What makes repair possible: channel-points.js writes every check-in into
   `checkin_current`, replaced wholesale each broadcast, so that row is
   exactly the population — everyone here, this stream, with the instant
   each of them arrived.

   Each person is granted whatever was open AT THEIR CHECK-IN TIME, not at
   the time this runs. That is the same answer the live code would have
   given had it been running, including for anyone who checked in before
   the window opened: they get nothing, which is correct.

   The badge is stamped with the moment it was earned rather than the moment
   it was repaired, so grant order still records who was first.

   Dry run unless --confirm. SAFE TO RUN TWICE — grantOpenBadges only adds
   a badge the account does not already hold, whichever way it got it.
   ══════════════════════════════════════════════ */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

import { createPool, waitForDatabase } from '../lib/db.js';
import { createKVStore } from '../lib/kv.js';
import { resolveDatabaseUrl } from '../lib/service-env.js';
import { grantOpenBadges, badgesOpenAt, CHECKIN_BADGES } from '../../functions/api/checkin-badges.js';

function arg(name, fallback = null) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return process.argv.includes(`--${name}`) ? true : fallback;
}
const line = (s = '') => console.log(s);
const when = (ms) => new Date(ms).toLocaleString('en-US', {
  timeZone: 'America/Los_Angeles', dateStyle: 'medium', timeStyle: 'short',
});

/**
 * What each check-in is owed, worked out before anything is written —
 * this hands out something that cannot be taken back, so it is printed in
 * full first.
 *
 * Each person is judged at THEIR check-in time, not at the time this runs,
 * which is the same answer the live code would have given.
 */
export async function planBackfill(env, checkins) {
  const plan = [];
  for (const c of checkins) {
    const at = Number(c.at) || Date.now();
    const open = badgesOpenAt(at);
    if (!open.length) {
      /* Says WHICH side they fell on. "outside the window" read on a live
         stream is a question; "after it closed" is an answer. */
      const early = CHECKIN_BADGES.some(b => at < b.from);
      plan.push({ c, at, skip: early ? 'checked in before the window opened' : 'checked in after it closed' });
      continue;
    }
    const inv = await env.MARKETPLACE.get(`inv_${c.userId}`, 'json') || { userId: String(c.userId), items: [] };
    const missing = open.filter(b => !(inv.items || []).some(i => i && i.id === b.id && i.type === b.type));
    if (!missing.length) {
      plan.push({ c, at, skip: 'already holds it' });
      continue;
    }
    plan.push({ c, at, grant: missing });
  }
  return plan;
}

/** @returns {Promise<number>} how many badges were actually written */
export async function applyBackfill(env, todo) {
  let granted = 0;
  for (const p of todo) {
    /* mutate(), because the site is live and these same rows are being
       written by check-ins arriving right now. */
    await env.MARKETPLACE.mutate(`inv_${p.c.userId}`, (current) => {
      const inv = current || { userId: String(p.c.userId), items: [], equips: {} };
      const got = grantOpenBadges(inv, p.at);
      if (!got.length) return undefined;
      granted += got.length;
      return inv;
    });
  }
  return granted;
}

async function main() {
  const service = arg('service');
  const confirm = arg('confirm') === true;

  const databaseUrl = resolveDatabaseUrl({ service, fallback: arg('database-url') });
  if (!databaseUrl) {
    console.error('[backfill] No DATABASE_URL. Use --service phantomace-web.');
    process.exit(2);
  }

  const pool = createPool(databaseUrl);
  const info = await waitForDatabase();
  const env = { MARKETPLACE: createKVStore(pool) };

  line('');
  line(`Database:   ${info.db}`);

  const rec = await env.MARKETPLACE.get('checkin_current', 'json');
  const checkins = rec && Array.isArray(rec.checkins) ? rec.checkins : [];

  if (!checkins.length) {
    line('');
    line('Nobody has checked in on this broadcast yet, so there is nothing to');
    line('backfill. checkin_current is replaced each stream, so this only ever');
    line('covers the one currently on air.');
    await pool.end();
    return;
  }

  line(`Broadcast:  ${rec.streamId || 'unknown'}${rec.startedAt ? ' — started ' + when(Date.parse(rec.startedAt)) : ''}`);
  line(`Check-ins:  ${checkins.length}`);
  line('');

  const plan = await planBackfill(env, checkins);

  for (const p of plan) {
    const name = (p.c.displayName || p.c.userId).padEnd(22);
    if (p.skip) line(`  – ${name} ${when(p.at)}  (${p.skip})`);
    else line(`  + ${name} ${when(p.at)}  → ${p.grant.map(b => b.name).join(', ')}`);
  }

  const todo = plan.filter(p => p.grant);
  line('');
  line(`${todo.length} to grant, ${plan.length - todo.length} already covered or outside the window.`);
  line('');

  if (!todo.length) {
    await pool.end();
    return;
  }

  if (!confirm) {
    line('DRY RUN — nothing written. Re-run with --confirm.');
    line('');
    await pool.end();
    return;
  }

  const granted = await applyBackfill(env, todo);

  line(`Granted ${granted} badge${granted === 1 ? '' : 's'}.`);
  line('Re-run without --confirm to see the broadcast as it stands now.');
  line('');
  await pool.end();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[backfill]', err.message);
    process.exit(1);
  });
}
