/* ══════════════════════════════════════════════
   Node http <-> Fetch API adapter.

   The ~31 route handlers under ../functions were written for
   Cloudflare Pages Functions: they take a `context` object and
   return a Web `Response`. Node 24 ships Request/Response/Headers/
   FormData/URL/fetch/crypto.subtle as real globals, so nothing here
   is a polyfill — this only translates between Node's
   IncomingMessage/ServerResponse and those Web objects, letting the
   handlers stay byte-for-byte unchanged.

   Two things here are load-bearing and easy to break:

   1. THE BODY IS NEVER BUFFERED. It's attached as a lazy stream, so
      nothing reads it until a handler calls .text()/.json()/.formData().
      Four EventSub webhook routes (hype-train, channel-points,
      bot/commands, bot/giveaway-entry) HMAC the RAW body text; if any
      middleware consumed or re-encoded the stream first, every Twitch
      webhook would fail signature verification and silently 403.
      This is also why the server deliberately has no body-parsing layer.

   2. THE URL IS BUILT FROM PUBLIC_ORIGIN, not from the request. Node's
      req.url is path-only ("/api/x?y=1") and req.headers.host is
      localhost behind the Cloudflare Tunnel. Handlers call
      `new URL(request.url)` in 24 places and read `.origin` in two of
      them to construct Twitch OAuth redirect_uris (which must match
      EXACTLY or login fails), EventSub callback URLs, and post-login
      redirects. They also gate the session cookie's Secure flag on
      `url.protocol === 'https:'`. Synthesizing the real public origin
      makes all of that correct with zero handler edits.
   ══════════════════════════════════════════════ */

import { Readable } from 'node:stream';

/* Methods that never carry a body. Passing a body stream for these
   makes the Request constructor throw. */
const BODYLESS = new Set(['GET', 'HEAD', 'OPTIONS', 'DELETE']);

/* ── REQUEST BODY CAP ────────────────────────────────────────────────────
   The body used to stream into handlers unbounded, so one client could make
   a handler's .json()/.text() buffer gigabytes. 1 MB covers every JSON route
   with a wide margin (the largest legitimate payload is a Dino Park favourite
   carrying an inline image, capped at 24 KB by its handler). The media
   upload route takes a 10 MB file (MAX_SIZE in functions/api/media/upload.js)
   inside multipart framing, so it gets 12 MB.

   Enforced twice: a declared Content-Length over the cap is refused before
   the handler runs; a chunked body that grows past it errors the stream the
   handler is reading and the server answers 413 in place of whatever the
   handler made of the failed read. Bytes are passed through untouched, so
   the EventSub HMAC over the raw body (note 1 above) still verifies. */
export const DEFAULT_BODY_LIMIT = 1024 * 1024;
export const BODY_LIMITS = new Map([
  ['/api/media/upload', 12 * 1024 * 1024],
]);

export function bodyLimitFor(pathname) {
  return BODY_LIMITS.get(pathname) ?? DEFAULT_BODY_LIMIT;
}

/** True when the client has already declared a body larger than `limit`. */
export function declaredBodyTooLarge(req, limit) {
  const raw = req.headers['content-length'];
  if (raw === undefined) return false;
  const n = Number(raw);
  return Number.isFinite(n) && n > limit;
}

export class BodyTooLargeError extends Error {
  constructor(limit) {
    super(`request body exceeds ${limit} bytes`);
    this.name = 'BodyTooLargeError';
    this.status = 413;
  }
}

/* A web ReadableStream over the request that counts bytes. On overflow it
   marks req.bodyTooLarge, errors the stream the handler is reading, and
   PAUSES the request rather than destroying it — destroying the request
   destroys the socket, and the server still owes the client a 413. */
function limitedBody(req, limit) {
  let seen = 0;
  let done = false;
  return new ReadableStream({
    start(controller) {
      req.on('data', (chunk) => {
        if (done) return;
        seen += chunk.length;
        if (seen > limit) {
          done = true;
          req.bodyTooLarge = true;
          req.pause();
          controller.error(new BodyTooLargeError(limit));
          return;
        }
        controller.enqueue(new Uint8Array(chunk));
        if (controller.desiredSize !== null && controller.desiredSize <= 0) req.pause();
      });
      req.on('end', () => { if (!done) { done = true; try { controller.close(); } catch { /* already errored */ } } });
      req.on('error', (err) => { if (!done) { done = true; try { controller.error(err); } catch { /* already closed */ } } });
      req.pause();
    },
    pull() { if (!done) req.resume(); },
    cancel() { done = true; req.pause(); },
  });
}

