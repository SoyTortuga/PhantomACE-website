#!/usr/bin/env node
/* ══════════════════════════════════════════════
   CUSTOMIZABLE WHEEL — test suite

     node server/scripts/test-wheel.js

   The wheel drives an on-stream reveal from a broadcaster-defined config, so the
   things pinned here are: config validation (limits + on-palette colours), the
   weighted pick (probability ∝ weight, deterministic + statistical), the
   'wheel-spin' overlay event shape the overlay renders from, save/load
   round-trip, and the staff gate.

   No network, no DB: a fake KV, and pushOverlayEvent runs against it.
   ══════════════════════════════════════════════ */

import * as wheel from '../../functions/api/wheel.js';

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

const BROADCASTER = '900';

function seeded(seed) {
  let x = seed >>> 0;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
}

function makeEnv() {
  const store = new Map();
  const chains = new Map();
  return {
    TWITCH_BROADCASTER_ID: BROADCASTER,
    MARKETPLACE: {
      async get(k, t) { if (!store.has(k)) return null; const r = store.get(k); return t === 'json' ? JSON.parse(r) : r; },
      async put(k, v) { store.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
      async delete(k) { store.delete(k); },
      async mutate(k, fn) {
        const prev = chains.get(k) || Promise.resolve();
        const run = prev.then(async () => {
          const cur = store.has(k) ? JSON.parse(store.get(k)) : null;
          const next = await fn(cur);
          if (next === undefined) return cur;
          store.set(k, JSON.stringify(next));
          return JSON.parse(store.get(k));
        });
        chains.set(k, run.then(() => {}, () => {}));
        return run;
      },
    },
    _store: store,
  };
}

const session = (userId = BROADCASTER) => encodeURIComponent(JSON.stringify({ user_id: userId, display_name: 'PhantomACE' }));
function req(body, userId = BROADCASTER, method = 'POST') {
  return new Request('https://phantomace.tv/api/wheel', {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: `pham_session=${session(userId)}` },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  });
}
const post = (env, body, userId) => wheel.onRequestPost({ env, request: req(body, userId, 'POST') });
const get = (env, userId) => wheel.onRequestGet({ env, request: req(null, userId, 'GET') });
const lastEvent = (env) => {
  const rec = env._store.get('overlay_events');
  const events = rec ? JSON.parse(rec).events : [];
  return events[events.length - 1] || null;
};

/* ── validateConfig ──────────────────────────────────────────────────── */
{
  const good = wheel.validateConfig({ segments: [{ label: 'A', weight: 3 }, { label: 'B' }] });
  ok('a valid config passes', !good.error);
  check('weights default to 1', good.segments[1].weight, 1);
  ok('colours default to the curated palette', !!wheel.WHEEL_PALETTE[good.segments[0].color]);
  ok('and default colours alternate', good.segments[0].color !== good.segments[1].color);

  check('too few segments is refused', !!wheel.validateConfig({ segments: [{ label: 'only' }] }).error, true);
  check('too many segments is refused', !!wheel.validateConfig({ segments: Array.from({ length: 13 }, (_, i) => ({ label: 'S' + i })) }).error, true);
  check('a non-array is refused', !!wheel.validateConfig({}).error, true);
  check('a zero/negative weight is refused', !!wheel.validateConfig({ segments: [{ label: 'A', weight: 0 }, { label: 'B' }] }).error, true);
  check('an over-long label is refused', !!wheel.validateConfig({ segments: [{ label: 'x'.repeat(25) }, { label: 'B' }] }).error, true);
  check('an off-palette colour is refused', !!wheel.validateConfig({ segments: [{ label: 'A', color: '#ff00ff' }, { label: 'B' }] }).error, true);

  /* Blank rows are dropped, then the remainder is counted. */
  const dropped = wheel.validateConfig({ segments: [{ label: 'A' }, { label: '  ' }, { label: 'B' }] });
  check('blank rows are dropped', dropped.segments.length, 2);

  /* An explicit valid colour is kept. */
  const kept = wheel.validateConfig({ segments: [{ label: 'A', color: 'gold' }, { label: 'B', color: 'crimson' }] });
  check('an explicit palette colour is kept', [kept.segments[0].color, kept.segments[1].color], ['gold', 'crimson']);
}

