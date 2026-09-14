/* ══════════════════════════════════════════════
   PhantomACE self-hosted server.

   Serves the static site AND the /api routes from one process, replacing
   Cloudflare Pages. The route handlers under ../functions are used
   unmodified; adapter.js translates between Node's http objects and the
   Fetch Request/Response they expect, and lib/kv.js gives them an object
   with Cloudflare KV's exact four-method shape backed by Postgres.

   RUN EXACTLY ONE INSTANCE. Mana Clash and PhamShock advance their round
   timers lazily inside the poll handler rather than on a scheduler, so a
   second process polling concurrently would double-advance rounds. No
   cluster mode.
   ══════════════════════════════════════════════ */

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import send from 'send';
import 'dotenv/config';

import { toWebRequest, writeWebResponse, isHostAllowed } from './adapter.js';
import { verifySession, readCookie } from '../functions/api/auth/session-crypto.js';
import { createStatic } from './static.js';
import { buildRoutes, matchRoute } from './router.js';
import { createPool, waitForDatabase } from './lib/db.js';
import { createKVStore } from './lib/kv.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const FUNCTIONS_DIR = path.join(ROOT, 'functions');

const PORT = Number(process.env.PORT || 8789);
const PUBLIC_ORIGIN = (process.env.PUBLIC_ORIGIN || `http://127.0.0.1:${PORT}`).replace(/\/$/, '');

/* Secrets that must exist before this server is reachable from the internet.
   TWITCH_EVENTSUB_SECRET especially: the webhook handlers skip signature
   verification when it's absent, which on a public box means anyone can POST
   forged Twitch events. */
const REQUIRED_SECRETS = [
  'TWITCH_CLIENT_ID',
  'TWITCH_CLIENT_SECRET',
  'TWITCH_EVENTSUB_SECRET',
  'TWITCH_BROADCASTER_ID',
  'BOT_SERVICE_SECRET',
  /* Without this nothing can verify a session signature, so every request
     would arrive looking logged out — including the broadcaster's. Refusing
     to boot is far better than serving a site where nobody can log in and
     the reason is invisible. */
  'SESSION_SECRET',
];

const ALLOWED_HOSTS = new Set([
  'phantomace.tv',
  'www.phantomace.tv',
  'dev.phantomace.tv',
  'localhost',
  '127.0.0.1',
]);

/* Ported from _headers. The /api/* block from that file is deliberately NOT
   ported: it was verified inert on Pages, and applying its
   `Cache-Control: public, max-age=60` would newly cache per-user
   authenticated responses and stale the 2s game polling. API responses get
   no-store instead. */
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

/** How often expired rows are swept. Purely disk reclamation — reads are
    already filtered by expires_at, so correctness never waits on this. */
const REAP_INTERVAL_MS = 60_000;

/* Access log. Cloudflare gave us request visibility for free; self-hosted,
   there is none unless we write it. Without this you cannot answer basic
   questions like "did the OAuth callback actually reach this server?" —
   which is exactly the question that came up during login testing, where a
   successful 302 produced no output at all.

   Query strings are NOT logged verbatim: the OAuth callback carries ?code=,
   a single-use authorization code, and logs get pasted into chat and issue
   trackers. Only the parameter NAMES are recorded. */
function logRequest(req, url, status, startedAt) {
  const ms = Date.now() - startedAt;
  const params = [...url.searchParams.keys()];
  const q = params.length ? ` ?${params.join(',')}` : '';
  console.log(`[req] ${String(status)} ${(req.method || 'GET').padEnd(4)} ${url.pathname}${q} ${ms}ms`);
}

function isPublicOrigin(origin) {
  return !/^https?:\/\/(127\.0\.0\.1|localhost)(:|$)/.test(origin);
}

function validateEnvironment() {
  const missing = REQUIRED_SECRETS.filter(k => !process.env[k]);
  if (!missing.length) return;

  if (isPublicOrigin(PUBLIC_ORIGIN)) {
    console.error(`FATAL: missing required secrets: ${missing.join(', ')}`);
    console.error(`PUBLIC_ORIGIN is ${PUBLIC_ORIGIN}, i.e. internet-reachable.`);
    console.error('Refusing to start: EventSub webhooks would accept unsigned requests.');
    console.error('Fill them in server/.env (see server/.env.example).');
    process.exit(1);
  }
  console.warn(`[boot] WARNING missing secrets: ${missing.join(', ')}`);
  console.warn('[boot] Allowed only because PUBLIC_ORIGIN is loopback. Twitch-dependent');
  console.warn('[boot] routes will fail; static serving and routing are testable.');
}

