#!/usr/bin/env node
/* ══════════════════════════════════════════════
   What can this channel's authorisation actually DO?

   Asks Twitch directly, so nobody re-authorises against my recollection of
   which scope a feature needs. Scope names and subscription versions move,
   and a wrong guess here costs a broadcaster a second consent screen.

   HOW IT TESTS A SCOPE WITHOUT ASKING FOR ONE

   It does NOT attempt to create EventSub subscriptions. Twitch treats
   type + condition as unique and ignores the callback, so "just trying"
   would either 409 against a live subscription or leave a real one pointing
   at a route that does not exist. There is no dry-run.

   Instead it calls the READ endpoint that sits behind each scope. Those are
   plain GETs, and Twitch names the missing scope in the error itself —
   exactly as /helix/channels/ads answered "Missing scope: channel:read:ads".
   That makes Twitch the authority instead of my memory.

   THE LIMIT OF THAT, STATED PLAINLY: this proves what the read endpoint
   needs. An EventSub subscription of the related type USUALLY requires the
   same scope, but Twitch documents them separately and they can differ. So
   treat a PASS as "this scope is granted and working", not as proof the
   subscription will register. The subscription is still the moment of
   truth — this just stops us asking for the wrong scopes.

   Creates nothing on Twitch and changes no configuration. Not strictly
   read-only: obtaining the broadcaster token can refresh it, which stores
   the new one — the same write the running site performs.

   Usage:
     node server/scripts/probe-twitch.js --service phantomace-web

   Prints statuses, scopes and payload fields. Never a token value.
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
    console.error('[probe] No DATABASE_URL. Use --service phantomace-web.');
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
    console.error('[probe] TWITCH_CLIENT_ID / TWITCH_BROADCASTER_ID missing.');
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

  /* ── 3. CAPABILITY MATRIX ──────────────────────────────────────────────
     One GET per scope we might want. Twitch's own error names the scope,
     which is the point — every row below is answered by Twitch rather than
     asserted here. */
  head('WHAT THE BROADCASTER TOKEN CAN DO');

  const B = broadcasterId;
  const PROBES = [
    { scope: 'channel:read:subscriptions', why: 'resub-with-message alerts (channel.subscription.message)',
      url: `https://api.twitch.tv/helix/subscriptions?broadcaster_id=${B}&first=1` },
    { scope: 'channel:read:ads',           why: 'ad countdown + drop guard (channel.ad_break.begin)',
      url: `https://api.twitch.tv/helix/channels/ads?broadcaster_id=${B}` },
    { scope: 'bits:read',                  why: 'cheer alerts (channel.cheer)',
      url: `https://api.twitch.tv/helix/bits/leaderboard?count=1` },
    { scope: 'moderator:read:followers',   why: 'follow alerts (channel.follow v2)',
      url: `https://api.twitch.tv/helix/channels/followers?broadcaster_id=${B}&first=1` },
    { scope: 'channel:read:polls',         why: 'poll overlay (channel.poll.*)',
      url: `https://api.twitch.tv/helix/polls?broadcaster_id=${B}&first=1` },
    { scope: 'channel:read:predictions',   why: 'prediction overlay (channel.prediction.*)',
      url: `https://api.twitch.tv/helix/predictions?broadcaster_id=${B}&first=1` },
    { scope: 'channel:read:goals',         why: 'goal bar (channel.goal.*)',
      url: `https://api.twitch.tv/helix/goals?broadcaster_id=${B}` },
  ];

  const missing = [];
  for (const p of PROBES) {
    let verdict;
    try {
      const r = await fetch(p.url, { headers: { Authorization: `Bearer ${token}`, 'Client-Id': clientId } });
      if (r.ok) {
        const d = await r.json().catch(() => ({}));
        const n = Array.isArray(d.data) ? d.data.length : 0;
        const total = Number(d.total);

        /* A 200 IS NOT ALWAYS A PASS.
           /helix/channels/followers answers 200 without moderator:read:followers
           — it just returns `total` and an EMPTY data array. The endpoint
           "works" while withholding the very rows a follow alert needs, so
           the naive check reported the scope as granted when it was not.
           Caught on this probe's first real run against production.

           total > 0 with no rows is that shape. Reported as missing, because
           the thing being asked is "can we read the data", not "does the URL
           respond". */
        if (n === 0 && Number.isFinite(total) && total > 0) {
          verdict = `200 but 0 of ${total} rows — data withheld, scope NOT granted`;
          missing.push(p);
        } else {
          verdict = `OK (${n} row${n === 1 ? '' : 's'}${Number.isFinite(total) ? ` of ${total}` : ''})`;
        }
      } else {
        const body = await r.text();
        let msg = '';
        try { msg = JSON.parse(body).message || ''; } catch { msg = body.slice(0, 80); }
        verdict = `HTTP ${r.status}  ${msg}`;
        /* Only a scope complaint counts as "needs granting". A 400 or 404
           means the call is wrong or there is simply nothing to return, and
           filing that as a missing scope would send somebody to a consent
           screen for no reason. */
        if (/missing scope|unauthorized/i.test(msg) || r.status === 401) missing.push(p);
      }
    } catch (err) {
      verdict = 'request failed: ' + err.message;
    }
    line(`  ${p.scope.padEnd(28)} ${verdict}`);
    line(`  ${' '.repeat(28)} -> ${p.why}`);
  }

  /* ── CHANNEL EMOTES ──────────────────────────────────────────────────
     Listed because they are the one source of artwork with no licensing
     question attached: the broadcaster's own emotes, on the broadcaster's
     own overlay. Needs an APP token and no scope, so nothing has to be
     re-authorised to use them.

     Animated emotes come back as GIFs on Twitch's CDN, which is hotlinkable
     by design — that is how every chat client renders them — so an overlay
     can point at the URL rather than copying the file. */
  head('CHANNEL EMOTES');
  try {
    const { getAppToken } = await import('../../functions/api/auth/app-token.js');
    const appToken = await getAppToken({ ...process.env, ...vars, MARKETPLACE: kv });
    if (!appToken) {
      line('  No app token available; skipping.');
    } else {
      const r = await fetch(`https://api.twitch.tv/helix/chat/emotes?broadcaster_id=${broadcasterId}`,
        { headers: { Authorization: `Bearer ${appToken}`, 'Client-Id': clientId } });
      if (!r.ok) {
        line(`  HTTP ${r.status} — ${(await r.text()).slice(0, 160)}`);
      } else {
        const d = await r.json();
        const list = d.data || [];
        line(`  ${list.length} emote(s). template: ${d.template || '(none returned)'}`);
        line('');
        for (const e of list) {
          const fmts = (e.format || []).join('/');
          const animated = (e.format || []).includes('animated');
          line(`  ${String(e.name).padEnd(24)} ${animated ? 'ANIMATED' : 'static  '}  ${fmts}  id=${e.id}`);
        }
        if (list.length) {
          line('');
          line('  A 4x URL is built from the template by substituting id, format,');
          line('  theme_mode and scale — e.g. format=animated, theme_mode=dark,');
          line('  scale=3.0 for the largest animated version.');
        }
      }
    }
  } catch (err) {
    line(`  Could not list emotes: ${err.message}`);
  }

  head('SCOPES NEEDING NO PERMISSION AT ALL');
  line('  stream.online / stream.offline require no scope. Worth taking on its');
  line('  own merits: the site currently POLLS /helix/streams every 60s, so');
  line('  "went live" is up to a minute late — which is also how late the');
  line('  stream_log entry that check-in streaks are computed from can be.');

  head('WHAT TO DO WITH THIS');
  if (!missing.length) {
    line('  Every scope probed is already granted. No re-authorisation needed.');
  } else {
    line('  Missing, and each one needs PhantomACE to approve it:');
    for (const m of missing) line(`    ${m.scope.padEnd(28)} ${m.why}`);
    line('');
    line('  DO IT IN ONE GO. Every separate re-authorisation is another consent');
    line('  screen for the broadcaster, so add every scope you actually intend');
    line('  to use before asking rather than returning per feature.');
    line('');
    line('  Paste this as broadcasterScopes in functions/api/admin/bot-setup.js,');
    line('  then have PhantomACE re-run Step 2:');
    line('');
    line('    ' + [...new Set([...granted, ...missing.map(m => m.scope)])].join(' '));
    line('');
    line('  GRANT BEFORE SUBSCRIBING. Twitch checks granted scopes when an');
    line('  EventSub subscription is CREATED, not when the event fires — which');
    line('  is exactly how the hype train subscriptions failed with three 403s.');
  }

  await pool.end().catch(() => {});
}

main().catch(err => {
  console.error('[probe] FAILED:', err.message);
  process.exit(1);
});
