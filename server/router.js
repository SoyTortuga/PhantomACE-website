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

  /* Ad break state: whether one is running, and when the next is due.
     Library, no handler. Covered by server/scripts/test-ad-break.js. */
  'api/ads/state.js',

  /* The shared Twitch app access token. Library, no handler. */
  'api/auth/app-token.js',

  /* Live state + which broadcast is on air. Library, no handler. */
  'api/stream-info.js',

  /* Check-in history, streaks and arrival rewards. Library, no handler. */
  'api/checkin-rewards.js',

  /* Event badges earnable inside a window by checking in. Library, no
     handler. Covered by server/scripts/test-checkin-badges.js. */
  'api/checkin-badges.js',

  /* The Undead Executioner redemption-count badge ladder. Library, no
     handler; channel-points.js's raid-boss handler is what calls it.
     Covered by server/scripts/test-raid-badges.js. */
  'api/raid-badges.js',

  /* The chat scramble's answers. Data, no handler — split out of
     chat-game.js when the list passed a thousand entries. */
  'api/chat-game-words.js',

  /* Farkle scoring rules. Pure functions, no handler. Covered by
     server/scripts/test-scoring.js. */
  'api/mana-clash-scoring.js',

  /* The Phamily Time reward table — what each level actually grants.
     Library, no handler. It is the server's answer to "what is this reward
     worth", which used to come from the request body. */
  'api/phamily-rewards.js',

  /* MTGBBB scoring rules. Pure functions, no handler. Covered by
     server/scripts/test-mtgbbb.js. */
  'api/mtgbbb-scoring.js',

  /* MTGBBB set data — the Scryfall fetch, the permanent cache, the pool
     filter and the treatment table. Library, no handler; /api/mtgbbb/sets
     is the route that exposes it. Covered by
     server/scripts/test-mtgbbb-sets.js against a captured fixture. */
  'api/mtgbbb-scryfall.js',

  /* The forum's queries and its author-identity map. Libraries, no
     handler; the routes beside them in api/forum/ are what expose them.
     Covered by server/scripts/test-forum-queries.js against pglite. */
  'api/forum/queries.js',
  'api/forum/authors.js',
  /* Who may post where. Pure functions; covered by test-forum-posting.js
     including a mutation check that the rate limit is load-bearing. */
  'api/forum/rules.js',
  /* @mention parsing and resolution. Library, no handler; covered by
     test-forum-mentions.js. */
  'api/forum/mentions.js',

  /* My Room: the piece catalog and the validator every save goes through.
     Library, no handler; /api/room is the route. Covered by
     server/scripts/test-room-validator.js. */
  'api/room-catalog.js',
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
    /* DELETE is registered for the same reason GET and POST are: a route
       that exports a handler for it should be reachable. Media is the first
       user — removing an upload is a deletion, and expressing it as
       POST {action:'delete'} would have been a workaround for the router
       rather than a decision about the API. */
    if (typeof mod.onRequestDelete === 'function') handlers.DELETE = mod.onRequestDelete;
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