async function main() {
  validateEnvironment();

  const statik = createStatic(ROOT);
  statik.assertPrivatePathsUnreachable();
  console.log(`[boot] static allowlist OK (${statik.rootHtmlFiles.size} root pages)`);

  const table = await buildRoutes(FUNCTIONS_DIR);
  console.log(`[boot] mounted ${table.count} routes from functions/`);

  if (!process.env.DATABASE_URL) {
    console.error('FATAL: DATABASE_URL is not set. See server/.env.example.');
    process.exit(1);
  }
  const pool = createPool(process.env.DATABASE_URL);
  const info = await waitForDatabase();
  console.log(`[boot] postgres ready: ${info.db}`);

  /* The handlers receive this as env.MARKETPLACE and cannot tell it from the
     Cloudflare KV binding — which is the entire point, and why none of the
     183 storage call sites needed editing. */
  const store = createKVStore(pool);
  const env = { ...process.env, MARKETPLACE: store };

  setInterval(() => {
    store.reap()
      .then(n => { if (n) console.log(`[reap] removed ${n} expired row(s)`); })
      .catch(err => console.error('[reap]', err.message));
  }, REAP_INTERVAL_MS).unref();

  /* ── Rotating chat announcements ────────────────────────────────────────
     Checked every minute; the module decides whether anything is due, and
     refuses to post while the channel is offline. It lives here rather than
     in the control panel because a browser-driven timer stops when the tab
     closes and doubles up when two are open. Safe as a single interval for
     the same reason the whole server is single-instance: Mana Clash and
     PhamShock already advance round timers in-process. */
  setInterval(() => {
    import('../functions/api/bot/announcements.js')
      .then(m => m.tickAnnouncements(env))
      .then(r => { if (r && r.posted) console.log(`[announce] posted${r.sent ? '' : ' (Twitch refused it)'}`); })
      .catch(err => console.error('[announce]', err.message));
  }, 60000).unref();

  /* ── Broadcast log ──────────────────────────────────────────────────────
     Records each stream as it goes live, so check-in streaks know what the
     previous broadcast was. Written here rather than on a check-in
     deliberately: a stream NOBODY checks into still has to count, or a
     viewer who attended two streams a month apart would look consecutive.
     recordStream is idempotent per stream id, so running every minute
     appends once per broadcast. */
  setInterval(() => {
    Promise.all([
      import('../functions/api/stream-info.js'),
      import('../functions/api/checkin-rewards.js'),
    ])
      .then(([info, rewards]) => info.getStreamInfo(env).then(s => (
        s.live && s.streamId ? rewards.recordStream(env, s.streamId, s.startedAt) : false
      )))
      .then(added => { if (added) console.log('[stream] new broadcast recorded'); })
      .catch(err => console.error('[stream]', err.message));
  }, 60000).unref();

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    try {
      if (!isHostAllowed(req, ALLOWED_HOSTS)) {
        console.warn(`[req] 421 rejected Host: ${req.headers.host}`);
        res.writeHead(421, { 'Content-Type': 'text/plain' });
        res.end('Misdirected Request');
        return;
      }

      const url = new URL(PUBLIC_ORIGIN + (req.url || '/'));
      const method = (req.method || 'GET').toUpperCase();

      /* ── THE SESSION GATE ────────────────────────────────────────────
         Every request passes through here, so this is the one place a
         session is verified. The 23 getSession() copies scattered across
         functions/ are left exactly as they are: they parse plain JSON,
         and by the time they run the header either holds a session whose
         signature checked out, or holds nothing at all.

         Verifying inside those 23 copies instead would mean 23 chances to
         miss one, and one miss is a total bypass. This cannot be missed.

         An invalid or forged cookie is STRIPPED rather than rejected with
         an error: the request simply proceeds as logged out, which is what
         a tampered cookie deserves and keeps public pages working for
         someone with stale cookie state. */
      const rawCookie = readCookie(req.headers.cookie, 'pham_session');
      if (rawCookie) {
        const session = await verifySession(rawCookie, process.env.SESSION_SECRET);
        if (session) {
          /* Rewritten into the legacy plain form the handlers already
             parse, so signing needed no changes across 23 files. */
          req.headers.cookie = `pham_session=${encodeURIComponent(JSON.stringify(session))}`;
        } else {
          const others = String(req.headers.cookie || '')
            .split(';')
            .map(s => s.trim())
            .filter(s => s && !s.startsWith('pham_session='));
          req.headers.cookie = others.join('; ');
          console.warn(`[auth] rejected an unverifiable session cookie on ${url.pathname}`);
        }
      }

      /* Not a file under functions/ — this server is a single point of
         failure in a way Cloudflare Pages never was, so it needs something
         an external uptime monitor can watch. Touches the database
         deliberately: a process that is up but cannot reach Postgres serves
         500s on every API route and should read as down, not healthy. */
      if (url.pathname === '/api/health') {
        let dbOk = false;
        try { await pool.query('SELECT 1'); dbOk = true; } catch { /* reported below */ }
        res.writeHead(dbOk ? 200 : 503, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        logRequest(req, url, dbOk ? 200 : 503, started);
        res.end(JSON.stringify({
          ok: dbOk,
          database: dbOk ? 'up' : 'unreachable',
          uptimeSeconds: Math.round(process.uptime()),
          routes: table.count,
        }));
        return;
      }

      const isApi = url.pathname.startsWith('/api/') || url.pathname.startsWith('/cdn/');

      if (isApi) {
        const match = matchRoute(table, url.pathname, method);
        if (match === 'method-not-allowed') {
          logRequest(req, url, 405, started);
          res.writeHead(405, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }
        if (!match) {
          logRequest(req, url, 404, started);
          res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ error: 'Not found' }));
          return;
        }
        const request = toWebRequest(req, PUBLIC_ORIGIN);
        const webRes = await match.handler({
          env,
          request,
          params: match.params,
          // No request-lifetime extension is needed in Node; the process
          // outlives the response. Swallow failures so a background task
          // can't take down the request.
          waitUntil: (p) => { Promise.resolve(p).catch(e => console.error('[waitUntil]', e)); },
        });
        if (!webRes || typeof webRes.status !== 'number') {
          throw new Error(`handler for ${url.pathname} did not return a Response`);
        }
        const withNoStore = new Response(method === 'HEAD' ? null : webRes.body, webRes);
        withNoStore.headers.set('Cache-Control', 'no-store');
        logRequest(req, url, withNoStore.status, started);
        await writeWebResponse(res, withNoStore);
        return;
      }

      // ── static ────────────────────────────────────────────────
      const decision = statik.resolve(url.pathname, url.search);

      if (decision.kind === 'redirect') {
        logRequest(req, url, decision.status, started);
        res.writeHead(decision.status, { Location: decision.location, ...SECURITY_HEADERS });
        res.end();
        return;
      }

      if (decision.kind === 'notfound') {
        logRequest(req, url, 404, started);
        const notFoundPage = path.join(ROOT, '404.html');
        const headers = { ...SECURITY_HEADERS, 'Content-Type': 'text/html; charset=utf-8' };
        if (fs.existsSync(notFoundPage)) {
          res.writeHead(404, headers);
          fs.createReadStream(notFoundPage).pipe(res);
        } else {
          res.writeHead(404, headers);
          res.end('Not Found');
        }
        return;
      }

      const extra = { ...SECURITY_HEADERS };
      if (url.pathname.startsWith('/games/')) {
        extra['Content-Security-Policy'] = "frame-ancestors 'self'";
      }
      for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
      logRequest(req, url, 200, started);
      // `send` handles HEAD, conditional GETs and Range on its own.
      send(req, decision.relPath, { root: ROOT, dotfiles: 'deny', index: false }).pipe(res);
    } catch (err) {
      console.error('[request]', req.method, req.url, err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      }
      res.end(JSON.stringify({ error: 'Internal error' }));
    }
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[boot] listening on http://127.0.0.1:${PORT}`);
    console.log(`[boot] public origin: ${PUBLIC_ORIGIN}`);
  });
}

main().catch(err => {
  console.error('[fatal]', err);
  process.exit(1);
});
