#!/usr/bin/env node
/* ══════════════════════════════════════════════
   What can we actually learn from Twitch about ad breaks?

   Creates nothing on Twitch and changes nothing about the site's
   configuration. It is NOT strictly read-only: obtaining the broadcaster
   token can refresh it, which stores the new one — the same write the
   running site performs on any request that needs that token. Said plainly
   rather than claimed away, because "read-only" was the first thing this
   file asserted and it was not quite true.

   Written because the design depends on answers I should not guess at:

     - is channel:read:ads granted? (it is not, as of writing — that is the
       whole point of asking before anyone re-authorises)
     - does GET /helix/channels/ads work while the channel is OFFLINE, or
       does it only return a schedule mid-stream? A "next ad in 4 min"
       countdown is worth building only if the answer is known.
     - what does it actually return — field names and shapes move, and
       building against a remembered payload is how you ship something that
       has never worked.
     - is a channel.ad_break.begin subscription already registered?

   IT DELIBERATELY DOES NOT CREATE AN EVENTSUB SUBSCRIPTION. Twitch treats
   type + condition as unique and ignores the callback, so a probe that
   "just tried it" would either 409 against something real or leave a live
   subscription pointing at a route that does not exist yet. Listing is
   enough to answer the question.

   Usage:
     node server/scripts/probe-ads.js --service phantomace-web

   Prints statuses, scopes and ad-schedule fields. Never a token value.
   ══════════════════════════════════════════════ */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

import { createPool, waitForDatabase } from '../lib/db.js';
import { createKVStore } from '../lib/kv.js';
import { resolveDatabaseUrl, readServiceEnv } from '../lib/service-env.js';

function arg(name, fallback = null) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return process.argv.includes(`--${name}`) ? true : fallback;
}

const line = (s = '') => console.log(s);
const head = (s) => { line(''); line('═══ ' + s + ' ' + '═'.repeat(Math.max(0, 52 - s.length))); };

