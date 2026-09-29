#!/usr/bin/env node
/* ══════════════════════════════════════════════
   MONTHLY LEDGER GIVEAWAY DRAW — test suite

     node server/scripts/test-giveaway-monthly.js

   The monthly draw is WEIGHTED — a viewer with more entries must win
   proportionally more often — and it hands out a real, locked prize code. Both
   are things you cannot verify by watching the reel spin, so they are pinned
   down here:

     - the pick is probability ∝ entries (deterministic with an injected RNG,
       and statistically over many seeded draws),
     - guests never win and never count toward the pool,
     - an empty / all-guest month draws nobody rather than throwing,
     - the cosmetic reel strip is bounded, looks weighted, and LANDS on the
       server's winner,
     - the control action stores its OWN winner record and never touches the
       Big Prize keys, and the won code is claimable only by the winner.

   No database: the KV shim is faked in memory and Helix is intercepted.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  drawMonthlyWinner, buildWeightedReelPool, monthlyLedgerTotals,
  ledgerKey, monthKey, redeemDropCode, getPrize, PRIZE_WINDOW_SECONDS,
} from '../../functions/api/giveaway-entries.js';
import * as control from '../../functions/api/bot/giveaway.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');

/* The reel math, loaded the way the browser loads it, so the strip test
   exercises the same file the overlay does. */
const reelScope = {};
new Function('window', fs.readFileSync(path.join(REPO, 'js/giveaway-reel.js'), 'utf8'))(reelScope);
const Reel = reelScope.PhamReel;

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

const BROADCASTER = '900';

/* A deterministic 0..1 source, so a statistical failure is reproducible. */
function seeded(seed) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  };
}

/* ── The fake channel ─────────────────────────────────────────────────── */

let whispers = [];

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('/helix/whispers')) {
    whispers.push({ to: new URL(u).searchParams.get('to_user_id'), message: JSON.parse(opts.body).message });
    return new Response(null, { status: 204 });
  }
  if (u.includes('oauth2/token') || u.includes('oauth2/validate')) {
    return new Response(JSON.stringify({ access_token: 't', expires_in: 3600, scopes: [] }), { status: 200 });
  }
  return new Response('{}', { status: 200 });
};

function makeEnv({ pools = { mythic: 3, rare: 3 } } = {}) {
  const store = new Map();
  const chains = new Map();
  const codePools = {};
  for (const [tier, n] of Object.entries(pools)) {
    codePools[tier] = Array.from({ length: n }, (_, i) => `${tier.slice(0, 2).toUpperCase()}CODE${i + 1}`);
  }

  store.set('twitch_bot_token', JSON.stringify({ access_token: 'x', expiresAt: Date.now() + 3600e3 }));
  store.set('twitch_bot_user_id', '555');
  store.set('twitch_broadcaster_token', JSON.stringify({ access_token: 'b', expiresAt: Date.now() + 3600e3 }));

  return {
    TWITCH_BROADCASTER_ID: BROADCASTER,
    TWITCH_CLIENT_ID: 'cid',
    TWITCH_CLIENT_SECRET: 'secret',
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
      async listValues({ prefix }) {
        const out = [];
        for (const [name, raw] of store) {
          if (name.startsWith(prefix)) out.push({ name, value: JSON.parse(raw) });
        }
        return out;
      },
      async pullGiveawayCode(tier) {
        const pool = codePools[tier];
        return (pool && pool.length) ? pool.shift() : null;
      },
    },
    _store: store,
    _pools: codePools,
  };
}

/* Seed a month's ledger directly, keyed exactly as addEntries() writes it. */
function seedLedger(env, month, counts) {
  for (const [userId, spec] of Object.entries(counts)) {
    const entries = typeof spec === 'number' ? spec : spec.entries;
    const username = typeof spec === 'number' ? userId : (spec.username || userId);
    env._store.set(ledgerKey(userId, month), JSON.stringify({
      userId, username, month, entries, history: [],
    }));
  }
}

const session = (userId = BROADCASTER, name = 'PhantomACE') =>
  encodeURIComponent(JSON.stringify({ user_id: userId, display_name: name }));

function panelRequest(body, userId = BROADCASTER) {
  return new Request('https://phantomace.tv/api/bot/giveaway', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `pham_session=${session(userId)}` },
    body: JSON.stringify(body),
  });
}
const post = (env, body, userId) => control.onRequestPost({ env, request: panelRequest(body, userId) });

const M = monthKey();

