/* ══════════════════════════════════════════════
   CRAFTY CONTROLLER — the panel that actually runs the server

   A library, not a route. Declared in NON_ROUTE_MODULES.

   WHAT IT BUYS US, over what was already here:

     status   The Server List Ping can only say "the port answered". Crafty
              knows the difference between stopped, starting, running and
              CRASHED — and can still answer while the server is down,
              which is exactly when somebody is looking at the page asking
              why they cannot get on.

     joins    `whitelist add <name>` through the console the moment someone
              puts their name in, instead of waiting for the next scheduled
              file pull. The pull stays as the reconciler that removes
              lapsed subs; this just makes joining instant.

   EVERYTHING HERE IS OPTIONAL. With no CRAFTY_URL configured every function
   returns null and the callers fall back to what they did before: ping for
   status, scheduled file sync for the whitelist. A wrong token or a panel
   that is down must never stop a subscriber adding their name — the file
   sync will still pick them up.

   TLS: Crafty serves HTTPS on 8443 with a SELF-SIGNED certificate out of
   the box, so a strict client cannot talk to it. That is a real decision,
   not a detail to paper over, so it is strict by default and the operator
   opts out explicitly with CRAFTY_INSECURE_TLS=1. Never by setting
   NODE_TLS_REJECT_UNAUTHORIZED — that would disable verification for
   Twitch, Mojang and every other call this server makes.
   ══════════════════════════════════════════════ */

import https from 'node:https';
import http from 'node:http';

const TIMEOUT_MS = 4000;

/**
 * The configuration, or null when Crafty is not wired up.
 * Read per call rather than cached: env is injected per request, and a
 * cached null would survive the operator adding the token until a restart.
 */
export function craftyConfig(env) {
  const url = env && env.CRAFTY_URL;
  const token = env && env.CRAFTY_TOKEN;
  const serverId = env && env.CRAFTY_SERVER_ID;
  if (!url || !token || !serverId) return null;
  let base;
  try { base = new URL(url); } catch { return null; }
  if (base.protocol !== 'https:' && base.protocol !== 'http:') return null;
  return {
    base,
    token,
    serverId: String(serverId),
    /* Opt-in, and only meaningful for https. */
    insecure: String((env && env.CRAFTY_INSECURE_TLS) || '') === '1',
  };
}

/** One request, with a hard timeout and no throw. */
function request(cfg, { method, path, body, contentType }) {
  return new Promise((resolve) => {
    const isHttps = cfg.base.protocol === 'https:';
    const lib = isHttps ? https : http;
    const payload = body == null ? null : Buffer.from(body, 'utf8');

    const headers = { Authorization: `Bearer ${cfg.token}`, Accept: 'application/json' };
    if (payload) {
      headers['Content-Type'] = contentType || 'application/json';
      headers['Content-Length'] = String(payload.length);
    }

    const options = {
      protocol: cfg.base.protocol,
      hostname: cfg.base.hostname,
      port: cfg.base.port || (isHttps ? 443 : 80),
      path: (cfg.base.pathname.replace(/\/$/, '')) + path,
      method,
      headers,
      timeout: TIMEOUT_MS,
    };
    if (isHttps && cfg.insecure) options.rejectUnauthorized = false;

    const req = lib.request(options, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; if (data.length > 200000) req.destroy(); });
      res.on('end', () => resolve({ status: res.statusCode, text: data }));
    });

    req.on('error', (err) => {
      /* The self-signed case has its own message, because the fix is a
         setting and not something anybody would guess from "socket hang
         up". */
      const selfSigned = /self.signed|unable to verify|DEPTH_ZERO/i.test(err.message || '');
      resolve({
        status: 0,
        error: selfSigned
          ? `Crafty is using a self-signed certificate. Set CRAFTY_INSECURE_TLS=1 in server/.env to accept it (${err.message})`
          : err.message,
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'Crafty did not answer in time' }); });

    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Live status from the panel.
 * @returns null when Crafty is not configured or could not be reached —
 *          the caller falls back to pinging the game port.
 */
export async function craftyStats(env) {
  const cfg = craftyConfig(env);
  if (!cfg) return null;

  const res = await request(cfg, { method: 'GET', path: `/api/v2/servers/${encodeURIComponent(cfg.serverId)}/stats` });
  if (res.status !== 200) {
    console.error('[crafty] stats:', res.error || `HTTP ${res.status}`);
    return null;
  }
  let body;
  try { body = JSON.parse(res.text); } catch { return null; }
  const d = body && (body.data && body.data.stats ? body.data.stats : body);
  if (!d || typeof d !== 'object') return null;

  /* `running` is the panel's own view of the process; the port answering
     is a separate question and a crashed server can still hold the port
     briefly. Trust the panel. */
  const running = d.running === true || d.running === 'true';
  return {
    online: running,
    players: Number(d.online) || 0,
    max: Number(d.max) || 0,
    version: String(d.version || ''),
    motd: String(d.desc || ''),
    /* The two states a ping cannot distinguish from "offline", and the two
       the page most needs to say out loud. */
    crashed: d.crashed === true || d.crashed === 'true',
    starting: d.waiting_start === true || d.waiting_start === 'true',
    source: 'crafty',
  };
}

/* Minecraft usernames only. This string is concatenated into a console
   command, so it is the one place an injected space would turn
   `whitelist add x` into `whitelist add x; op x`. Mojang has already
   validated the name by the time it gets here; this refuses to rely on
   that being true forever. */
const SAFE_NAME = /^[A-Za-z0-9_]{3,16}$/;

/**
 * Add or remove a name on the live server, without waiting for the file
 * sync. Best effort by design — see the header.
 * @returns {{ok: boolean, skipped?: string, error?: string}}
 */
export async function craftyWhitelist(env, action, name) {
  const cfg = craftyConfig(env);
  if (!cfg) return { ok: false, skipped: 'not-configured' };
  if (action !== 'add' && action !== 'remove') return { ok: false, error: 'bad action' };
  if (!SAFE_NAME.test(String(name || ''))) return { ok: false, error: 'bad name' };

  /* "Don't sent the slash!" — the panel's own words. A leading slash is
     echoed to chat as a failed command rather than executed. */
  const res = await request(cfg, {
    method: 'POST',
    path: `/api/v2/servers/${encodeURIComponent(cfg.serverId)}/stdin`,
    body: `whitelist ${action} ${name}`,
    contentType: 'text/plain',
  });

  if (res.status !== 200) {
    const why = res.error || `HTTP ${res.status}`;
    console.error(`[crafty] whitelist ${action} ${name}:`, why);
    return { ok: false, error: why };
  }
  return { ok: true };
}