async function main() {
  const service = arg('service');
  const databaseUrl = resolveDatabaseUrl({ service, fallback: arg('database-url') });
  if (!databaseUrl) {
    console.error('[ads] No DATABASE_URL. Use --service phantomace-web.');
    process.exit(2);
  }

  const pool = createPool(databaseUrl);
  const info = await waitForDatabase();
  line(`Database: ${info.db}`);

  const kv = createKVStore(pool);
  const vars = service ? readServiceEnv(service) : {};
  const clientId = vars.TWITCH_CLIENT_ID || process.env.TWITCH_CLIENT_ID;
  /* TWITCH_CLIENT_SECRET is not read into a local here, but it IS used:
     getBroadcasterToken below needs it to exchange the refresh token, and
     reaches it through the env object assembled from the service config. It
     is never printed. */
  const broadcasterId = vars.TWITCH_BROADCASTER_ID || process.env.TWITCH_BROADCASTER_ID;

  if (!clientId || !broadcasterId) {
    console.error('[ads] TWITCH_CLIENT_ID / TWITCH_BROADCASTER_ID missing.');
    process.exit(2);
  }

  /* ── 1. The broadcaster token, and what it is allowed to do ── */
  head('BROADCASTER TOKEN');

  /* Goes through getBroadcasterToken, which REFRESHES an expired access
     token from the stored refresh token — exactly as every handler on the
     site does.

     The first version of this read twitch_broadcaster_token straight out of
     storage and validated that. It reported "Twitch rejected the stored
     token: HTTP 401. Re-run Step 2", which read as "the authorisation is
     dead" when the truth was "the cached access token aged out an hour ago
     and the site refreshes it on demand". Reporting what is STORED rather
     than what the system can DO is the exact failure this project keeps
     finding elsewhere, and I wrote it into the diagnostic meant to catch it.

     Consequence worth stating: this may WRITE a refreshed token. That is the
     same write the running site performs, and there is no honest way to
     answer "can we call the ads endpoint" without obtaining the token the
     way the caller would. */
  const { getBroadcasterToken } = await import('../../functions/api/bot/send-chat.js');
  const tokenEnv = { ...process.env, ...vars, MARKETPLACE: kv };
  const token = await getBroadcasterToken(tokenEnv);

  if (!token) {
    const hasRefresh = !!(await kv.get('twitch_broadcaster_refresh_token'));
    line(hasRefresh
      ? '  A refresh token is stored but Twitch refused to refresh it — the'
      : '  No broadcaster refresh token stored at all.');
    if (hasRefresh) line('  authorisation has genuinely been revoked. Re-run Step 2.');
    else line('  Run Step 2 on the bot setup page first.');
    await pool.end().catch(() => {});
    return;
  }

  let granted = [];
  try {
    const v = await fetch('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: 'OAuth ' + token } });
    if (v.ok) {
      const d = await v.json();
      granted = d.scopes || [];
      line(`  Belongs to: @${d.login} (id ${d.user_id})`);
      line(`  Scopes:     ${granted.join(', ') || '(none)'}`);
    } else {
      line(`  Twitch rejected the token even after a refresh: HTTP ${v.status}.`);
      line('  That IS a dead authorisation — re-run Step 2.');
      await pool.end().catch(() => {});
      return;
    }
  } catch (err) {
    line(`  Could not reach Twitch: ${err.message}`);
    await pool.end().catch(() => {});
    return;
  }

  const hasRead = granted.includes('channel:read:ads');
  const hasManage = granted.includes('channel:manage:ads');
  line('');
  line(`  channel:read:ads   ${hasRead ? 'GRANTED' : 'NOT granted  <- needed for the schedule and the EventSub'}`);
  line(`  channel:manage:ads ${hasManage ? 'GRANTED' : 'NOT granted  (only needed to snooze a break)'}`);

  /* ── 2. Is the channel live? The schedule may behave differently. ── */
  head('CHANNEL STATE');
  let live = false;
  try {
    /* USES THE SITE'S SHARED APP TOKEN, not a freshly minted one.
       Twitch invalidates older app access tokens as new ones are issued —
       that is the documented root cause of this project's three-minute
       outage. A diagnostic that mints its own would revoke the token the
       running server is using, so a script whose whole job is to observe
       would break the thing it was observing. getAppToken returns the
       cached one and only mints when it is genuinely missing or expired,
       which is the same call the site makes anyway. */
    const { getAppToken } = await import('../../functions/api/auth/app-token.js');
    const appToken = await getAppToken({ ...process.env, ...vars, MARKETPLACE: kv });
    if (appToken) {
      const r = await fetch(`https://api.twitch.tv/helix/streams?user_id=${broadcasterId}`,
        { headers: { Authorization: `Bearer ${appToken}`, 'Client-Id': clientId } });
      if (r.ok) {
        const d = await r.json();
        live = !!(d.data && d.data.length);
        line(`  Live: ${live}${live ? ` (started ${d.data[0].started_at})` : ''}`);
      }
      /* ── 4. Existing ad-break subscriptions, listed not created ── */
      head('EVENTSUB');
      const subs = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions',
        { headers: { Authorization: `Bearer ${appToken}`, 'Client-Id': clientId } });
      if (subs.ok) {
        const d = await subs.json();
        const ad = (d.data || []).filter(s => String(s.type).includes('ad_break'));
        line(`  Total subscriptions: ${d.total}`);
        line(ad.length
          ? '  ad_break: ' + ad.map(s => `${s.type} v${s.version} ${s.status}`).join(', ')
          : '  ad_break: none registered');
      } else {
        line(`  Could not list subscriptions: HTTP ${subs.status}`);
      }
    } else {
      line('  Could not mint an app token; skipping live check and subscription list.');
    }
  } catch (err) {
    line(`  ${err.message}`);
  }

  /* ── 3. THE ACTUAL QUESTION ── */
  head('GET /helix/channels/ads');
  try {
    const r = await fetch(`https://api.twitch.tv/helix/channels/ads?broadcaster_id=${broadcasterId}`,
      { headers: { Authorization: `Bearer ${token}`, 'Client-Id': clientId } });
    line(`  HTTP ${r.status}`);
    const body = await r.text();
    if (!r.ok) {
      line(`  ${body.slice(0, 300)}`);
      if (r.status === 401 || r.status === 403) {
        line('');
        line('  Expected while channel:read:ads is not granted. Re-run Step 2 with');
        line('  the scope added, then run this again to see the real payload.');
      }
    } else {
      /* Printed raw AND parsed. The raw form is what settles field names,
         which is the thing this probe exists to establish. */
      line('  Raw: ' + body.slice(0, 500));
      try {
        const d = JSON.parse(body);
        const row = d.data && d.data[0];
        if (row) {
          line('');
          for (const [k, v] of Object.entries(row)) line(`    ${k.padEnd(20)} ${v}`);
          if (row.next_ad_at) {
            const secs = Math.round((Number(row.next_ad_at) * 1000 - Date.now()) / 1000);
            line('');
            line(`    -> next break in roughly ${Math.round(secs / 60)} min` +
                 (secs < 0 ? '  (in the past — probably means none scheduled)' : ''));
          }
        } else {
          line('  data[] was empty — no schedule available right now.');
        }
      } catch { line('  (body was not JSON)'); }
    }
  } catch (err) {
    line(`  Request failed: ${err.message}`);
  }

  head('WHAT THIS MEANS');
  if (!hasRead) {
    line('  channel:read:ads is not granted, so nothing ad-related can work yet.');
    line('  Adding it needs PhantomACE to re-run Step 2. Grant the scope BEFORE');
    line('  creating any EventSub subscription — Twitch checks granted scopes at');
    line('  creation time, which is how the hype train subscriptions failed.');
  } else if (!live) {
    line('  Scope is granted. Worth running this again WHILE LIVE — an offline');
    line('  channel may legitimately have no schedule to report, and that is the');
    line('  difference between "not supported" and "nothing on right now".');
  } else {
    line('  Scope granted and channel live: the payload above is what a countdown');
    line('  and an ad-aware drop guard would be built on.');
  }

  await pool.end().catch(() => {});
}

main().catch(err => {
  console.error('[ads] FAILED:', err.message);
  process.exit(1);
});
