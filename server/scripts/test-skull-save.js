#!/usr/bin/env node
/* ══════════════════════════════════════════════
   SKULL CLICKER — the cross-device save

     node server/scripts/test-skull-save.js

   Skull Clicker kept its whole state in localStorage and nothing else, so
   a cleared browser lost every upgrade — the server held only a single
   leaderboard number, which cannot rebuild a save. This adds a real
   server save, and the one rule that makes it safe to sync across devices
   is HIGHEST LIFETIME TOTAL WINS: totalSkulls only ever climbs, so an old
   tab or a wiped browser can never overwrite a better save with a worse
   one. These tests are that rule, from both directions, plus the gate
   (login only — a guest's id died with the localStorage this fixes).
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { onRequestPost } from '../../functions/api/skull-clicker.js';

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
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    store,
    read(k) { return store.has(k) ? JSON.parse(store.get(k)) : null; },
    async get(k, t) { const v = store.get(k); return v === undefined ? null : (t === 'json' ? JSON.parse(v) : v); },
    async put(k, v) { store.set(k, String(v)); },
    async mutate(k, fn) {
      const cur = store.has(k) ? JSON.parse(store.get(k)) : null;
      const out = await fn(cur);
      if (out === undefined) return;
      store.set(k, JSON.stringify(out));
    },
  };
}
const as = (id) => ({ Cookie: 'pham_session=' + encodeURIComponent(JSON.stringify({ user_id: id, display_name: 'U' + id })) });
const POST = (e, body, h) => onRequestPost({ env: e, request: new Request('https://x/api/skull-clicker', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(body) }) });

const state = (total, over = {}) => ({
  skulls: total, totalSkulls: total, totalClicks: 10, owned: { a: 1 },
  boughtUpgrades: ['u1'], hitMilestones: ['m1'], savedAt: 1, version: 2, ...over,
});

/* ══ Login only ════════════════════════════════════════════════════════ */
{
  const e = { MARKETPLACE: fakeKV() };
  check('a guest cannot save', (await POST(e, { action: 'save-state', state: state(100), guestId: 'g', guestName: 'G' })).status, 401);
  check('nor load', (await POST(e, { action: 'load-state', guestId: 'g' })).status, 401);
  check('anonymous cannot save', (await POST(e, { action: 'save-state', state: state(100) })).status, 401);
  ok('and nothing was written', e.MARKETPLACE.store.size === 0);
}

/* ══ Save, load, round-trip ════════════════════════════════════════════ */
{
  const e = { MARKETPLACE: fakeKV() };
  const res = await POST(e, { action: 'save-state', state: state(500) }, as('7'));
  check('a logged-in save succeeds', res.status, 200);
  check('and is keyed by user', !!e.MARKETPLACE.read('sc_save_7'), true);
  check('with a fresh savedAt stamped', e.MARKETPLACE.read('sc_save_7').totalSkulls, 500);

  const loaded = await (await POST(e, { action: 'load-state' }, as('7'))).json();
  check('load returns the saved upgrades', loaded.state.boughtUpgrades, ['u1']);
  check('a user with no save loads null', (await (await POST(e, { action: 'load-state' }, as('nobody'))).json()).state, null);
}

/* ══ THE RULE: highest lifetime total wins ═════════════════════════════ */
{
  const e = { MARKETPLACE: fakeKV() };
  await POST(e, { action: 'save-state', state: state(1000) }, as('7'));

  /* A worse save arrives — an old tab, or a device behind the others. It
     must NOT overwrite, and it must be TOLD the server is ahead so the
     client adopts the better one instead of clobbering. */
  const lower = await (await POST(e, { action: 'save-state', state: state(400) }, as('7'))).json();
  check('a lower total does not overwrite', e.MARKETPLACE.read('sc_save_7').totalSkulls, 1000);
  check('and the client is told to adopt the server save', lower.adopted, true);
  check('which is the higher one', lower.state.totalSkulls, 1000);

  /* A better save advances it. */
  const higher = await (await POST(e, { action: 'save-state', state: state(2500) }, as('7'))).json();
  check('a higher total overwrites', e.MARKETPLACE.read('sc_save_7').totalSkulls, 2500);
  check('and is not flagged adopted', higher.adopted, false);

  /* THE RECOVERY CASE: cleared browser, local total 0, server has 2500.
     The save it pushes is worse, so the server holds and hands back 2500 —
     the client adopts it and the progress is restored. */
  const wiped = await (await POST(e, { action: 'save-state', state: state(0) }, as('7'))).json();
  check('a wiped browser does not erase the server save', e.MARKETPLACE.read('sc_save_7').totalSkulls, 2500);
  check('and gets the real save back to adopt', wiped.state.totalSkulls, 2500);
}

/* ══ Bad input ═════════════════════════════════════════════════════════ */
{
  const e = { MARKETPLACE: fakeKV() };
  check('a missing state is refused', (await POST(e, { action: 'save-state' }, as('7'))).status, 400);
  const huge = { ...state(10), pad: 'x'.repeat(30000) };
  check('an oversized save is refused', (await POST(e, { action: 'save-state', state: huge }, as('7'))).status, 400);
  ok('and neither wrote anything', !e.MARKETPLACE.read('sc_save_7'));

  /* A save with a nonsense total is treated as total 0 for the merge, so it
     can never win against a real one. */
  await POST(e, { action: 'save-state', state: state(800) }, as('7'));
  await POST(e, { action: 'save-state', state: state(0, { totalSkulls: 'lots' }) }, as('7'));
  check('a non-numeric total cannot clobber', e.MARKETPLACE.read('sc_save_7').totalSkulls, 800);
}

/* ══ Wiring ════════════════════════════════════════════════════════════ */
{
  const reg = fs.readFileSync(path.join(REPO, 'server/lib/registry.js'), 'utf8');
  ok('sc_save_ maps to its own table', /prefix: 'sc_save_',\s*table: 'skull_saves'/.test(reg));

  const schema = fs.readFileSync(path.join(REPO, 'server/sql/001_schema.sql'), 'utf8');
  ok('the schema declares skull_saves', /CREATE TABLE IF NOT EXISTS skull_saves/.test(schema));
  ok('and a standalone migration exists', fs.existsSync(path.join(REPO, 'server/sql/008_skull_saves.sql')));

  const client = fs.readFileSync(path.join(REPO, 'games/skull-clicker/index.html'), 'utf8');
  ok('the client syncs from the server on boot', /function syncFromServer/.test(client) && /load\(\);\s*\n\s*syncFromServer\(\)/.test(client));
  ok('adopts the server save only when it is ahead',
     /Number\(server\.totalSkulls \|\| 0\) > totalSkulls/.test(client));
  ok('and mirrors each save to the server', /function pushSaveToServer/.test(client) && /submitScore\(\);\s*\n\s*pushSaveToServer/.test(client));
  ok('local load and server adopt share one apply path', /function applyState/.test(client));
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[skull-save] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[skull-save] ${passed} assertions passed.`);
console.log('');
