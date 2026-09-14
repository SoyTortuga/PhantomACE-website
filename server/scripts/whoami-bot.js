#!/usr/bin/env node
/* ══════════════════════════════════════════════
   Which Twitch account is the bot, and who is it acting as?

   Read-only. Writes nothing, changes nothing.

   The bot setup page says "✅ Bot token stored" and never says WHOSE. That is
   presence, not identity — the same thing that page's own comments warn
   about, and it means the answer to "which account is posting in my chat"
   is not visible anywhere in the UI.

   It is also not a single value. send-chat.js resolves the bot as:

       env.TWITCH_BOT_USER_ID || <twitch_bot_user_id from the database>

   so the environment variable WINS. Re-running the OAuth flow with a
   different account updates the database and leaves the env var alone, and
   chat keeps going out as the old account with nothing reporting a conflict.
   This prints both and says plainly when they disagree.

   Usage:
     node server/scripts/whoami-bot.js                      (server/.env — dev)
     node server/scripts/whoami-bot.js --service phantomace-web       (prod)
     node server/scripts/whoami-bot.js --service phantomace-web-dev   (dev)

   Prints ids, login names, scopes and expiry times. Never a token value.
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

/** Twitch user id -> { login, display_name } — or null if it can't be resolved. */
async function resolveUser(clientId, appToken, id) {
  if (!id || !appToken) return null;
  try {
    const res = await fetch(`https://api.twitch.tv/helix/users?id=${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${appToken}`, 'Client-Id': clientId },
    });
    if (!res.ok) return { error: `Helix ${res.status}` };
    const body = await res.json();
    const u = body.data && body.data[0];
    return u ? { login: u.login, displayName: u.display_name } : { error: 'no such user' };
  } catch (err) {
    return { error: err.message };
  }
}

