#!/usr/bin/env node
/* ══════════════════════════════════════════════
   WHY IS NOBODY'S SUBSCRIPTION LENGTH RECORDED?

     node server/scripts/check-sub-months.js --service phantomace-web

   Twitch returns a tier and no duration, so the only place cumulative
   months appear is the badge a subscriber wears in chat. The bot records it
   as they speak and the badge importer reads it back.

   When that comes up empty there are exactly three causes, and from a
   browser they look identical — the import button can only say "say
   something in chat first" for all of them:

     1. sub_months does not exist. 004_sub_months.sql was never applied, so
        the write throws and is swallowed.
     2. The table is there and empty. Nothing is listening to chat: the
        channel.chat.message subscription is missing or not enabled, which
        also means every chat command is dead.
     3. The table has rows, just not for the person who tried.

   This asks the database and Twitch directly and says which.
   ══════════════════════════════════════════════ */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

import { createPool, waitForDatabase } from '../lib/db.js';
import { resolveDatabaseUrl, readServiceEnv } from '../lib/service-env.js';

function arg(name, fallback = null) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return process.argv.includes(`--${name}`) ? true : fallback;
}

const line = (s = '') => console.log(s);
const head = (s) => { line(''); line('═══ ' + s + ' ' + '═'.repeat(Math.max(0, 50 - s.length))); };

async function main() {
  const service = arg('service');
  const databaseUrl = resolveDatabaseUrl({ service, fallback: arg('database-url') });
  if (!databaseUrl) {
    console.error('[check] No DATABASE_URL. Use --service phantomace-web.');
    process.exit(2);
  }

  const pool = createPool(databaseUrl);
  const info = await waitForDatabase();
  line(`Database: ${info.db}`);

  /* ── 1. Does the table exist, and does it hold anything? ── */
  head('sub_months');
  const { rows: exists } = await pool.query(
    `SELECT to_regclass('public.sub_months') AS t`);
  if (!exists[0].t) {
    line('  MISSING — the table was never created.');
    line('');
    line('  Every attempt to record a duration has thrown and been swallowed,');
    line('  so nobody has a recorded subscription length. Apply it:');
    line('');
    line('    node server/scripts/apply-sql.js server/sql/004_sub_months.sql \\');
    line('      --service phantomace-web --confirm');
    line('');
    line('  Then have a subscriber post in chat and try the import again.');
    await pool.end();
    return;
  }

  line('  exists');
  const { rows: count } = await pool.query('SELECT count(*)::int AS n FROM sub_months');
  line(`  rows: ${count[0].n}`);

  if (count[0].n === 0) {
    line('');
    line('  Empty. The table is fine, so nothing is writing to it — which');
    line('  means no chat message has reached the server since it was');
    line('  created. See the EventSub section below.');
  } else {
    const { rows: sample } = await pool.query(
      `SELECT key, value->>'name' AS name,
              (value->>'months')::int AS months,
              (value->>'tier')::int AS tier,
              updated_at
         FROM sub_months
        ORDER BY (value->>'months')::int DESC
        LIMIT 10`);
    line('');
    line('  longest recorded:');
    for (const r of sample) {
      line(`    ${String(r.months).padStart(4)} months  Tier ${r.tier}  ` +
           `${(r.name || r.key).padEnd(22)} ${r.updated_at.toISOString().slice(0, 16)}`);
    }
  }

  /* ── 2. Is anything listening to chat? ── */
  head('EventSub');
  const vars = service ? readServiceEnv(service) : {};
  const clientId = vars.TWITCH_CLIENT_ID || process.env.TWITCH_CLIENT_ID;
  const clientSecret = vars.TWITCH_CLIENT_SECRET || process.env.TWITCH_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    line('  TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET not readable here —');
    line('  skipping the subscription check.');
    await pool.end();
    return;
  }

  const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials',
    }),
  });
  if (!tokenRes.ok) {
    line(`  could not get an app token (HTTP ${tokenRes.status})`);
    await pool.end();
    return;
  }
  const { access_token } = await tokenRes.json();

  const subRes = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
    headers: { 'Client-Id': clientId, Authorization: `Bearer ${access_token}` },
  });
  if (!subRes.ok) {
    line(`  could not list subscriptions (HTTP ${subRes.status})`);
    await pool.end();
    return;
  }
  const subs = await subRes.json();
  const all = subs.data || [];

  if (!all.length) {
    line('  NONE REGISTERED. Nothing reaches this server from Twitch at all —');
    line('  not chat, not subs, not hype train.');
  } else {
    for (const s of all) {
      const mark = s.status === 'enabled' ? ' ' : '!';
      line(`  ${mark} ${s.type.padEnd(48)} ${s.status}`);
    }
  }

  const chat = all.find(s => s.type === 'channel.chat.message');
  line('');
  if (!chat) {
    line('  channel.chat.message is NOT subscribed.');
    line('  Nothing is reading chat, so no duration can ever be recorded —');
    line('  and every chat command is dead for the same reason.');
  } else if (chat.status !== 'enabled') {
    line(`  channel.chat.message is subscribed but ${chat.status}.`);
    line('  Twitch disables a subscription after repeated delivery failures.');
  } else {
    line('  channel.chat.message is enabled — chat should be recording.');
    line('  If the table is still empty, no subscriber has posted since it');
    line('  was created. A non-subscriber wears no badge and records nothing.');
  }

  await pool.end();
}

main().catch((err) => {
  console.error('[check]', err.message);
  process.exit(1);
});
