/* ══════════════════════════════════════════════
   SESSION COOKIE SIGNING

   pham_session used to be plain JSON, unsigned, carrying `role` — and 23
   files trusted it for authorization, including the broadcaster-only admin
   panel and the bot drop controls. Anyone could set role:"broadcaster" in
   their own browser and have it.

   The cookie stays READABLE on purpose. The frontend uses it for the display
   name, avatar and role-gated UI, so turning it into an opaque blob would
   mean an extra round trip on every page load. Readable is fine; FORGEABLE
   was the problem. So the payload is plain, and an HMAC is appended:

       pham_session = <base64url(json)>.<base64url(hmac-sha256)>

   Anyone can read it. Only the server can produce a valid one.

   WHERE IT IS VERIFIED. Once, in server/index.js, before any handler runs.
   Doing it in the 23 getSession() copies would mean 23 chances to miss one,
   and a single missed copy is a complete bypass. The server verifies, then
   rewrites the header into the legacy plain format, so every existing
   handler keeps working untouched and CANNOT see an unverified session.

   This module is imported by both the signer and the verifier deliberately:
   if the two ever disagreed about the format, every user on the site would
   be silently logged out.
   ══════════════════════════════════════════════ */

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64urlFromBytes(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function bytesFromB64url(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

/* Constant-time compare. A length-dependent early return would leak how much
   of a forged signature was correct, which is enough to reconstruct one byte
   at a time. Written by hand rather than using node:crypto's timingSafeEqual
   so the same module runs unchanged in both places that need it. */
function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/* ── SESSION LIFETIME ────────────────────────────────────────────────────
   A signed session used to be valid forever: the cookie's Max-Age told the
   BROWSER to drop it after a day, but a copied cookie value replayed by
   anyone else verified indefinitely. The lifetime now lives inside the
   signed payload (iat/exp, unix seconds) and is enforced by verifySession.

   SESSION_MAX_AGE_SEC matches the cookie Max-Age every issuer sets (login
   and recheck-roles both use 86400), so the browser and the server agree on
   when a session ends.

   RE-SIGNING DOES NOT EXTEND A SESSION. recheck-roles reissues the cookie
   from `{ ...session }`, so an existing exp is carried over (and clamped to
   at most one max-age from now). If re-signing restamped exp, anyone
   holding a stolen cookie could refresh it forever by calling that endpoint.
   Only a real Twitch login starts a new lifetime. */
export const SESSION_MAX_AGE_SEC = 86400;

/* LEGACY COOKIES (issued before iat/exp existed). Rejecting them outright at
   deploy would log every viewer out at once, possibly mid-stream, with
   nothing to explain it. They are accepted until this cutoff instead:
   browsers already drop them a day after they were last issued, and any
   that recheck-roles reissues in the meantime gets an exp stamped on it, so
   by the cutoff essentially none are left and nobody legitimate notices.
   If the deploy slips past this date, legacy cookies are refused on the
   first request and those viewers simply sign in again once. Override with
   SESSION_LEGACY_CUTOFF (ISO date) in server/.env if needed. */
export const LEGACY_SESSION_CUTOFF = '2026-10-16T00:00:00Z';

function nowSec() { return Math.floor(Date.now() / 1000); }

function legacyCutoffSec() {
  const raw = (typeof process !== 'undefined' && process.env && process.env.SESSION_LEGACY_CUTOFF) || LEGACY_SESSION_CUTOFF;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
}

/**
 * Produce the cookie VALUE (not the whole Set-Cookie header) for a session.
 * Stamps iat/exp when absent; keeps (and clamps) an existing exp.
 * @param {object} session
 * @param {string} secret
 * @param {{ maxAgeSec?: number }} [options]
 */
export async function signSession(session, secret, options = {}) {
  if (!secret) throw new Error('signSession: no secret');
  const maxAge = Number.isFinite(options.maxAgeSec) && options.maxAgeSec > 0
    ? Math.floor(options.maxAgeSec) : SESSION_MAX_AGE_SEC;
  const now = nowSec();
  const ceiling = now + maxAge;
  const exp = Number.isFinite(session.exp) ? Math.min(session.exp, ceiling) : ceiling;
  const iat = Number.isFinite(session.iat) && session.iat <= now ? session.iat : now;
  const stamped = { ...session, iat, exp };
  const payload = b64urlFromBytes(enc.encode(JSON.stringify(stamped)));
  const sig = b64urlFromBytes(await hmac(secret, payload));
  return `${payload}.${sig}`;
}

/**
 * Verify a cookie value and return the session, or null.
 *
 * Returns null for anything suspect — bad signature, malformed, missing
 * segment, and also for a legacy UNSIGNED cookie. Accepting unsigned values
 * during a transition would leave the forgery open for exactly as long as
 * the transition lasted, which defeats the change. Everyone signs in again
 * once instead.
 *
 * @returns {Promise<object|null>}
 */
export async function verifySession(cookieValue, secret) {
  const r = await verifySessionDetailed(cookieValue, secret);
  return r.session;
}

/**
 * verifySession, plus WHY a cookie was refused ('invalid' | 'expired').
 * @returns {Promise<{ session: object|null, reason?: string }>}
 */
export async function verifySessionDetailed(cookieValue, secret) {
  const session = await verifySignature(cookieValue, secret);
  if (!session) return { session: null, reason: 'invalid' };
  const now = nowSec();
  if (session.exp === undefined) {
    return now < legacyCutoffSec() ? { session } : { session: null, reason: 'expired' };
  }
  if (!Number.isFinite(session.exp) || session.exp <= now) return { session: null, reason: 'expired' };
  return { session };
}

async function verifySignature(cookieValue, secret) {
  if (!cookieValue || !secret) return null;

  const dot = cookieValue.lastIndexOf('.');
  if (dot <= 0 || dot === cookieValue.length - 1) return null;

  const payload = cookieValue.slice(0, dot);
  const provided = cookieValue.slice(dot + 1);

  let providedBytes;
  try { providedBytes = bytesFromB64url(provided); } catch { return null; }

  const expected = await hmac(secret, payload);
  if (!constantTimeEqual(providedBytes, expected)) return null;

  try {
    const session = JSON.parse(dec.decode(bytesFromB64url(payload)));
    if (!session || typeof session !== 'object') return null;
    return session;
  } catch {
    return null;
  }
}

/**
 * The Cookie header the route handlers are allowed to see.
 *
 * Returns `pham_session=<verified plain JSON>` when the signed session checks
 * out, and NOTHING otherwise — the rest of the header is always dropped.
 *
 * The handlers find the session with an unanchored /pham_session=/ match, so
 * passing any other cookie through lets a look-alike name such as
 * `xpham_session=<forged JSON>` slip past the anchored check here and be
 * trusted by them. No handler reads any other cookie, so keeping only the
 * verified session costs nothing.
 *
 * ONE exception: the short-lived OAuth state cookie (pham_oauth_state) is
 * passed through, because the login and bot-setup callbacks must compare it
 * against the `state` Twitch hands back. Its value is held to a strict
 * charset first, so it can never smuggle a `pham_session=` substring past
 * the handlers' unanchored match.
 *
 * @returns {Promise<{ cookie: string|null, rejected: boolean, reason?: string }>}
 *   `rejected` is true when a pham_session cookie was present but failed
 *   verification (worth a log line); a plain logged-out request is not.
 *   `reason` is 'invalid' or 'expired' when rejected.
 */
export async function gateSessionCookie(header, secret) {
  const state = readCookie(header, OAUTH_STATE_COOKIE);
  const stateCookie = state && OAUTH_STATE_VALUE.test(state) ? `${OAUTH_STATE_COOKIE}=${state}` : null;
  const join = (...parts) => parts.filter(Boolean).join('; ') || null;

  const raw = readCookie(header, 'pham_session');
  if (!raw) return { cookie: join(stateCookie), rejected: false };
  const { session, reason } = await verifySessionDetailed(raw, secret);
  if (!session) return { cookie: join(stateCookie), rejected: true, reason };
  return {
    cookie: join(`pham_session=${encodeURIComponent(JSON.stringify(session))}`, stateCookie),
    rejected: false,
  };
}

/* ── OPEN-REDIRECT GUARD ──────────────────────────────────────────────────
   return_to used to be concatenated straight onto the origin or into a
   Location header. `@evil.com` became https://phantomace.tv@evil.com (a
   login to evil.com), and `//evil.com` or `/\evil.com` are protocol-relative
   in a Location header. Only a same-origin PATH is accepted: one leading '/',
   not followed by '/' or '\', no backslashes or control characters anywhere
   (browsers strip tab/newline, which can turn "/\t/x" into "//x"), and it
   must still resolve to our own origin. Anything else becomes '/'. */
export function safeReturnPath(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > 2048) return '/';
  if (raw[0] !== '/' || raw[1] === '/' || raw[1] === '\\') return '/';
  if (/[\\\u0000-\u001f\u007f]/.test(raw)) return '/';
  try {
    const base = 'https://return-to.invalid';
    const u = new URL(raw, base);
    if (u.origin !== base) return '/';
    const out = u.pathname + u.search + u.hash;
    return out.startsWith('/') && !out.startsWith('//') ? out : '/';
  } catch {
    return '/';
  }
}

/* ── OAUTH STATE ──────────────────────────────────────────────────────────
   A random nonce is set in a short-lived HttpOnly cookie when an OAuth flow
   starts, sent to Twitch inside `state`, and must match on the callback.
   Without it, an attacker could finish THEIR authorization in a victim's
   browser (login CSRF), or — on bot-setup — get whatever account's code
   arrives stored as the bot token. The cookie is path-scoped to the route
   that started the flow, so login and bot-setup never clobber each other. */
export const OAUTH_STATE_COOKIE = 'pham_oauth_state';
export const OAUTH_STATE_MAX_AGE = 600;
const OAUTH_STATE_VALUE = /^[A-Za-z0-9_-]{22,64}$/;

export function randomNonce(bytes = 24) {
  return b64urlFromBytes(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Set-Cookie value that starts a flow. `path` scopes it to the callback route. */
export function oauthStateCookie(nonce, path, secure) {
  const flags = [`Path=${path}`, `Max-Age=${OAUTH_STATE_MAX_AGE}`, 'HttpOnly', 'SameSite=Lax'];
  if (secure) flags.push('Secure');
  return `${OAUTH_STATE_COOKIE}=${nonce}; ${flags.join('; ')}`;
}

/** Set-Cookie value that ends a flow (the nonce is single-use). */
export function clearOauthStateCookie(path, secure) {
  const flags = [`Path=${path}`, 'Max-Age=0', 'HttpOnly', 'SameSite=Lax'];
  if (secure) flags.push('Secure');
  return `${OAUTH_STATE_COOKIE}=; ${flags.join('; ')}`;
}

/** Does the nonce Twitch returned match the one this browser was given? */
export function oauthStateMatches(cookieHeader, nonce) {
  const expected = readCookie(cookieHeader, OAUTH_STATE_COOKIE);
  if (!expected || !nonce || !OAUTH_STATE_VALUE.test(expected)) return false;
  return constantTimeEqual(enc.encode(expected), enc.encode(String(nonce)));
}

export function encodeStatePart(text) {
  return b64urlFromBytes(enc.encode(String(text)));
}

export function decodeStatePart(part) {
  try { return dec.decode(bytesFromB64url(String(part))); } catch { return null; }
}

/** Read one cookie out of a Cookie header. */
export function readCookie(header, name) {
  if (!header) return null;
  const m = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return m ? m[1] : null;
}