/* ── Weighted pick: deterministic bands ──────────────────────────────────
   Sorted most-entries-first, each entrant owns a band the width of its
   entries in [0, total). alice 90 → [0,90), bob 9 → [90,99), carol 1 →
   [99,100). A fixed ticket lands in exactly one band. */
{
  const env = makeEnv();
  seedLedger(env, M, { alice: 90, bob: 9, carol: 1, guest_whale: 1000 });

  const at = async (frac) => (await drawMonthlyWinner(env, { rng: () => frac })).winner.username;
  check('ticket 0 → the biggest earner', await at(0), 'alice');
  check('mid-band still the biggest earner', await at(0.5), 'alice');
  check('just past alice → bob', await at(0.9), 'bob');
  check('bob band → bob', await at(0.98), 'bob');
  check('into the last unit → carol', await at(0.99), 'carol');
  check('top of the range → carol', await at(0.999), 'carol');

  const draw = await drawMonthlyWinner(env, { rng: () => 0 });
  check('the pool total excludes the guest', draw.totalEntries, 100);
  check('and so does the head count', draw.totalPeople, 3);
  ok('the guest is never among the entrants', !draw.entrants.some(e => e.userId === 'guest_whale'));
}

/* ── Weighted pick: statistical over many seeded draws ────────────────── */
{
  const env = makeEnv();
  seedLedger(env, M, { alice: 70, bob: 25, carol: 5 });   // total 100
  const rng = seeded(12345);
  const wins = { alice: 0, bob: 0, carol: 0 };
  const N = 40000;
  for (let i = 0; i < N; i++) {
    const w = (await drawMonthlyWinner(env, { rng })).winner.username;
    wins[w]++;
  }
  ok('alice (70%) wins about 70% of the time', Math.abs(wins.alice / N - 0.70) < 0.02);
  ok('bob (25%) wins about 25% of the time', Math.abs(wins.bob / N - 0.25) < 0.02);
  ok('carol (5%) wins about 5% of the time', Math.abs(wins.carol / N - 0.05) < 0.02);
  ok('and everyone with entries can win', wins.alice > 0 && wins.bob > 0 && wins.carol > 0);
}

/* ── Empty and all-guest months draw nobody ──────────────────────────── */
{
  const env = makeEnv();
  const empty = await drawMonthlyWinner(env, { month: '1999-01' });
  check('an empty month draws nobody', empty.winner, null);
  check('with a zero pool', [empty.totalEntries, empty.totalPeople], [0, 0]);

  seedLedger(env, M, { guest_a: 50, guest_b: 20 });
  const allGuest = await drawMonthlyWinner(env);
  check('an all-guest month draws nobody', allGuest.winner, null);
  check('and counts none of them', allGuest.totalPeople, 0);

  const totals = await monthlyLedgerTotals(env);
  check('the pool preview also ignores guests', [totals.totalEntries, totals.totalPeople], [0, 0]);
}

/* ── The month parameter ─────────────────────────────────────────────── */
{
  const env = makeEnv();
  seedLedger(env, '2001-05', { onlyThen: 10 });
  seedLedger(env, M, { onlyNow: 3 });
  check('a past month draws from that month', (await drawMonthlyWinner(env, { month: '2001-05', rng: () => 0 })).winner.username, 'onlyThen');
  check('and the default is the current month', (await drawMonthlyWinner(env, { rng: () => 0 })).winner.username, 'onlyNow');
}

/* ── The cosmetic reel strip: bounded, weighted, lands on the winner ──── */
{
  const entrants = [
    { userId: '1', username: 'alice', entries: 90 },
    { userId: '2', username: 'bob', entries: 9 },
    { userId: '3', username: 'carol', entries: 1 },
  ];
  const winner = entrants[0];

  const { pool, winnerIndex } = buildWeightedReelPool(entrants, winner, { rng: seeded(7) });
  check('the strip is bounded to the cap', pool.length, 48);
  check('the returned index holds the winner', pool[winnerIndex].username, 'alice');

  /* THE RULE: the reel lands on the name the server drew. */
  const plan = Reel.strip(pool, winnerIndex);
  check('and PhamReel lands the reel on that winner', plan.names[plan.landing], 'alice');

  /* Weighted appearance: heavy earners flick past more often. Big cap, seeded
     RNG, so the ordering is stable and reproducible. */
  const big = buildWeightedReelPool(entrants, winner, { cap: 600, rng: seeded(99) });
  const count = (name) => big.pool.filter(p => p.username === name).length;
  ok('the reel shows the big earner far more than the small one', count('alice') > count('carol') * 5);
  ok('and more than the middle earner', count('alice') > count('bob'));

  /* Bounded even when far more people entered than the strip can show. */
  const crowd = Array.from({ length: 500 }, (_, i) => ({ userId: 'u' + i, username: 'u' + i, entries: 1 }));
  const crowded = buildWeightedReelPool(crowd, crowd[0], { rng: seeded(3) });
  check('a huge field still yields a bounded strip', crowded.pool.length, 48);
  check('that still lands on the winner', Reel.strip(crowded.pool, crowded.winnerIndex).names.slice(-1)[0], 'u0');

  /* Degenerate: a lone winner still spins on themselves rather than crashing. */
  const solo = buildWeightedReelPool([], { username: 'sam' });
  check('a lone winner fills a single-name strip', solo.pool, [{ username: 'sam' }]);
}

