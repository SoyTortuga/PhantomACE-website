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

  const server = http.createServer(async (req, res) => {
    try {
      if (!isHostAllowed(req, ALLOWED_HOSTS)) {
        res.writeHead(421, { 'Content-Type': 'text/plain' });
        res.end('Misdirected Request');
        return;
      }

      const url = new URL(PUBLIC_ORIGIN + (req.url || '/'));
      const method = (req.method || 'GET').toUpperCase();

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
          res.writeHead(405, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }
        if (!match) {
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
        const withNoStore = new Response(webRes.body, webRes);
        withNoStore.headers.set('Cache-Control', 'no-store');
        await writeWebResponse(res, withNoStore);
        return;
      }

      // ── static ────────────────────────────────────────────────
      const decision = statik.resolve(url.pathname, url.search);

      if (decision.kind === 'redirect') {
        res.writeHead(decision.status, { Location: decision.location, ...SECURITY_HEADERS });
        res.end();
        return;
      }

      if (decision.kind === 'notfound') {
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
