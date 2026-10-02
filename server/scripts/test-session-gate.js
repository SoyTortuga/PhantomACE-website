#!/usr/bin/env node
/* ══════════════════════════════════════════════
   SESSION GATE — what Cookie header the route handlers get to see

     node server/scripts/test-session-gate.js

   server/index.js verifies the signed pham_session cookie once, then hands
   the handlers a rewritten header. The handlers match /pham_session=/
   UNANCHORED, so anything else left in the header is a bypass: a request
   carrying `xpham_session=<forged JSON>` and no real session used to pass
   straight through and be read as the broadcaster. gateSessionCookie() must
   return either the verified session alone or nothing at all.
   ══════════════════════════════════════════════ */

import { signSession, gateSessionCookie } from '../../functions/api/auth/session-crypto.js';
import { onRequestGet as toolboxGet } from '../../functions/api/admin/toolbox.js';

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

const SECRET = 'test-secret-for-the-session-gate';
const BROADCASTER = '111';
const forged = encodeURIComponent(JSON.stringify({ user_id: BROADCASTER, display_name: 'PhantomACE' }));
const handlerRead = (header) => {          // exactly what the ~60 handlers do
  const m = String(header || '').match(/pham_session=([^;]+)/);
  if (!m) return null;
  try { return JSON.parse(decodeURIComponent(m[1])); } catch { return null; }
};

/* ── The bypass ───────────────────────────────────────────────────────── */
{
  const g = await gateSessionCookie(`xpham_session=${forged}`, SECRET);
  check('a look-alike cookie name is dropped', g.cookie, null);
  check('and is not reported as a rejected session', g.rejected, false);
  check('so a handler reads no session from it', handlerRead(g.cookie), null);
}
{
  const g = await gateSessionCookie(`theme=dark; xpham_session=${forged}; other=1`, SECRET);
  check('a look-alike among other cookies is dropped too', g.cookie, null);
}
{
  const g = await gateSessionCookie(`pham_session=${forged}`, SECRET);
  check('an unsigned (plain JSON) session is refused', g.cookie, null);
  check('and reported as rejected', g.rejected, true);
}

/* ── Real sessions still work ─────────────────────────────────────────── */
{
  /* signSession stamps iat/exp (see test-hardening.js for the lifetime
     rules); compare the identity fields and check the stamp separately. */
  const identity = (s) => { if (!s) return s; const { iat, exp, ...rest } = s; return rest; };
  const real = await signSession({ user_id: '999', display_name: 'Viewer' }, SECRET);
  const g = await gateSessionCookie(`pham_session=${real}`, SECRET);
  check('a valid signed session passes', identity(handlerRead(g.cookie)), { user_id: '999', display_name: 'Viewer' });
  ok('carrying its signed expiry', Number.isFinite(handlerRead(g.cookie)?.exp));
  check('not reported as rejected', g.rejected, false);

  const mixed = await gateSessionCookie(`xpham_session=${forged}; pham_session=${real}; zzz=1`, SECRET);
  check('valid session + look-alike: only the verified session survives', identity(handlerRead(mixed.cookie)), { user_id: '999', display_name: 'Viewer' });
  ok('and nothing else rides along in the header', mixed.cookie && !/xpham_session|zzz=/.test(mixed.cookie));

  const wrong = await signSession({ user_id: BROADCASTER }, 'a-different-secret');
  const w = await gateSessionCookie(`pham_session=${wrong}`, SECRET);
  check('a session signed with another secret is refused', w.cookie, null);
}
{
  const g = await gateSessionCookie(undefined, SECRET);
  check('no cookie header at all', g, { cookie: null, rejected: false });
}

/* ── End to end against a real staff-only route ───────────────────────── */
function fakeKV(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    async get(k, t) { const v = store.get(k); return v === undefined ? null : (t === 'json' ? JSON.parse(v) : v); },
    async put(k, v) { store.set(k, String(v)); }, async delete(k) { store.delete(k); },
    async list() { return { keys: [] }; },
  };
}
async function asServerWould(rawHeader) {
  const g = await gateSessionCookie(rawHeader, SECRET);
  const headers = g.cookie ? { Cookie: g.cookie } : {};
  return toolboxGet({
    env: { MARKETPLACE: fakeKV({ site_moderators: JSON.stringify({ entries: [] }) }), TWITCH_BROADCASTER_ID: BROADCASTER },
    request: new Request('https://phantomace.tv/api/admin/toolbox', { headers }),
  });
}
{
  const attack = await asServerWould(`xpham_session=${forged}`);
  check('the forged look-alike is refused by the Admin Dashboard', attack.status, 403);

  const real = await signSession({ user_id: BROADCASTER, display_name: 'PhantomACE' }, SECRET);
  const legit = await asServerWould(`pham_session=${real}`);
  check('the real broadcaster still gets in', legit.status, 200);
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[session-gate] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[session-gate] ${passed} assertions passed.`);
console.log('');
