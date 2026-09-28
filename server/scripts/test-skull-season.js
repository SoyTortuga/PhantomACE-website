#!/usr/bin/env node
/* ══════════════════════════════════════════════
   SKULL CLICKER — the seasonal leaderboard

     node server/scripts/test-skull-season.js

   sc_leaderboard is the all-time board; the season board (sc_season) ranks
   skulls gathered THIS month and rolls over on its own — when the stored
   month is not the current one, the board simply clears for the new month.
   The board is DISPLAY-ONLY: Skull Clicker awards no leaderboard prizes (its
   heavy automation makes it non-competitive), so no winners are whispered.
   These tests cover the dual submit, the season-scoped only-raise, the two
   GET shapes, and the rollover reset.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { onRequestGet, onRequestPost } from '../../functions/api/skull-clicker.js';

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
  };
}
const cookie = (id) => ({ Cookie: 'pham_session=' + encodeURIComponent(JSON.stringify({ user_id: id, display_name: 'U' + id })) });
const POST = (e, body, h) => onRequestPost({ env: e, request: new Request('https://x/api/skull-clicker', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(body) }) });
const GET = (e, qs) => onRequestGet({ env: e, request: new Request('https://x/api/skull-clicker?' + qs) });

const thisMonth = (() => { const d = new Date(); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); })();

/* ══ Dual submit: season and all-time both recorded ════════════════════ */
{
  const e = { MARKETPLACE: fakeKV() };
  await POST(e, { action: 'submit-score', score: 10000, seasonScore: 400, prestige: 1 }, cookie('7'));

  const alltime = e.MARKETPLACE.read('sc_leaderboard');
  check('the all-time board records the lifetime score', alltime[0].score, 10000);

  const season = e.MARKETPLACE.read('sc_season');
  check('the season board is stamped with this month', season.month, thisMonth);
  check('and records the season score', season.entries[0].score, 400);
}

/* ══ Season only-raises within the month ═══════════════════════════════ */
{
  const e = { MARKETPLACE: fakeKV() };
  await POST(e, { action: 'submit-score', score: 5000, seasonScore: 500 }, cookie('7'));
  await POST(e, { action: 'submit-score', score: 5000, seasonScore: 300 }, cookie('7'));
  check('a lower season score does not lower the board', e.MARKETPLACE.read('sc_season').entries[0].score, 500);
  await POST(e, { action: 'submit-score', score: 9000, seasonScore: 900 }, cookie('7'));
  check('a higher one advances it', e.MARKETPLACE.read('sc_season').entries[0].score, 900);
}

/* ══ The two GET shapes ════════════════════════════════════════════════ */
{
  const e = { MARKETPLACE: fakeKV() };
  await POST(e, { action: 'submit-score', score: 8000, seasonScore: 700 }, cookie('7'));

  const season = await (await GET(e, 'board=season')).json();
  check('season GET returns a month', season.month, thisMonth);
  check('and its entries', season.entries[0].score, 700);

  const alltime = await (await GET(e, 'board=alltime')).json();
  ok('all-time GET returns a bare array', Array.isArray(alltime) && alltime[0].score === 8000);
}

/* ══ Rollover: an old month resets to empty for the new one ════════════ */
{
  /* A stale month with a guest entry clears for the new month. */
  const e = { MARKETPLACE: fakeKV({ sc_season: { month: '2020-01', entries: [{ id: 'guest_a', name: 'G', score: 999 }] } }) };
  const season = await (await GET(e, 'board=season')).json();
  check('a stale month rolls to the current one', season.month, thisMonth);
  check('and the old entries are cleared', season.entries.length, 0);
}
{
  /* A real (non-guest) entry clears too — the board is display-only, so a
     turned month resets it with nothing prized or whispered. */
  const e = { MARKETPLACE: fakeKV({ sc_season: { month: '2020-01', entries: [{ id: 'u_1', name: 'Real', score: 999 }] } }) };
  const season = await (await GET(e, 'board=season')).json();
  check('rollover resets a real entry too', season.entries.length, 0);
  check('to the current month', season.month, thisMonth);
}

/* ══ Wiring ════════════════════════════════════════════════════════════ */
{
  const lb = fs.readFileSync(path.join(REPO, 'functions/api/leaderboards.js'), 'utf8');
  const labels = lb.slice(lb.indexOf('MONTHLY_GAME_LABELS'), lb.indexOf('MONTHLY_PLACEMENTS'));
  ok('leaderboards no longer monthly-wipes the all-time skull board', !/'skull-clicker':/.test(labels));

  const reg = fs.readFileSync(path.join(REPO, 'server/lib/registry.js'), 'utf8');
  ok('sc_season is a registered singleton', /sc_season:\s*\{ table: 'singletons'/.test(reg));

  const game = fs.readFileSync(path.join(REPO, 'games/skull-clicker/index.html'), 'utf8');
  ok('the game submits a season score', /seasonScore: seasonScore\(\)/.test(game) && /function seasonScore/.test(game));
  ok('the game has a Ranks screen reading both boards',
     /function renderRanks/.test(game) && /board=season/.test(game) && /board=alltime/.test(game));
  ok('the season baseline persists', /seasonBaseline/.test(game) && /if \(d\.seasonBaseline === undefined\)/.test(game));
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[skull-season] ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[skull-season] ${passed} assertions passed.`);
console.log('');