function ago(ts) {
  if (!ts) return 'unknown';
  const d = ts - Date.now();
  const mins = Math.round(Math.abs(d) / 60000);
  if (mins < 60) return d > 0 ? `in ${mins}m` : `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return d > 0 ? `in ${hrs}h` : `${hrs}h ago`;
  return new Date(ts).toISOString().slice(0, 16).replace('T', ' ');
}

async function main() {
  const service = arg('service');
  const databaseUrl = resolveDatabaseUrl({ service, fallback: arg('database-url') });

  if (!databaseUrl) {
    console.error('[bot] No DATABASE_URL. Use --service phantomace-web, or set it in server/.env');
    process.exit(2);
  }

  const pool = createPool(databaseUrl);
  const info = await waitForDatabase();
  console.log(`Database:    ${info.db}`);

  const kv = createKVStore(pool);

  /* The env var that outranks the database. When --service is given, read it
     from THAT service rather than this shell — otherwise we would report the
     environment of the wrong process. */
  const serviceVars = service ? readServiceEnv(service) : {};
  const envBotId = service ? serviceVars.TWITCH_BOT_USER_ID : process.env.TWITCH_BOT_USER_ID;
  const storedBotId = await kv.get('twitch_bot_user_id');

  const clientId = serviceVars.TWITCH_CLIENT_ID || process.env.TWITCH_CLIENT_ID;
  const clientSecret = serviceVars.TWITCH_CLIENT_SECRET || process.env.TWITCH_CLIENT_SECRET;

  let appToken = null;
  if (clientId && clientSecret) {
    try {
      /* Minted directly rather than via getAppToken(), which CACHES. Twitch
         invalidates older app tokens as new ones are issued, so a diagnostic
         writing to the shared cache could disturb the running site — which is
         exactly the outage this project already had once. Read-only means
         read-only. */
      const res = await fetch('https://id.twitch.tv/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials',
        }),
      });
      if (res.ok) appToken = (await res.json()).access_token;
      else console.log(`(could not mint an app token: HTTP ${res.status} — ids shown unresolved)`);
    } catch (err) {
      console.log(`(could not reach Twitch: ${err.message} — ids shown unresolved)`);
    }
  }

  const effectiveId = envBotId || storedBotId;
  const [envUser, storedUser, effUser] = await Promise.all([
    resolveUser(clientId, appToken, envBotId),
    resolveUser(clientId, appToken, storedBotId),
    resolveUser(clientId, appToken, effectiveId),
  ]);

  const name = u => (u && u.login ? `@${u.login}` : u && u.error ? `(${u.error})` : '(unresolved)');

  console.log('');
  console.log('═══ THE BOT ═══════════════════════════════════');
  if (!effectiveId) {
    console.log('  NOT CONFIGURED — no bot user id in either place.');
  } else {
    console.log(`  Posting to chat as: ${name(effUser)}   id ${effectiveId}`);
    console.log(`  Source:             ${envBotId ? 'TWITCH_BOT_USER_ID (env)' : 'database'}`);
  }

  console.log('');
  console.log('  env TWITCH_BOT_USER_ID : ' + (envBotId ? `${envBotId} ${name(envUser)}` : '(not set)'));
  console.log('  db  twitch_bot_user_id : ' + (storedBotId ? `${storedBotId} ${name(storedUser)}` : '(not set)'));

  if (envBotId && storedBotId && String(envBotId) !== String(storedBotId)) {
    console.log('');
    console.log('  ⚠  THESE DISAGREE. The env var wins, so chat posts as the env');
    console.log('     account while the setup flow authorized the other one. The');
    console.log('     stored token belongs to the database account, so sends may');
    console.log('     fail or post as an account you did not intend.');
  }

  /* ── Tokens: presence and expiry only, never values ── */
  console.log('');
  console.log('═══ TOKENS ════════════════════════════════════');
  const botTok = await kv.get('twitch_bot_token', 'json');
  const botRefresh = await kv.get('twitch_bot_refresh_token');
  const bcTok = await kv.get('twitch_broadcaster_token', 'json');
  const bcRefresh = await kv.get('twitch_broadcaster_refresh_token');

  console.log(`  bot access token   : ${botTok ? 'stored, expires ' + ago(botTok.expiresAt) : 'MISSING'}`);
  console.log(`  bot refresh token  : ${botRefresh ? 'stored' : 'MISSING'}`);
  console.log(`  broadcaster token  : ${bcTok ? 'stored, expires ' + ago(bcTok.expiresAt) : 'MISSING'}`);
  console.log(`  broadcaster refresh: ${bcRefresh ? 'stored' : 'MISSING'}`);

  /* What the bot token can actually DO, which is the part the setup page
     gets wrong by reporting presence instead. */
  const botAccess = botTok && (botTok.access_token || botTok.token);
  if (botAccess) {
    try {
      const v = await fetch('https://id.twitch.tv/oauth2/validate', {
        headers: { Authorization: `OAuth ${botAccess}` },
      });
      if (v.ok) {
        const d = await v.json();
        console.log('');
        console.log(`  Twitch says this token belongs to: @${d.login} (id ${d.user_id})`);
        console.log(`  Scopes: ${(d.scopes || []).join(', ') || '(none)'}`);
        if (String(d.user_id) !== String(effectiveId)) {
          console.log('');
          console.log('  ⚠  The stored TOKEN belongs to a different account than the');
          console.log('     id the code will use. Chat sends will not work as expected.');
        }
      } else {
        console.log(`  Token validation: HTTP ${v.status} — the stored bot token is not valid.`);
      }
    } catch (err) {
      console.log(`  Token validation: could not reach Twitch (${err.message})`);
    }
  }

  console.log('');
  console.log('═══ BROADCASTER ═══════════════════════════════');
  const bcId = serviceVars.TWITCH_BROADCASTER_ID || process.env.TWITCH_BROADCASTER_ID;
  const bcUser = await resolveUser(clientId, appToken, bcId);
  console.log(`  TWITCH_BROADCASTER_ID: ${bcId || '(not set)'} ${bcId ? name(bcUser) : ''}`);

  await pool.end().catch(() => {});
}

main().catch(err => {
  console.error('[bot] FAILED:', err.message);
  process.exit(1);
});