/* ── The control action: separate record, grand overlay reveal ───────── */
{
  const env = makeEnv();
  seedLedger(env, M, { alice: 5, bob: 5 });
  /* A Big Prize winner is already sitting in its own key — the monthly draw
     must not read, clobber, or be blocked by it. */
  env._store.set('giveaway_winner', JSON.stringify({ username: 'bigprize', rarity: 'mythic', sent: false }));

  const r = await (await post(env, { action: 'draw-monthly' })).json();
  check('the draw succeeds', r.success, true);
  ok('a winner is returned with an entry count', r.winner && typeof r.winner.entries === 'number');
  check('reporting the pool it came from', [r.totalEntries, r.totalPeople], [10, 2]);

  const stored = JSON.parse(env._store.get('giveaway_monthly_winner'));
  check('the winner is stored under the monthly key', stored.username, r.winner.username);
  check('the Big Prize winner key is untouched', JSON.parse(env._store.get('giveaway_winner')).username, 'bigprize');

  const feed = JSON.parse(env._store.get('overlay_events'));
  const spin = feed.events.find(e => e.type === 'giveaway-spin');
  ok('the grand reel reaches the overlay feed', !!spin);
  check('at mythic-tier grandeur', spin.rarity, 'mythic');
  check('labelled as the monthly draw', spin.label, 'Monthly Giveaway');
  ok('with a pool note', /Drawn from 10 entries across 2 people/.test(spin.note || ''));
  check('landing on the drawn winner', spin.who, r.winner.username);
  ok('and the strip is a bounded, weighted pool', Array.isArray(spin.entrants) && spin.entrants.length === 48);
  ok('whose landing index names the winner', spin.entrants[spin.winnerIndex].username === r.winner.username);

  /* Re-drawing just overwrites — no pending-winner guard on this event. */
  const again = await (await post(env, { action: 'draw-monthly' })).json();
  check('re-drawing is allowed (no pending guard)', again.success, true);
}

/* ── An empty month is a clean error, not a 500 ──────────────────────── */
{
  const env = makeEnv();
  const r = await post(env, { action: 'draw-monthly' });
  check('drawing an empty month is refused cleanly', r.status, 400);
  const body = await r.json();
  ok('with a readable message', /nobody has entered/i.test(body.error || ''));
}

/* ── THE PRIZE: a won monthly code is claimable, only by its winner ───── */
{
  const env = makeEnv({ pools: { mythic: 2 } });
  seedLedger(env, M, { winnerUser: 10 });
  await post(env, { action: 'draw-monthly' });

  const sent = await (await post(env, { action: 'send-monthly-code' })).json();
  check('the code is sent', sent.success, true);
  check('at the mythic (monthly) tier by default', sent.rarity, 'mythic');
  check('worth the mythic entry value', sent.entries, 50);
  check('one code came out of the mythic pool', env._pools.mythic.length, 1);
  check('and a whisper went out', whispers.length >= 1, true);

  const prize = await getPrize(env, 'winnerUser');
  ok('the winner has a prize waiting', !!prize);
  check('not yet claimed', prize.claimed, false);

  const stranger = await redeemDropCode(env, '99', 'stranger', prize.code);
  check('a stranger cannot claim it', stranger, { ok: false, reason: 'locked' });

  const won = await redeemDropCode(env, 'winnerUser', 'winnerUser', prize.code);
  check('the winner can', won.ok, true);
  check('for the mythic entry value', won.entries, 50);

  const after = await getPrize(env, 'winnerUser');
  check('and the card then reads as claimed', after.claimed, true);

  /* Sending twice is refused, and the Big Prize send-code path is untouched. */
  const twice = await post(env, { action: 'send-monthly-code' });
  check('a second send is refused', twice.status, 400);
}

/* ── Send with no winner drawn ───────────────────────────────────────── */
{
  const env = makeEnv();
  const r = await post(env, { action: 'send-monthly-code' });
  check('sending a code before drawing is refused', r.status, 400);
}

/* ── Moderation gate ─────────────────────────────────────────────────── */
{
  const env = makeEnv();
  seedLedger(env, M, { alice: 3 });
  const drawn = await post(env, { action: 'draw-monthly' }, '12345');
  check('a viewer cannot draw the monthly winner', drawn.status, 403);
  ok('and no winner was recorded', !env._store.get('giveaway_monthly_winner'));

  const sendCode = await post(env, { action: 'send-monthly-code' }, '12345');
  check('nor send a monthly code', sendCode.status, 403);
}

/* ── The Big Prize draw still works alongside it ─────────────────────── */
{
  /* A smoke check that adding the monthly actions did not break the existing
     invalid-action fall-through or the shared handler. */
  const env = makeEnv();
  const bad = await post(env, { action: 'not-a-real-action' });
  check('an unknown action is still rejected', bad.status, 400);
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[giveaway-monthly] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[giveaway-monthly] ${passed} assertions passed.`);
console.log('');
