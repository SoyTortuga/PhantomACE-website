/* ══════════════════════════════════════════════
   Route table built from ../functions, mirroring Cloudflare Pages'
   file-based routing.

   Pages derives a route from a file's path: functions/api/inventory.js
   serves /api/inventory. Only two handler exports are used anywhere in
   this project — onRequestGet and onRequestPost — and there is no
   _middleware.js, so there's no middleware chain to reproduce.

   The single dynamic route is functions/cdn/media/[[path]].js — Cloudflare's
   double-bracket catch-all, mounted at /cdn/media/**, whose handler expects
   params.path as an ARRAY of segments. It's special-cased rather than
   supported by a general pattern engine, because one route doesn't justify
   one.

   SAFETY: functions/api/bot/send-chat.js lives under functions/ but exports
   no handler — it's a shared library with 11 exports (bot tokens, chat
   sending, giveaway code pulls) imported by 7 other files. Pages 404s it
   because it has no handler export. Relying on that same "no handler means
   not a route" rule here would be fragile: a future helper named
   onRequestGet in a library file would silently publish it. So libraries are
   named explicitly, and anything under functions/ that is neither a route
   nor a declared library fails the boot.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Files under functions/ that are libraries, not routes. */
const NON_ROUTE_MODULES = new Set([
  'api/bot/send-chat.js',
  /* Session signing/verification helpers. Publishing this as a route would
     expose nothing secret — it holds no key — but it is a library and the
     boot assertion below demands every file be declared one way or the
     other rather than guessed at. */
  'api/auth/session-crypto.js',

  /* The shared Twitch app access token. Library, no handler. */
  'api/auth/app-token.js',

  /* Live state + which broadcast is on air. Library, no handler. */
  'api/stream-info.js',

  /* Check-in history, streaks and arrival rewards. Library, no handler. */
  'api/checkin-rewards.js',
]);

/** Cloudflare's catch-all route, handled as a prefix match. */
const CATCHALL_FILE = 'cdn/media/[[path]].js';
const CATCHALL_PREFIX = '/cdn/media/';

function walk(dir, base = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel));
    else if (entry.name.endsWith('.js')) out.push(rel);
  }
  return out;
}

/** functions/api/bingo/create.js -> /api/bingo/create
    functions/api/foo/index.js    -> /api/foo   (Pages' index convention) */
function routeFor(relPath) {
  let r = '/' + relPath.replace(/\.js$/, '');
  if (r.endsWith('/index')) r = r.slice(0, -'/index'.length) || '/';
  return r;
}

/**
 * @param {string} functionsDir absolute path to ../functions
 * @returns {Promise<{routes: Map<string, object>, catchAll: object|null, count: number}>}
 */
export async function buildRoutes(functionsDir) {
  const files = walk(functionsDir);
  const routes = new Map();
  let catchAll = null;
  const problems = [];

  for (const rel of files) {
    if (NON_ROUTE_MODULES.has(rel)) continue;

    const mod = await import(pathToFileURL(path.join(functionsDir, rel)).href);
    const handlers = {};
    if (typeof mod.onRequestGet === 'function') handlers.GET = mod.onRequestGet;
    if (typeof mod.onRequestPost === 'function') handlers.POST = mod.onRequestPost;
    if (typeof mod.onRequest === 'function') handlers.ALL = mod.onRequest;

    if (!Object.keys(handlers).length) {
      // Neither a route nor a declared library — refuse to guess.
      problems.push(rel);
      continue;
    }

    if (rel === CATCHALL_FILE) {
      catchAll = { prefix: CATCHALL_PREFIX, handlers };
      continue;
    }
    routes.set(routeFor(rel), handlers);
  }

  if (problems.length) {
    console.error('FATAL: files under functions/ export no request handler and are not');
    console.error('declared in NON_ROUTE_MODULES. Add them to that set if they are');
    console.error('libraries, or give them a handler if they are routes:');
    for (const p of problems) console.error('   functions/' + p);
    process.exit(1);
  }

  return { routes, catchAll, count: routes.size + (catchAll ? 1 : 0) };
}

/**
 * Resolve a pathname to a handler.
 * @returns {{handler: Function, params: object}|null|'method-not-allowed'}
 */
export function matchRoute({ routes, catchAll }, pathname, method) {
  /* HEAD must work anywhere GET does — it's what uptime monitors, link
     previewers and proxies use, and RFC 9110 defines it as GET without a
     body. The handlers only export onRequestGet, so resolve HEAD against the
     GET handler and let the caller drop the body. (Rejecting HEAD outright
     was a real bug: every route 405'd for it.) */
  const lookup = method === 'HEAD' ? 'GET' : method;

  const entry = routes.get(pathname);
  if (entry) {
    const h = entry[lookup] || entry.ALL;
    return h ? { handler: h, params: {} } : 'method-not-allowed';
  }
  if (catchAll && pathname.startsWith(catchAll.prefix)) {
    const h = catchAll.handlers[lookup] || catchAll.handlers.ALL;
    if (!h) return 'method-not-allowed';
    const rest = pathname.slice(catchAll.prefix.length);
    // The handler does params.path.join('/'), so it must be an array.
    return { handler: h, params: { path: rest ? rest.split('/') : [] } };
  }
  return null;
}
