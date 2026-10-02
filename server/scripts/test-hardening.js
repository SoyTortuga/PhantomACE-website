#!/usr/bin/env node
/* ══════════════════════════════════════════════
   PLATFORM HARDENING — test suite

     node server/scripts/test-hardening.js

   Covers the edge protections added together:
     1. open redirects   — return_to on login/logout is a same-origin path or '/'
     2. session lifetime — signed iat/exp, enforced; legacy cookies until a cutoff
     3. OAuth state      — login and bot-setup refuse a callback this browser
                           did not start; bot-setup refuses the wrong account
     4. db pool          — the timeouts pg actually reads
     5. body cap + rate limit — 413s, token buckets, EventSub exemption
     6. access-log policy and the warning limiter
   No database needed: KV is faked, Twitch is a stubbed fetch.
   ══════════════════════════════════════════════ */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  signSession, verifySession, verifySessionDetailed, gateSessionCookie, safeReturnPath,
  oauthStateMatches, SESSION_MAX_AGE_SEC, OAUTH_STATE_COOKIE,
} from '../../functions/api/auth/session-crypto.js';
import { onRequestGet as loginGet } from '../../functions/api/auth/twitch.js';
import { onRequestGet as logoutGet } from '../../functions/api/auth/logout.js';
import { onRequestGet as botSetupGet } from '../../functions/api/admin/bot-setup.js';
import {
  toWebRequest, bodyLimitFor, declaredBodyTooLarge, DEFAULT_BODY_LIMIT,
  clientIp, rateClassFor, createRateLimiter, RATE_CLASSES,
  shouldLogRequest, createWarnLimiter,
} from '../adapter.js';
import { createPool } from '../lib/db.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

const SECRET = 'hardening-test-secret';
const ORIGIN = 'https://phantomace.tv';
const BROADCASTER = '111';
const BOT = '222';
const MOD = '333';

function fakeKV(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    async get(k, t) { const v = store.get(k); return v === undefined ? null : (t === 'json' ? JSON.parse(v) : v); },
    async put(k, v) { store.set(k, String(v)); },
    async delete(k) { store.delete(k); },
    async list() { return { keys: [] }; },
  };
}

/** Swap global fetch for the duration of fn. Records every URL hit. */
async function withFetch(impl, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (u, init) => { calls.push(String(u)); return impl(String(u), init); };
  try { return await fn(calls); } finally { globalThis.fetch = real; }
}
const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function setCookies(res) { return res.headers.getSetCookie ? res.headers.getSetCookie() : []; }
function cookieValue(setCookieList, name) {
  for (const c of setCookieList) {
    const m = c.match(new RegExp(`^${name}=([^;]*)`));
    if (m) return m[1];
  }
  return null;
}

/* ── 1. Open redirects ───────────────────────────────────────────────── */
{
  const cases = [
    ['/', '/'],
    ['/games/dino-park/', '/games/dino-park/'],
    ['/profile.html?u=abc#top', '/profile.html?u=abc#top'],
    ['/@evil.com', '/@evil.com'],                     // a path on OUR origin, harmless
    ['@evil.com', '/'],                               // was https://phantomace.tv@evil.com
    ['//evil.com', '/'],
    ['//evil.com/path', '/'],
    ['/\\evil.com', '/'],
    ['/\\\\evil.com', '/'],
    ['\\\\evil.com', '/'],
    ['https://evil.com', '/'],
    ['javascript:alert(1)', '/'],
    ['evil.com', '/'],
    ['/\t/evil.com', '/'],                            // browsers strip tabs → //evil.com
    ['/\n/evil.com', '/'],
    ['/a\\b', '/'],
    ['', '/'],
    [null, '/'],
    [undefined, '/'],
    ['/' + 'x'.repeat(3000), '/'],
  ];
  for (const [input, want] of cases) check(`safeReturnPath(${JSON.stringify(input)})`, safeReturnPath(input), want);

  const lo = await logoutGet({ request: new Request(`${ORIGIN}/api/auth/logout?return_to=${encodeURIComponent('//evil.com')}`) });
  check('logout: //evil.com redirects home', lo.headers.get('Location'), `${ORIGIN}/`);
  const lo2 = await logoutGet({ request: new Request(`${ORIGIN}/api/auth/logout?return_to=${encodeURIComponent('@evil.com')}`) });
  check('logout: @evil.com redirects home', lo2.headers.get('Location'), `${ORIGIN}/`);
  const lo3 = await logoutGet({ request: new Request(`${ORIGIN}/api/auth/logout?return_to=${encodeURIComponent('/events.html')}`) });
  check('logout: a real page is kept', lo3.headers.get('Location'), `${ORIGIN}/events.html`);
}