/**
 * Build a Web Request from a Node IncomingMessage.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {string} publicOrigin e.g. "https://phantomace.tv" (no trailing slash)
 * @param {{ maxBodyBytes?: number }} [options]
 * @returns {Request}
 */
export function toWebRequest(req, publicOrigin, options = {}) {
  const url = publicOrigin + (req.url || '/');

  // Node lowercases header names and may give arrays for repeated headers.
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(name, v);
    } else {
      headers.set(name, value);
    }
  }

  const init = { method: req.method, headers };

  if (!BODYLESS.has((req.method || 'GET').toUpperCase())) {
    // Lazy, byte-exact stream — see note 1 above and the body cap.
    // `duplex: 'half'` is required by the spec when constructing a Request
    // from a stream.
    const limit = Number.isFinite(options.maxBodyBytes) ? options.maxBodyBytes : DEFAULT_BODY_LIMIT;
    init.body = limitedBody(req, limit);
    init.duplex = 'half';
  }

  return new Request(url, init);
}

/* ── CLIENT IP ───────────────────────────────────────────────────────────
   The server binds 127.0.0.1 and the Cloudflare Tunnel is its only public
   ingress, so the socket address is always loopback; the real client is in
   CF-Connecting-IP, which cloudflared sets on every proxied request. A
   request with NO such header came from a process on the rig itself (the
   bot service, scripts), reported as `local`. */
export function clientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string') {
    const v = cf.trim();
    if (v && v.length <= 64 && /^[0-9A-Fa-f:.]+$/.test(v)) return { ip: v, local: false };
  }
  const sock = (req.socket && req.socket.remoteAddress) || '';
  const local = sock === '127.0.0.1' || sock === '::1' || sock === '::ffff:127.0.0.1';
  return { ip: sock || 'unknown', local };
}

/* ── RATE LIMITING ───────────────────────────────────────────────────────
   In-memory token buckets, one per (class, client IP). Single process by
   design (see index.js), so in-memory is exact — no shared store needed.

   Limits are GENEROUS by default. The broadcaster's OBS overlay alone polls
   several panels once a second from one IP, plus the dashboard and a game
   tab, so the default allows a sustained 15 req/s with a 600-request burst:
   it exists to stop floods, not to shape normal use. Auth routes are
   tighter because each one costs Twitch API calls. Twitch's EventSub
   deliveries and /api/health are never limited — Twitch retries and then
   REVOKES a subscription that keeps failing, and an uptime monitor must
   not be told the site is down because it checked too often.

   Memory is bounded two ways: a sweep drops buckets that have refilled to
   full (an idle client is indistinguishable from a new one, so forgetting
   it changes nothing), and a hard cap on entries evicts least-recently-used
   buckets if a flood of distinct IPs arrives between sweeps. */
export const RATE_CLASSES = {
  default: { capacity: 600, refillPerSec: 15 },
  auth: { capacity: 20, refillPerSec: 1 / 6 },          // ~10 logins/min sustained
  recheck: { capacity: 10, refillPerSec: 1 / 10 },      // ~6/min sustained
};

/* Every route Twitch posts EventSub notifications to (bot-setup.js builds
   these callback URLs). POST only — a GET to one of these paths is an
   ordinary request and is limited like any other. */
export const EVENTSUB_PATHS = new Set([
  '/api/hype-train',
  '/api/channel-points',
  '/api/prediction-events',
  '/api/milestones',
  '/api/bot/commands',
  '/api/bot/giveaway-entry',
  '/api/ad-break',
  '/api/bits',
  '/api/channel-update',
]);

/** Which bucket class a request draws from, or null when it is exempt. */
export function rateClassFor(pathname, method) {
  if (!pathname.startsWith('/api/')) return null;
  if (pathname === '/api/health') return null;
  if (method === 'POST' && EVENTSUB_PATHS.has(pathname)) return null;
  if (pathname === '/api/auth/recheck-roles') return 'recheck';
  if (pathname.startsWith('/api/auth/')) return 'auth';
  return 'default';
}

