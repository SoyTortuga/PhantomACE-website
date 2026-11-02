#!/usr/bin/env node
/* ══════════════════════════════════════════════
   ENSHROUDED — the subscriber-gated server details

     node server/scripts/test-enshrouded.js

   THE ONE THING THIS MUST CATCH. Enshrouded has no whitelist: the shared
   password IS the perk and the only access control there is. So the test that
   matters is negative — the secret must not appear in the RAW RESPONSE BODY
   for anyone ineligible. Checking a parsed field for undefined would pass even
   if the secret were leaking in some other key, so every non-subscriber case
   asserts against the serialised text.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { onRequestGet, onRequestPost, ENSHROUDED_KEY } from '../../functions/api/enshrouded.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

const BROADCASTER = '900';
const SECRET = 'super-secret-join-password-9999';

function makeEnv(seed = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    TWITCH_BROADCASTER_ID: BROADCASTER,
    MARKETPLACE: {
      async get(k, t) { if (!store.has(k)) return null; const r = store.get(k); return t === 'json' ? JSON.parse(r) : r; },
      async put(k, v) { store.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
      async delete(k) { store.delete(k); },
      async mutate(k, fn) {
        const cur = store.has(k) ? JSON.parse(store.get(k)) : null;
        const next = await fn(cur);
        if (next !== undefined) store.set(k, JSON.stringify(next));
        return next === undefined ? cur : next;
      },
    },
    _store: store,
  };
}

const CONFIGURED = { name: 'PhantomACE - Enshrouded', address: 'ens.phantomace.tv:15637', password: SECRET, slots: 16, notes: '' };

function req(url, { userId, role, method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (userId) {
    headers.Cookie = 'pham_session=' + encodeURIComponent(JSON.stringify({ user_id: userId, display_name: 'Nyx', role }));
  }
  return new Request('https://phantomace.tv' + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
}
const GET = (env, opts) => onRequestGet({ env, request: req('/api/enshrouded', opts) });
const POST = (env, opts) => onRequestPost({ env, request: req('/api/enshrouded', { ...opts, method: 'POST' }) });

/* ══ 1. WIRING ══════════════════════════════════ */
ok('registry maps enshrouded_config', /enshrouded_config:\s*\{/.test(read('server/lib/registry.js')));
ok('the nav links /enshrouded', /href="\/enshrouded"/.test(read('js/components.js')));

const html = read('enshrouded.html');
['ensGuest', 'ensNotSub', 'ensBody', 'ensAdmin', 'ensPassword', 'ensAddress'].forEach((id) =>
  ok('page has #' + id, new RegExp('id="' + id + '"').test(html)));
ok('page uses the shared hero', /page-hero-title/.test(html));
ok('page loads its css + js', /css\/pages\/enshrouded\.css/.test(html) && /js\/pages\/enshrouded\.js/.test(html));
ok('logged-out prompt offers Twitch login', /loginWithTwitch\(\)/.test(html));

const css = read('css/pages/enshrouded.css');
check('no box-shadow', /box-shadow\s*:/.test(css), false);
check('no backdrop-filter / blur', /backdrop-filter\s*:|blur\s*\(/.test(css), false);
check('no border-left rail', /border-left\s*:/.test(css), false);
check('no border-right rail', /border-right\s*:/.test(css), false);

/* ══ 2. THE PASSWORD NEVER LEAKS ════════════════ */
const NON_SUB_ROLES = [undefined, 'visitor', 'follower', 'viewer', 'vip'];

for (const role of NON_SUB_ROLES) {
  const env = makeEnv({ [ENSHROUDED_KEY]: CONFIGURED });
  const res = await GET(env, { userId: '555', role });
  const text = await res.text();
  ok(`role "${role}" is NOT eligible`, JSON.parse(text).eligible === false);
  check(`role "${role}" never sees the secret in the raw body`, text.includes(SECRET), false);
}

{
  const env = makeEnv({ [ENSHROUDED_KEY]: CONFIGURED });
  const res = await GET(env, {});                       // logged out entirely
  const text = await res.text();
  check('logged out: no secret in the raw body', text.includes(SECRET), false);
  ok('logged out: reported as logged out', JSON.parse(text).loggedIn === false);
  ok('logged out: still learns the address (not a secret)', JSON.parse(text).server.address === CONFIGURED.address);
}

/* ══ 3. SUBSCRIBERS AND STAFF DO GET IT ═════════ */
for (const role of ['sub_tier1', 'sub_tier2', 'sub_tier3', 'moderator', 'broadcaster']) {
  const env = makeEnv({ [ENSHROUDED_KEY]: CONFIGURED });
  const d = await (await GET(env, { userId: '555', role })).json();
  ok(`role "${role}" is eligible`, d.eligible === true);
  check(`role "${role}" receives the password`, d.password, SECRET);
}

/* ══ 4. UNCONFIGURED SERVER ═════════════════════ */
{
  const env = makeEnv();
  const d = await (await GET(env, { userId: '555', role: 'sub_tier1' })).json();
  check('an unset server reports not configured', d.configured, false);
  ok('and carries no password', d.password === undefined);
}

/* ══ 5. ONLY STAFF CAN WRITE ════════════════════ */
{
  const env = makeEnv({ [ENSHROUDED_KEY]: CONFIGURED });
  const res = await POST(env, { userId: '555', role: 'sub_tier1', body: { address: 'evil:1', password: 'pwned' } });
  check('a subscriber cannot change the details', res.status, 403);
  const after = JSON.parse(env._store.get(ENSHROUDED_KEY));
  check('and nothing was written', after.password, SECRET);
}

{
  const env = makeEnv();
  const res = await POST(env, { userId: BROADCASTER, role: 'broadcaster', body: { name: 'N', address: 'a:15637', password: SECRET, slots: 99, notes: 'hi' } });
  check('the broadcaster can save', res.status, 200);
  const text = await res.text();
  check('and the save response does NOT echo the password back', text.includes(SECRET), false);
  const saved = JSON.parse(env._store.get(ENSHROUDED_KEY));
  check('slots are clamped to the engine max of 16', saved.slots, 16);
  check('the password is stored', saved.password, SECRET);
}

console.log('');
if (failures.length) {
  console.log(`[enshrouded] ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.log(`  FAIL: ${f}`);
  process.exit(1);
}
console.log(`[enshrouded] ${passed} assertions passed.`);
