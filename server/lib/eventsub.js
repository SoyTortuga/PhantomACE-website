/* ══════════════════════════════════════════════
   Twitch EventSub webhook signature verification.

   Replaces four byte-identical copies of verifySignature() in
   functions/api/{hype-train,channel-points}.js and
   functions/api/bot/{commands,giveaway-entry}.js.

   This is the one helper consolidated during the migration, because it is
   security-relevant AND needed behaviour changes:

   1. FAILS CLOSED. The originals wrapped verification in `if (secret)`, so a
      missing TWITCH_EVENTSUB_SECRET silently disabled signature checking on
      all four webhook endpoints. On Pages that was partly masked by
      Cloudflare sitting in front; on a self-hosted box reachable from the
      internet it means anyone can POST forged Twitch events — fake hype
      trains, fake channel-point redemptions, fake chat commands, fake
      giveaway entries. Now a missing secret is an error, and the server also
      refuses to boot without it.

   2. TIMING-SAFE COMPARISON — via SubtleCrypto.verify(), which HMAC-compares
      in constant time internally, rather than `===` on the hex string.

   3. REPLAY WINDOW. Twitch recommends rejecting messages whose timestamp is
      more than 10 minutes old; without it a captured valid request can be
      replayed indefinitely.

   Built on the Web Crypto API (globalThis.crypto.subtle) rather than
   node:crypto: milestones.js imports this from functions/api/, a Cloudflare
   Pages Function, and the Workers runtime only resolves "node:crypto" with
   nodejs_compat turned on. Web Crypto needs nothing extra and runs
   identically here, in the self-hosted Node server, and in Workers.

   The signed message is exactly `messageId + timestamp + rawBody`, where
   rawBody must be the UNMODIFIED request text. Anything that parses and
   re-serialises the body first will produce a different signature and every
   webhook will 403 — which is why this server has no body-parsing layer.
   ══════════════════════════════════════════════ */

const HMAC_PREFIX = 'sha256=';
const HEADER_ID = 'twitch-eventsub-message-id';
const HEADER_TIMESTAMP = 'twitch-eventsub-message-timestamp';
const HEADER_SIGNATURE = 'twitch-eventsub-message-signature';
const HEADER_TYPE = 'twitch-eventsub-message-type';

const MAX_AGE_MS = 10 * 60 * 1000;

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/**
 * @param {Request} request  Web Request (headers only are read)
 * @param {string}  secret   TWITCH_EVENTSUB_SECRET
 * @param {string}  rawBody  the exact text of the request body
 * @returns {Promise<{ok: true, messageType: string} | {ok: false, status: number, reason: string}>}
 */
export async function verifyEventSub(request, secret, rawBody) {
  if (!secret) {
    // Deliberately not "skip verification" — see note 1 above.
    return { ok: false, status: 500, reason: 'TWITCH_EVENTSUB_SECRET is not configured' };
  }

  const messageId = request.headers.get(HEADER_ID);
  const timestamp = request.headers.get(HEADER_TIMESTAMP);
  const signature = request.headers.get(HEADER_SIGNATURE);
  const messageType = request.headers.get(HEADER_TYPE) || '';

  if (!messageId || !timestamp || !signature) {
    return { ok: false, status: 403, reason: 'Missing EventSub signature headers' };
  }
  if (!signature.startsWith(HMAC_PREFIX)) {
    return { ok: false, status: 403, reason: 'EventSub signature mismatch' };
  }

  const sentAt = Date.parse(timestamp);
  if (Number.isNaN(sentAt)) {
    return { ok: false, status: 403, reason: 'Unparseable EventSub timestamp' };
  }
  if (Math.abs(Date.now() - sentAt) > MAX_AGE_MS) {
    return { ok: false, status: 403, reason: 'EventSub timestamp outside replay window' };
  }

  const hex = signature.slice(HMAC_PREFIX.length);
  if (hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
    return { ok: false, status: 403, reason: 'EventSub signature mismatch' };
  }

  const key = await hmacKey(secret);
  const data = new TextEncoder().encode(messageId + timestamp + rawBody);
  const valid = await crypto.subtle.verify('HMAC', key, hexToBytes(hex), data);
  if (!valid) {
    return { ok: false, status: 403, reason: 'EventSub signature mismatch' };
  }

  return { ok: true, messageType };
}

/** Convenience for tests and for any future outbound signing. */
export async function signEventSub(secret, messageId, timestamp, rawBody) {
  const key = await hmacKey(secret);
  const data = new TextEncoder().encode(messageId + timestamp + rawBody);
  const sig = await crypto.subtle.sign('HMAC', key, data);
  return HMAC_PREFIX + bytesToHex(new Uint8Array(sig));
}
