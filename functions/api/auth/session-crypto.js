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

/**
 * Produce the cookie VALUE (not the whole Set-Cookie header) for a session.
 * @param {object} session
 * @param {string} secret
 */
export async function signSession(session, secret) {
  if (!secret) throw new Error('signSession: no secret');
  const payload = b64urlFromBytes(enc.encode(JSON.stringify(session)));
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

/** Read one cookie out of a Cookie header. */
export function readCookie(header, name) {
  if (!header) return null;
  const m = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return m ? m[1] : null;
}
