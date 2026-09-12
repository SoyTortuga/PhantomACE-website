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

/**
 * Build a Web Request from a Node IncomingMessage.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {string} publicOrigin e.g. "https://phantomace.tv" (no trailing slash)
 * @returns {Request}
 */
export function toWebRequest(req, publicOrigin) {
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
    // Lazy stream — see note 1 above. `duplex: 'half'` is required by the
    // spec when constructing a Request from a stream.
    init.body = Readable.toWeb(req);
    init.duplex = 'half';
  }

  return new Request(url, init);
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