/* ── 2. Session lifetime ─────────────────────────────────────────────── */
{
  const realNow = Date.now;
  try {
    const t0 = Date.UTC(2026, 9, 2, 12, 0, 0);
    Date.now = () => t0;
    const v = await signSession({ user_id: '9' }, SECRET);
    const s = await verifySession(v, SECRET);
    check('signSession stamps iat', s.iat, t0 / 1000);
    check('and exp one max-age later', s.exp, t0 / 1000 + SESSION_MAX_AGE_SEC);
    check('max-age matches the login cookie', SESSION_MAX_AGE_SEC, 86400);

    Date.now = () => t0 + (SESSION_MAX_AGE_SEC - 1) * 1000;
    ok('valid one second before exp', await verifySession(v, SECRET));
    Date.now = () => t0 + SESSION_MAX_AGE_SEC * 1000;
    check('refused at exp', await verifySession(v, SECRET), null);
    check('with reason expired', (await verifySessionDetailed(v, SECRET)).reason, 'expired');
    const g = await gateSessionCookie(`pham_session=${v}`, SECRET);
    check('the gate strips an expired session', g.cookie, null);
    check('and reports it rejected as expired', [g.rejected, g.reason], [true, 'expired']);

    /* Re-signing (what recheck-roles does with {...session}) must not
       extend the lifetime — otherwise a stolen cookie refreshes forever. */
    Date.now = () => t0 + 3600 * 1000;
    const again = await signSession({ ...s, role: 'follower' }, SECRET);
    const s2 = await verifySession(again, SECRET);
    check('re-signing keeps the original exp', s2.exp, s.exp);
    check('and the original iat', s2.iat, s.iat);

    const forgedLong = await signSession({ user_id: '9', exp: t0 / 1000 + 10 * 86400 }, SECRET);
    check('an exp beyond one max-age is clamped', (await verifySession(forgedLong, SECRET)).exp, t0 / 1000 + 3600 + SESSION_MAX_AGE_SEC);

    /* Legacy cookies (no exp): signed by hand the old way. */
    const enc = new TextEncoder();
    const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
    const key = await crypto.subtle.importKey('raw', enc.encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const payload = b64(enc.encode(JSON.stringify({ user_id: '7', display_name: 'Old' })));
    const legacy = `${payload}.${b64(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(payload))))}`;

    process.env.SESSION_LEGACY_CUTOFF = new Date(t0 + 86400 * 1000).toISOString();
    Date.now = () => t0;
    ok('a legacy cookie is accepted before the cutoff', await verifySession(legacy, SECRET));
    const migrated = await verifySession(await signSession(await verifySession(legacy, SECRET), SECRET), SECRET);
    check('and re-signing it stamps an exp', migrated.exp, t0 / 1000 + SESSION_MAX_AGE_SEC);
    Date.now = () => t0 + 86400 * 1000;
    check('a legacy cookie is refused from the cutoff on', await verifySession(legacy, SECRET), null);
    check('as expired', (await verifySessionDetailed(legacy, SECRET)).reason, 'expired');
    delete process.env.SESSION_LEGACY_CUTOFF;
  } finally {
    Date.now = realNow;
  }

  const bad = await verifySessionDetailed('garbage.value', SECRET);
  check('a bad signature is "invalid", not "expired"', bad.reason, 'invalid');
}

/* ── 2b. The gate passes the OAuth state cookie, strictly ────────────── */
{
  const nonce = 'A'.repeat(32);
  const g = await gateSessionCookie(`${OAUTH_STATE_COOKIE}=${nonce}; other=1`, SECRET);
  check('state cookie alone survives the gate', g.cookie, `${OAUTH_STATE_COOKIE}=${nonce}`);
  check('without counting as a rejected session', g.rejected, false);

  const sneaky = await gateSessionCookie(`${OAUTH_STATE_COOKIE}=xpham_session=%7B%22user_id%22%3A%22111%22%7D`, SECRET);
  check('a state cookie that smuggles pham_session= is dropped', sneaky.cookie, null);

  const real = await signSession({ user_id: '5' }, SECRET);
  const both = await gateSessionCookie(`pham_session=${real}; ${OAUTH_STATE_COOKIE}=${nonce}`, SECRET);
  ok('session and state both pass', /^pham_session=/.test(both.cookie) && both.cookie.endsWith(`; ${OAUTH_STATE_COOKIE}=${nonce}`));
  ok('oauthStateMatches accepts the right nonce', oauthStateMatches(both.cookie, nonce));
  ok('and refuses another', !oauthStateMatches(both.cookie, 'B'.repeat(32)));
  ok('and refuses when there is no cookie', !oauthStateMatches('', nonce));
}

/* ── 3a. Login OAuth state ───────────────────────────────────────────── */
{
  const env = { TWITCH_CLIENT_ID: 'cid', TWITCH_CLIENT_SECRET: 'csecret', SESSION_SECRET: SECRET, TWITCH_BROADCASTER_ID: BROADCASTER, MARKETPLACE: fakeKV() };

  const start = await loginGet({ env, request: new Request(`${ORIGIN}/api/auth/twitch?return_to=${encodeURIComponent('@evil.com')}`) });
  check('login start redirects to Twitch', start.status, 302);
  const authUrl = new URL(start.headers.get('Location'));
  check('to the authorize endpoint', authUrl.origin + authUrl.pathname, 'https://id.twitch.tv/oauth2/authorize');
  const state = authUrl.searchParams.get('state');
  const sc = setCookies(start);
  const nonce = cookieValue(sc, OAUTH_STATE_COOKIE);
  ok('a nonce cookie is set', nonce && nonce.length >= 22);
  ok('HttpOnly, scoped to the callback, short-lived',
     /HttpOnly/.test(sc[0]) && /Path=\/api\/auth\/twitch/.test(sc[0]) && /Max-Age=600/.test(sc[0]) && /Secure/.test(sc[0]));
  ok('state carries that nonce', state.startsWith(nonce + '.'));

  /* The attacker's callback: a code, a state, and no matching cookie. */
  await withFetch(() => { throw new Error('Twitch must not be called'); }, async (calls) => {
    const forged = await loginGet({ env, request: new Request(`${ORIGIN}/api/auth/twitch?code=attacker&state=${encodeURIComponent(state)}`) });
    check('mismatched state is refused with a redirect', forged.status, 302);
    const loc = new URL(forged.headers.get('Location'));
    check('carrying login_error=state', loc.searchParams.get('login_error'), 'state');
    check('back on our own origin', loc.origin, ORIGIN);
    check('and the code was never exchanged', calls.length, 0);
    ok('no session cookie was issued', !setCookies(forged).some(c => c.startsWith('pham_session=')));

    const wrongNonce = await loginGet({ env, request: new Request(`${ORIGIN}/api/auth/twitch?code=attacker&state=${encodeURIComponent(state)}`, {
      headers: { Cookie: `${OAUTH_STATE_COOKIE}=${'Z'.repeat(32)}` } }) });
    check('a different nonce is refused too', new URL(wrongNonce.headers.get('Location')).searchParams.get('login_error'), 'state');
  });

  /* The legitimate callback. return_to was '@evil.com', so it lands on '/'. */
  await withFetch(async (u) => {
    if (u.startsWith('https://id.twitch.tv/oauth2/token')) return jsonRes({ access_token: 'tok' });
    if (u.startsWith('https://api.twitch.tv/helix/users')) return jsonRes({ data: [{ id: '42', login: 'viewer', display_name: 'Viewer', profile_image_url: '' }] });
    return jsonRes({ data: [] });
  }, async () => {
    const good = await loginGet({ env, request: new Request(`${ORIGIN}/api/auth/twitch?code=real&state=${encodeURIComponent(state)}`, {
      headers: { Cookie: `${OAUTH_STATE_COOKIE}=${nonce}` } }) });
    check('matching state logs in', good.status, 302);
    check('the unsafe return_to became home', good.headers.get('Location'), `${ORIGIN}/`);
    const cookies = setCookies(good);
    const session = await verifySession(cookieValue(cookies, 'pham_session'), SECRET);
    check('a session for the right user', session && session.user_id, '42');
    check('expiring in exactly one max-age', session && session.exp - session.iat, SESSION_MAX_AGE_SEC);
    ok('and the nonce cookie is cleared', cookies.some(c => c.startsWith(`${OAUTH_STATE_COOKIE}=;`) && /Max-Age=0/.test(c)));
  });

  const errored = await loginGet({ env, request: new Request(`${ORIGIN}/api/auth/twitch?error=access_denied&state=${encodeURIComponent('x.' + Buffer.from('//evil.com').toString('base64url'))}`) });
  const eloc = new URL(errored.headers.get('Location'));
  check('an OAuth error with a hostile state stays on our origin', eloc.origin, ORIGIN);
  check('and on the home page', eloc.pathname, '/');
  check('with the error surfaced', eloc.searchParams.get('login_error'), 'access_denied');

  const legacyState = await loginGet({ env, request: new Request(`${ORIGIN}/api/auth/twitch?error=access_denied&state=${encodeURIComponent('@evil.com')}`) });
  check('an old-style state cannot redirect off-site', new URL(legacyState.headers.get('Location')).origin, ORIGIN);
}

/* ── 3b. Bot-setup OAuth state and account checks ────────────────────── */
{
  const plain = (s) => `pham_session=${encodeURIComponent(JSON.stringify(s))}`;
  const baseEnv = () => ({
    TWITCH_CLIENT_ID: 'cid', TWITCH_CLIENT_SECRET: 'csecret', TWITCH_BROADCASTER_ID: BROADCASTER,
    MARKETPLACE: fakeKV({ site_moderators: JSON.stringify({ entries: [{ userId: MOD }] }) }),
  });

  /* Render the page as a moderator to obtain the nonce and the links. */
  const env0 = baseEnv();
  const page = await withFetch(async () => jsonRes({}, 401), () => botSetupGet({ env: env0,
    request: new Request(`${ORIGIN}/api/admin/bot-setup`, { headers: { Cookie: plain({ user_id: MOD }) } }) }));
  check('setup page renders for a moderator', page.status, 200);
  const nonce = cookieValue(setCookies(page), OAUTH_STATE_COOKIE);
  ok('the page sets a state nonce cookie', nonce && /Path=\/api\/admin\/bot-setup/.test(setCookies(page)[0]) && /HttpOnly/.test(setCookies(page)[0]));
  const body = await page.text();
  ok('the bot Authorize link carries bot.<nonce>', body.includes(`state=${encodeURIComponent('bot.' + nonce)}`));
  ok('the fixed state=broadcaster is gone', !/state=broadcaster(&|"|$)/.test(body));

  const callback = (env, state, cookieNonce, who = MOD) => botSetupGet({ env, request: new Request(
    `${ORIGIN}/api/admin/bot-setup?code=c0de&state=${encodeURIComponent(state)}`,
    { headers: { Cookie: plain({ user_id: who }) + (cookieNonce ? `; ${OAUTH_STATE_COOKIE}=${cookieNonce}` : '') } }) });

  const twitchAs = (id, name) => async (u) => {
    if (u.startsWith('https://id.twitch.tv/oauth2/token')) return jsonRes({ access_token: 'acc', refresh_token: 'ref', expires_in: 14400 });
    if (u.startsWith('https://api.twitch.tv/helix/users')) return jsonRes({ data: [{ id, display_name: name }] });
    if (u.startsWith('https://id.twitch.tv/oauth2/revoke')) return new Response(null, { status: 200 });
    return jsonRes({}, 404);
  };

  for (const [label, state, cookieNonce] of [
    ['the old fixed state', 'broadcaster', nonce],
    ['no cookie', `bot.${nonce}`, null],
    ['a different nonce', `bot.${'Q'.repeat(32)}`, nonce],
    ['an unknown purpose', `admin.${nonce}`, nonce],
  ]) {
    const env = baseEnv();
    await withFetch(twitchAs(BOT, 'Bot'), async (calls) => {
      const r = await callback(env, state, cookieNonce);
      check(`bot-setup: ${label} is refused`, r.status, 403);
      check(`bot-setup: ${label} never reaches Twitch`, calls.length, 0);
      check(`bot-setup: ${label} stores nothing`, env.MARKETPLACE.store.has('twitch_bot_refresh_token'), false);
    });
  }

  {
    const env = { ...baseEnv(), TWITCH_BOT_USER_ID: BOT };
    await withFetch(twitchAs('999', 'SomeoneElse'), async (calls) => {
      const r = await callback(env, `bot.${nonce}`, nonce);
      check('bot-setup: an account other than TWITCH_BOT_USER_ID is refused', r.status, 403);
      check('and nothing is stored', ['twitch_bot_refresh_token', 'twitch_bot_token', 'twitch_bot_user_id'].some(k => env.MARKETPLACE.store.has(k)), false);
      ok('and the stray token is revoked', calls.some(u => u.startsWith('https://id.twitch.tv/oauth2/revoke')));
    });
  }
  {
    const env = baseEnv();                     // no TWITCH_BOT_USER_ID configured
    await withFetch(twitchAs(BROADCASTER, 'PhantomACE'), async () => {
      const r = await callback(env, `bot.${nonce}`, nonce);
      check('bot-setup: the broadcaster account cannot become the bot', r.status, 403);
      check('and nothing is stored', env.MARKETPLACE.store.has('twitch_bot_refresh_token'), false);
    });
  }
  {
    const env = { ...baseEnv(), TWITCH_BOT_USER_ID: BOT };
    await withFetch(twitchAs(BOT, 'PhamBot'), async () => {
      const r = await callback(env, `bot.${nonce}`, nonce);
      check('bot-setup: the configured bot account is accepted', r.status, 200);
      check('its refresh token is stored', env.MARKETPLACE.store.get('twitch_bot_refresh_token'), 'ref');
      check('with its user id', env.MARKETPLACE.store.get('twitch_bot_user_id'), BOT);
      ok('and the nonce cookie is cleared', setCookies(r).some(c => c.startsWith(`${OAUTH_STATE_COOKIE}=;`)));
    });
  }
  {
    const env = baseEnv();
    await withFetch(twitchAs('444', 'NotTheBroadcaster'), async () => {
      const r = await callback(env, `broadcaster.${nonce}`, nonce, BROADCASTER);
      check('broadcaster step: a token for another account is refused', r.status, 403);
      check('and not stored', env.MARKETPLACE.store.has('twitch_broadcaster_refresh_token'), false);
    });
    await withFetch(twitchAs(BROADCASTER, 'PhantomACE'), async () => {
      const r = await callback(env, `broadcaster.${nonce}`, nonce, BROADCASTER);
      check('broadcaster step: the broadcaster\'s own token is stored', [r.status, env.MARKETPLACE.store.get('twitch_broadcaster_refresh_token')], [200, 'ref']);
    });
    await withFetch(twitchAs(BROADCASTER, 'PhantomACE'), async () => {
      const r = await callback(env, `broadcaster.${nonce}`, nonce, MOD);
      check('broadcaster step: still refused for a moderator session', r.status, 403);
    });
  }
}

/* ── 4. DB pool options ──────────────────────────────────────────────── */
{
  const pool = createPool('postgres://u:p@127.0.0.1:1/none', { statementTimeoutMs: 30000 });
  check('idleTimeoutMillis is spelled the way pg reads it', pool.options.idleTimeoutMillis, 30000);
  ok('the misspelling is gone', !('idle_timeout_millis' in pool.options));
  check('connectionTimeoutMillis is set', pool.options.connectionTimeoutMillis, 10000);
  check('statement_timeout reaches the connection config', pool.options.statement_timeout, 30000);
  await pool.end();

  const scriptPool = createPool('postgres://u:p@127.0.0.1:1/none');
  check('scripts get no statement timeout unless they ask', scriptPool.options.statement_timeout, undefined);
  await scriptPool.end();

  const dbSrc = fs.readFileSync(path.join(REPO, 'server/lib/db.js'), 'utf8');
  ok('idle_in_transaction_session_timeout is not set (it would kill a slow mutate)', !/idle_in_transaction_session_timeout\s*:/.test(dbSrc));
  const idx = fs.readFileSync(path.join(REPO, 'server/index.js'), 'utf8');
  ok('the server passes the statement timeout', /createPool\(process\.env\.DATABASE_URL, \{ statementTimeoutMs: /.test(idx));
}

/* ── 5a. Body cap ────────────────────────────────────────────────────── */
{
  check('default cap is 1 MB', bodyLimitFor('/api/forum/post'), 1024 * 1024);
  check('media upload gets 12 MB', bodyLimitFor('/api/media/upload'), 12 * 1024 * 1024);
  ok('the upload cap exceeds the handler\'s own 10 MB file limit',
     /MAX_SIZE = 10 \* 1024 \* 1024/.test(fs.readFileSync(path.join(REPO, 'functions/api/media/upload.js'), 'utf8')) &&
     bodyLimitFor('/api/media/upload') > 10 * 1024 * 1024);

  /* A tiny server that does exactly what index.js does around a handler. */
  const LIMIT = 1000;
  const server = http.createServer(async (req, res) => {
    if (declaredBodyTooLarge(req, LIMIT)) { res.writeHead(413, { Connection: 'close' }); res.end('declared'); return; }
    const request = toWebRequest(req, ORIGIN, { maxBodyBytes: LIMIT });
    let text = null;
    try { text = await request.text(); } catch { /* handler-style swallow */ }
    if (req.bodyTooLarge) { res.writeHead(413, { Connection: 'close' }); res.end('streamed'); return; }
    res.writeHead(200); res.end(String(text.length) + ':' + text.slice(0, 20));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const send = (body, { chunked = false } = {}) => new Promise((resolve) => {
    const headers = chunked ? { 'Transfer-Encoding': 'chunked' } : { 'Content-Length': Buffer.byteLength(body) };
    const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/x', headers }, (res) => {
      let out = ''; res.on('data', d => { out += d; }); res.on('end', () => resolve({ status: res.statusCode, body: out }));
    });
    r.on('error', (e) => resolve({ status: 'error', body: e.code }));
    if (chunked) { for (let i = 0; i < body.length; i += 100) r.write(body.slice(i, i + 100)); r.end(); }
    else r.end(body);
  });

  const small = await send('{"a":"' + 'é'.repeat(100) + '"}');
  check('a body under the cap reaches the handler byte-exact', small, { status: 200, body: `${('{"a":"' + 'é'.repeat(100) + '"}').length}:{"a":"éééééééééééééé` });
  check('a declared oversize body is a 413', (await send('x'.repeat(LIMIT + 1))).status, 413);
  const streamed = await send('y'.repeat(LIMIT * 5), { chunked: true });
  check('a chunked body that grows past the cap is a 413', streamed.status, 413);
  check('caught by the counting stream, not the header', streamed.body, 'streamed');
  check('a chunked body under the cap still works', (await send('z'.repeat(LIMIT - 1), { chunked: true })).body, `${LIMIT - 1}:zzzzzzzzzzzzzzzzzzzz`);
  server.close();
  check('DEFAULT_BODY_LIMIT is used when no cap is passed', DEFAULT_BODY_LIMIT, 1024 * 1024);
}

/* ── 5b. Rate limiter ────────────────────────────────────────────────── */
{
  let t = 1_000_000;
  const lim = createRateLimiter({ classes: { auth: { capacity: 5, refillPerSec: 1 } }, now: () => t });
  const burst = Array.from({ length: 8 }, () => lim.take('auth', '1.2.3.4').allowed);
  check('a burst is allowed up to capacity, then blocked', burst, [true, true, true, true, true, false, false, false]);
  const blocked = lim.take('auth', '1.2.3.4');
  ok('a blocked request is told when to retry', blocked.retryAfterSec >= 1);
  check('another IP is unaffected', lim.take('auth', '5.6.7.8').allowed, true);
  t += 2000;
  check('it recovers as tokens refill', [lim.take('auth', '1.2.3.4').allowed, lim.take('auth', '1.2.3.4').allowed, lim.take('auth', '1.2.3.4').allowed], [true, true, false]);
  t += 60_000;
  check('idle buckets are swept once full again', lim.sweep(), 2);
  check('leaving nothing behind', lim.size, 0);

  const capped = createRateLimiter({ classes: { default: { capacity: 10, refillPerSec: 1 } }, maxEntries: 100, now: () => t });
  for (let i = 0; i < 1000; i++) capped.take('default', `10.0.${i >> 8}.${i & 255}`);
  check('memory is bounded under a flood of distinct IPs', capped.size, 100);

  check('normal API traffic uses the default class', rateClassFor('/api/inventory', 'GET'), 'default');
  check('login is tighter', rateClassFor('/api/auth/twitch', 'GET'), 'auth');
  check('logout is tighter', rateClassFor('/api/auth/logout', 'GET'), 'auth');
  check('recheck-roles is tightest', rateClassFor('/api/auth/recheck-roles', 'GET'), 'recheck');
  check('health is never limited', rateClassFor('/api/health', 'GET'), null);
  check('static files are not limited', rateClassFor('/index.html', 'GET'), null);
  ok('recheck allows fewer than auth, auth fewer than default',
     RATE_CLASSES.recheck.capacity < RATE_CLASSES.auth.capacity && RATE_CLASSES.auth.capacity < RATE_CLASSES.default.capacity);

  /* Every callback bot-setup registers with Twitch must be exempt for POST. */
  const setup = fs.readFileSync(path.join(REPO, 'functions/api/admin/bot-setup.js'), 'utf8');
  const callbacks = [...new Set([...setup.matchAll(/callback: `\$\{origin\}(\/api\/[a-z/-]+)`/g)].map(m => m[1]))];
  ok('found the EventSub callback list', callbacks.length >= 6);
  for (const p of callbacks) {
    check(`EventSub POST ${p} is not limited`, rateClassFor(p, 'POST'), null);
    check(`but a GET to ${p} is`, rateClassFor(p, 'GET'), 'default');
  }

  const fakeReq = (headers, remoteAddress = '127.0.0.1') => ({ headers, socket: { remoteAddress } });
  check('the client IP comes from CF-Connecting-IP', clientIp(fakeReq({ 'cf-connecting-ip': '203.0.113.9' })), { ip: '203.0.113.9', local: false });
  check('IPv6 too', clientIp(fakeReq({ 'cf-connecting-ip': '2001:db8::1' })).ip, '2001:db8::1');
  check('a junk header falls back to the socket', clientIp(fakeReq({ 'cf-connecting-ip': '<script>' })), { ip: '127.0.0.1', local: true });
  check('no header + loopback = a process on the rig', clientIp(fakeReq({})).local, true);
}

/* ── 6. Logging ──────────────────────────────────────────────────────── */
{
  check('a successful overlay poll is not logged', shouldLogRequest({ method: 'GET', pathname: '/api/overlay/events', status: 200, ms: 5 }), false);
  check('a static asset is not logged', shouldLogRequest({ method: 'GET', pathname: '/css/base.css', status: 200 }), false);
  check('a 304 is not logged', shouldLogRequest({ method: 'GET', pathname: '/js/nav.js', status: 304 }), false);
  check('a 404 is logged', shouldLogRequest({ method: 'GET', pathname: '/wp-login.php', status: 404 }), true);
  check('a 500 is logged', shouldLogRequest({ method: 'GET', pathname: '/api/overlay/events', status: 500 }), true);
  check('a POST is logged', shouldLogRequest({ method: 'POST', pathname: '/api/inventory', status: 200 }), true);
  check('an OAuth hop is logged', shouldLogRequest({ method: 'GET', pathname: '/api/auth/twitch', status: 302 }), true);
  check('a slow GET is logged', shouldLogRequest({ method: 'GET', pathname: '/api/leaderboards', status: 200, ms: 2500 }), true);

  let t = 0;
  const lines = [];
  const warn = createWarnLimiter({ windowMs: 60_000, now: () => t, sink: (m) => lines.push(m) });
  for (let i = 0; i < 50; i++) warn('session:expired', 'expired cookie');
  t = 61_000;
  warn('session:expired', 'expired cookie');
  check('repeated warnings collapse to one per window, with a count', lines, ['expired cookie', 'expired cookie (+49 similar suppressed)']);

  const idx = fs.readFileSync(path.join(REPO, 'server/index.js'), 'utf8');
  ok('the access log is written on close with the real status', /res\.once\('close'[\s\S]{0,200}logRequest\(req, url, res\.statusCode/.test(idx));
  ok('no hardcoded 200 is logged for static files', !/logRequest\(req, url, 200/.test(idx));
  ok('the rate limit runs before the session gate', idx.indexOf('limiter.take(') > 0 && idx.indexOf('limiter.take(') < idx.indexOf('await gateSessionCookie('));
  ok('the bad-cookie warning is rate-limited', /warnOnce\(`session:/.test(idx) && !/console\.warn\(`\[auth\] rejected/.test(idx));

  const ps = fs.readFileSync(path.join(REPO, 'server/scripts/install-services.ps1'), 'utf8');
  ok('NSSM rotates while running', /AppRotateOnline\s+1/.test(ps));
  ok('with a size threshold', /AppRotateBytes\s+\d+/.test(ps));
  ok('and rotated files are pruned', /Register-ScheduledTask/.test(ps) && /LogRetentionDays/.test(ps));
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[hardening] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[hardening] ${passed} assertions passed.`);
console.log('');