export function createRateLimiter({ classes = RATE_CLASSES, maxEntries = 20_000, now = () => Date.now() } = {}) {
  const buckets = new Map();     // key → { tokens, last } ; Map order = LRU

  function take(cls, ip) {
    const spec = classes[cls];
    if (!spec) return { allowed: true };
    const key = cls + '|' + ip;
    const t = now();
    let b = buckets.get(key);
    if (b) {
      buckets.delete(key);       // re-inserted below → most recently used
      b.tokens = Math.min(spec.capacity, b.tokens + ((t - b.last) / 1000) * spec.refillPerSec);
      b.last = t;
    } else {
      b = { tokens: spec.capacity, last: t };
    }
    buckets.set(key, b);
    while (buckets.size > maxEntries) buckets.delete(buckets.keys().next().value);

    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { allowed: true };
    }
    const retryAfterSec = Math.max(1, Math.ceil((1 - b.tokens) / spec.refillPerSec));
    return { allowed: false, retryAfterSec };
  }

  /** Drop buckets that would be full by now. Returns how many were removed. */
  function sweep() {
    const t = now();
    let removed = 0;
    for (const [key, b] of buckets) {
      const spec = classes[key.slice(0, key.indexOf('|'))];
      if (!spec || b.tokens + ((t - b.last) / 1000) * spec.refillPerSec >= spec.capacity) {
        buckets.delete(key);
        removed++;
      }
    }
    return removed;
  }

  return { take, sweep, get size() { return buckets.size; } };
}

/* ── ACCESS-LOG POLICY ───────────────────────────────────────────────────
   Logging every request buried the log under 1-second overlay polls and
   static assets. Kept: every error (4xx/5xx), every state-changing request,
   every auth/OAuth hop (the reason the access log exists — "did the
   callback reach the server?"), and anything slow. Dropped: successful
   static files and successful read-only API polls. */
const QUIET_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const SLOW_REQUEST_MS = 2000;

export function shouldLogRequest({ method, pathname, status, ms = 0 }) {
  if (status >= 400) return true;
  if (ms >= SLOW_REQUEST_MS) return true;
  if (!QUIET_METHODS.has(String(method || 'GET').toUpperCase())) return true;
  if (pathname.startsWith('/api/auth/') || pathname === '/api/admin/bot-setup') return true;
  return false;
}

/* Collapses a repeating warning to one line per window with a count of what
   was suppressed, so a scanner or an expired cookie on a 1-second poll
   cannot flood the log. Keys are few and fixed (call sites pass constants),
   so the map cannot grow without bound. */
export function createWarnLimiter({ windowMs = 60_000, now = () => Date.now(), sink = console.warn } = {}) {
  const seen = new Map();        // key → { at, suppressed }
  return function warn(key, message) {
    const t = now();
    const s = seen.get(key);
    if (s && t - s.at < windowMs) { s.suppressed++; return false; }
    const extra = s && s.suppressed ? ` (+${s.suppressed} similar suppressed)` : '';
    seen.set(key, { at: t, suppressed: 0 });
    sink(message + extra);
    return true;
  };
}

/**
 * Write a Web Response out through a Node ServerResponse.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {Response} webRes
 */
export async function writeWebResponse(res, webRes) {
  const headers = {};
  // Set-Cookie must not be collapsed into a single comma-joined header;
  // getSetCookie() preserves them as separate values.
  const setCookies = typeof webRes.headers.getSetCookie === 'function'
    ? webRes.headers.getSetCookie()
    : [];
  for (const [name, value] of webRes.headers) {
    if (name.toLowerCase() === 'set-cookie') continue;
    headers[name] = value;
  }
  if (setCookies.length) headers['set-cookie'] = setCookies;

  res.writeHead(webRes.status, headers);

  if (!webRes.body) {
    res.end();
    return;
  }

  // Stream rather than buffer, so large responses don't sit in memory.
  Readable.fromWeb(webRes.body).pipe(res);
}

/**
 * Guard against the synthetic origin being abused.
 *
 * Because the adapter trusts PUBLIC_ORIGIN rather than the Host header,
 * a request arriving with an unexpected Host would otherwise be handled
 * as though it were the real site. In practice the Cloudflare Tunnel is
 * the only ingress and the server binds to localhost, so this is
 * defence-in-depth — but it's one line of config and it closes off
 * host-header confusion entirely.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {Set<string>} allowedHosts lowercase hostnames (no port)
 * @returns {boolean}
 */
export function isHostAllowed(req, allowedHosts) {
  const raw = req.headers.host;
  if (!raw) return false;
  const host = String(raw).toLowerCase().split(':')[0];
  return allowedHosts.has(host);
}