/* ── pickWeighted ─────────────────────────────────────────────────────── */
{
  const segs = [{ label: 'A', weight: 90 }, { label: 'B', weight: 9 }, { label: 'C', weight: 1 }];
  check('ticket 0 → the heaviest', wheel.pickWeighted(segs, () => 0), 0);
  check('just past A → B', wheel.pickWeighted(segs, () => 0.9), 1);
  check('into the last unit → C', wheel.pickWeighted(segs, () => 0.99), 2);
  check('an empty wheel picks nothing', wheel.pickWeighted([], () => 0), -1);

  /* Statistical: probability ∝ weight. */
  const rng = seeded(4242);
  const wins = [0, 0, 0];
  const N = 40000;
  for (let i = 0; i < N; i++) wins[wheel.pickWeighted(segs, rng)]++;
  ok('A (90%) wins ~90%', Math.abs(wins[0] / N - 0.90) < 0.02);
  ok('B (9%) wins ~9%', Math.abs(wins[1] / N - 0.09) < 0.02);
  ok('C (1%) wins ~1%', Math.abs(wins[2] / N - 0.01) < 0.02);
}

/* ── Save / load round-trip ───────────────────────────────────────────── */
{
  const env = makeEnv();
  const saved = await (await post(env, { action: 'save', segments: [{ label: 'Yes', weight: 2, color: 'oxblood' }, { label: 'No', color: 'charcoal' }] })).json();
  check('save succeeds', saved.success, true);

  const loaded = await (await get(env)).json();
  check('load returns the saved segments', loaded.config.segments.map(s => s.label), ['Yes', 'No']);
  check('with weights', loaded.config.segments[0].weight, 2);
  ok('and the palette for the dashboard', loaded.palette && !!loaded.palette.oxblood);
}

/* ── Spin pushes a wheel-spin event of the right shape ────────────────── */
{
  const env = makeEnv();
  await post(env, { action: 'save', segments: [{ label: 'Alpha', weight: 5, color: 'crimson' }, { label: 'Beta', weight: 5, color: 'gold' }] });

  const r = await (await post(env, { action: 'spin' })).json();
  check('spin succeeds', r.success, true);
  ok('and names a winner', r.winner && typeof r.winner.index === 'number');

  const ev = lastEvent(env);
  check('a wheel-spin event reaches the overlay', ev && ev.type, 'wheel-spin');
  check('landing index matches the winner', ev.winnerIndex, r.winner.index);
  check('who is the winning label', ev.who, r.winner.label);
  check('segments carry resolved on-palette hex', ev.segments.map(s => s.color), [wheel.WHEEL_PALETTE.crimson, wheel.WHEEL_PALETTE.gold]);
  ok('segments carry weights so the overlay sizes arcs', ev.segments.every(s => Number(s.weight) > 0));
  check('the winning segment label is a real segment', ev.segments[ev.winnerIndex].label, r.winner.label);

  const lw = JSON.parse(env._store.get('wheel_last_winner'));
  check('the last winner is stored for the dashboard', lw.label, r.winner.label);
}

/* ── Spin with nothing configured ─────────────────────────────────────── */
{
  const env = makeEnv();
  const r = await post(env, { action: 'spin' });
  check('spinning an unconfigured wheel is refused', r.status, 400);
  check('and nothing was pushed', env._store.get('overlay_events') || null, null);
}

/* ── Staff gate ──────────────────────────────────────────────────────── */
{
  const env = makeEnv();
  check('a viewer cannot read the wheel', (await get(env, '12345')).status, 403);
  check('a viewer cannot save', (await post(env, { action: 'save', segments: [{ label: 'A' }, { label: 'B' }] }, '12345')).status, 403);
  check('a viewer cannot spin', (await post(env, { action: 'spin' }, '12345')).status, 403);
  check('and nothing was written', env._store.get('wheel_config') || null, null);
}

/* ── Unknown action ──────────────────────────────────────────────────── */
{
  const env = makeEnv();
  check('an unknown action is refused', (await post(env, { action: 'nope' })).status, 400);
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[wheel] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[wheel] ${passed} assertions passed.`);
console.log('');
