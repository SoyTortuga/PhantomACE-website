#!/usr/bin/env node
/* ══════════════════════════════════════════════
   MOD TOOLBOX — the staff landing page and its refusal

     node server/scripts/test-mod-toolbox.js

   The page grants nothing, so what matters is the shape of the refusal
   and the shape of the map. A non-staff viewer must get a 403 that names
   the requirement and NOTHING else — not the tool list, not the staff
   list; a hidden page is not a refused page, which is why this is a
   server-rendered function and not a static file with JavaScript over it.

   The links are promises too: every tool the map names must exist, either
   as a static page in the repo or as a registered route, or the toolbox
   sends a moderator to a 404 mid-stream.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { onRequestGet } from '../../functions/api/admin/toolbox.js';
import { buildRoutes } from '../router.js';

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

function fakeKV(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    async get(k, t) { const v = store.get(k); return v === undefined ? null : (t === 'json' ? JSON.parse(v) : v); },
    async put(k, v) { store.set(k, String(v)); }, async delete(k) { store.delete(k); },
    async list() { return { keys: [] }; },
  };
}
const env = () => ({
  MARKETPLACE: fakeKV({ site_moderators: JSON.stringify({ entries: [{ userId: '222', displayName: 'HelperMod' }] }) }),
  TWITCH_BROADCASTER_ID: '111',
});
const as = (id, name) => ({ Cookie: 'pham_session=' + encodeURIComponent(JSON.stringify({ user_id: id, display_name: name })) });
/* Guarded, so a handler that throws is a named failure and not a stack
   trace — a dropped gate makes the anonymous render dereference a null
   session, and the suite must say "refused? no" rather than die there. */
async function GET(e, h) {
  try {
    return await onRequestGet({ env: e, request: new Request('https://phantomace.tv/api/admin/toolbox', { headers: h }) });
  } catch (err) {
    failures.push(`the handler threw instead of answering
      ${err.message}`);
    return { status: 0, headers: new Headers(), text: async () => '' };
  }
}

/* ── The refusal ─────────────────────────────────────────────────────── */
{
  const anon = await GET(env());
  check('anonymous is refused', anon.status, 403);
  const anonBody = await anon.text();
  ok('and told to sign in', /Sign in/i.test(anonBody));
  ok('without learning what tools exist', !/Bot Control|Background Studio|bot-setup/i.test(anonBody));
  ok('or who the staff are', !/HelperMod/.test(anonBody));

  const viewer = await GET(env(), as('999', 'SomeViewer'));
  check('a signed-in viewer is refused too', viewer.status, 403);
  ok('and told the account is not staff', /not on the staff list/i.test(await viewer.text()));
}

/* ── The map, for people allowed to read it ──────────────────────────── */
{
  const mod = await GET(env(), as('222', 'HelperMod'));
  check('a moderator gets the page', mod.status, 200);
  const body = await mod.text();
  for (const name of ['Bot Control', 'Bot &amp; EventSub Setup', 'Background Studio', 'Media Uploads', 'Commander Bingo Host']) {
    ok(`it maps ${name.replace('&amp;', '&')}`, body.includes(name));
  }
  ok('the staff list is shown', /HelperMod/.test(body));
  ok('with the broadcaster listed', /PhantomACE \(broadcaster\)/.test(body));
  ok('and the caller named', /HelperMod<\/b>\s*— moderator/.test(body));

  const bc = await GET(env(), as('111', 'PhantomACE'));
  ok('the broadcaster is recognised as such', /— broadcaster/.test(await bc.text()));
  ok('the answer is never cached', mod.headers.get('Cache-Control') === 'no-store');
}

/* ── Every link the map makes is a real destination ──────────────────── */
{
  const src = fs.readFileSync(path.join(REPO, 'functions/api/admin/toolbox.js'), 'utf8');
  const hrefs = [...src.matchAll(/href: '([^']+)'/g)].map(m => m[1]);
  ok('the map has a healthy number of tools', hrefs.length >= 5);

  const { routes } = await buildRoutes(path.join(REPO, 'functions'));
  const dead = [];
  for (const h of hrefs) {
    if (h.startsWith('/api/')) {
      if (!routes.has(h)) dead.push(h);
    } else if (!fs.existsSync(path.join(REPO, h.replace(/^\//, '')))) {
      dead.push(h);
    }
  }
  check('no link points at a missing page or route', dead, []);

  ok('the pretty URL shim exists', fs.existsSync(path.join(REPO, 'mod-toolbox.html')));
  const shim = fs.readFileSync(path.join(REPO, 'mod-toolbox.html'), 'utf8');
  ok('and it redirects to the gated page', /url=\/api\/admin\/toolbox/.test(shim));
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[mod-toolbox] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[mod-toolbox] ${passed} assertions passed.`);
console.log('');
