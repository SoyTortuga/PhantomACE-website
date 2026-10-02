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
import { resolveKey } from '../lib/registry.js';
import { runMonthlyDraw } from './draw-monthly-giveaway.js';

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
  const ttls = new Map();
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
      async put(k, v, opts) {
        store.set(k, typeof v === 'string' ? v : JSON.stringify(v));
        ttls.set(k, opts && opts.expirationTtl ? opts.expirationTtl : null);
      },
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
    _ttls: ttls,
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
const post = (env, body, userId, now) => control.onRequestPost({ env, request: panelRequest(body, userId), now });
const getPanel = (env, now, userId = BROADCASTER) => control.onRequestGet({
  env, now,
  request: new Request('https://phantomace.tv/api/bot/giveaway', { headers: { Cookie: `pham_session=${session(userId)}` } }),
});

const M = monthKey();
const winnerKey = (month) => `giveaway_monthly_winner_${month}`;
const stored = (env, month) => { const raw = env._store.get(winnerKey(month)); return raw ? JSON.parse(raw) : null; };

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

  const rec = stored(env, M);
  check('the winner is stored under its own month key', rec.username, r.winner.username);
  ok('and the legacy single key is never written', !env._store.has('giveaway_monthly_winner'));
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

  /* The reveal is stored on the winner so it can be replayed later. */
  ok('the monthly winner stores its reel payload for replay', rec.reveal && Array.isArray(rec.reveal.entrants) && rec.reveal.entrants.length === 48);

  /* An UNSENT winner may be re-rolled — and the re-roll is logged. */
  const again = await (await post(env, { action: 'draw-monthly' })).json();
  check('re-rolling an unsent winner is allowed', again.success, true);
  check('the replaced winner is kept in history', stored(env, M).history.length, 1);
  const log = JSON.parse(env._store.get('bot_action_log'));
  check('the re-roll is logged as one', [log[0].type, log[0].reroll, log[0].previous, log[0].forced], ['giveaway-winner', true, rec.username, false]);
}

/* ── Replay last reveal (the Overlay Dashboard button) ────────────────── */
{
  const env = makeEnv();
  /* Nothing drawn yet → a clean refusal, not a crash. */
  const none = await post(env, { action: 'replay', which: 'monthly' });
  check('replaying with no monthly winner is refused', none.status, 400);

  seedLedger(env, M, { alice: 8, bob: 2 });
  await post(env, { action: 'draw-monthly' });
  const before = JSON.parse(env._store.get('overlay_events')).events.filter(e => e.type === 'giveaway-spin').length;

  const rr = await (await post(env, { action: 'replay', which: 'monthly' })).json();
  check('replay succeeds once a winner is stored', rr.success, true);

  const after = JSON.parse(env._store.get('overlay_events')).events.filter(e => e.type === 'giveaway-spin');
  check('replay re-pushes another giveaway-spin', after.length, before + 1);
  const replayed = after[after.length - 1];
  check('the replayed reveal keeps the monthly label', replayed.label, 'Monthly Giveaway');
  check('and lands on the same stored winner', replayed.who, rr.who);
  check('and is the full bounded weighted strip', replayed.entrants.length, 48);
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
  ok('and no winner was recorded', !stored(env, M) && !env._store.get('giveaway_monthly_winner'));

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

/* ══ HARDENING: per-month records, sent-guard, grace window ═════════════
   Fixed instants on the Pacific season calendar, injected as context.now:
     DAY2      2026-10-02 12:00 PT  — grace open, cur 2026-10, prev 2026-09
     DAY7_LATE 2026-10-07 23:30 PT  — still day 7 (UTC already says the 8th)
     DAY8      2026-10-08 00:30 PT  — grace closed
     DAY8_NOON 2026-10-08 12:00 PT */
const DAY2 = Date.UTC(2026, 9, 2, 19, 0, 0);
const DAY7_LATE = Date.UTC(2026, 9, 8, 6, 30, 0);
const DAY8 = Date.UTC(2026, 9, 8, 7, 30, 0);
const DAY8_NOON = Date.UTC(2026, 9, 8, 19, 0, 0);
const CUR = '2026-10', PREV = '2026-09';
const MOD = '777';
const withMod = (env) => env._store.set('site_moderators', JSON.stringify({ entries: [{ userId: MOD, displayName: 'mod' }] }));

/* ── Re-draw after the code was sent is refused; only the broadcaster may force ── */
{
  const env = makeEnv({ pools: { mythic: 5 } });
  withMod(env);
  seedLedger(env, CUR, { alice: 5, bob: 5 });
  check('draw', (await post(env, { action: 'draw-monthly' }, BROADCASTER, DAY2)).status, 200);
  check('send', (await post(env, { action: 'send-monthly-code', month: CUR }, BROADCASTER, DAY2)).status, 200);
  const sentRec = stored(env, CUR);
  check('the record is marked sent', sentRec.sent, true);

  const again = await post(env, { action: 'draw-monthly' }, BROADCASTER, DAY2);
  check('a re-draw after the code went out is refused', again.status, 409);
  const againBody = await again.json();
  ok('with a clear error naming the winner and month', againBody.alreadySent && againBody.error.includes(sentRec.username) && againBody.error.includes(CUR));
  check('and the sent record is untouched', stored(env, CUR), sentRec);

  const modRedraw = await post(env, { action: 'draw-monthly' }, MOD, DAY2);
  check('a moderator without force is refused too', modRedraw.status, 409);
  const modForce = await post(env, { action: 'draw-monthly', force: true }, MOD, DAY2);
  check('a moderator cannot force it', modForce.status, 403);
  ok('and is told only the broadcaster can', /only the broadcaster/i.test((await modForce.json()).error));
  check('still untouched after the moderator tries', stored(env, CUR), sentRec);

  const truthy = await post(env, { action: 'draw-monthly', force: 'true' }, BROADCASTER, DAY2);
  check('force must be literally true', truthy.status, 409);

  const forced = await post(env, { action: 'draw-monthly', force: true }, BROADCASTER, DAY2);
  check('the broadcaster CAN force a re-draw', forced.status, 200);
  const after = stored(env, CUR);
  check('the new record starts unsent', after.sent, false);
  check('and keeps the sent winner (and their code) in history', [after.history[0].username, after.history[0].sent, after.history[0].code], [sentRec.username, true, sentRec.code]);
  const log = JSON.parse(env._store.get('bot_action_log'));
  check('the forced re-draw is logged as forced', [log[0].reroll, log[0].forced], [true, true]);
}

/* ── Last month is drawable only through day 7, Pacific ─────────────── */
{
  const env = makeEnv();
  seedLedger(env, PREV, { olduser: 4 });
  seedLedger(env, CUR, { newuser: 2 });

  const late7 = await post(env, { action: 'draw-monthly', month: PREV }, BROADCASTER, DAY7_LATE);
  check('day 7 at 23:30 PT (already the 8th in UTC) is still in the window', late7.status, 200);
  check('and draws last month', stored(env, PREV).month, PREV);

  const env2 = makeEnv();
  seedLedger(env2, PREV, { olduser: 4 });
  const day8 = await post(env2, { action: 'draw-monthly', month: PREV }, BROADCASTER, DAY8);
  check('day 8 at 00:30 PT refuses last month', day8.status, 400);
  const day8Body = await day8.json();
  ok('saying the window closed', day8Body.graceClosed === true && /closed after day 7/.test(day8Body.error));
  ok('and nothing was written', !stored(env2, PREV));
  check('day 8 noon refuses it too', (await post(env2, { action: 'draw-monthly', month: PREV }, BROADCASTER, DAY8_NOON)).status, 400);
  check('even the broadcaster forcing', (await post(env2, { action: 'draw-monthly', month: PREV, force: true }, BROADCASTER, DAY8_NOON)).status, 400);
  check('two months back is never drawable', (await post(env2, { action: 'draw-monthly', month: '2026-08' }, BROADCASTER, DAY2)).status, 400);

  const g2 = await (await getPanel(env2, DAY2)).json();
  check('status on day 2: grace open', [g2.monthlyGrace.open, g2.monthlyGrace.day, g2.monthlyGrace.month, g2.monthlyGrace.current], [true, 2, PREV, CUR]);
  check('and last month\'s pool is offered', g2.monthlyPrev && g2.monthlyPrev.totalEntries, 4);
  const g8 = await (await getPanel(env2, DAY8)).json();
  check('status on day 8: grace closed', g8.monthlyGrace.open, false);
  check('and last month\'s pool is no longer offered', g8.monthlyPrev, null);
}

/* ── Current and last month never overwrite each other ───────────────── */
{
  const env = makeEnv({ pools: { mythic: 5 } });
  seedLedger(env, PREV, { olduser: 4 });
  seedLedger(env, CUR, { newuser: 2 });

  await post(env, { action: 'draw-monthly', month: PREV }, BROADCASTER, DAY2);
  await post(env, { action: 'draw-monthly' }, BROADCASTER, DAY2);
  check('last month\'s winner is under its own key', stored(env, PREV).username, 'olduser');
  check('this month\'s under its own', stored(env, CUR).username, 'newuser');
  check('the last-month reveal is labelled with its month', stored(env, PREV).reveal.label, `Monthly Giveaway · ${PREV}`);
  check('the current one is not', stored(env, CUR).reveal.label, 'Monthly Giveaway');

  const sentPrev = await (await post(env, { action: 'send-monthly-code', month: PREV }, BROADCASTER, DAY2)).json();
  check('sending for last month goes to last month\'s winner', [sentPrev.success, sentPrev.month, sentPrev.winner.username], [true, PREV, 'olduser']);
  check('last month is marked sent', stored(env, PREV).sent, true);
  check('this month is NOT', stored(env, CUR).sent, false);
  check('one code left the pool', env._pools.mythic.length, 4);

  check('a re-draw of this month is still allowed (unsent)', (await post(env, { action: 'draw-monthly' }, BROADCASTER, DAY2)).status, 200);
  check('without touching last month', stored(env, PREV).sent, true);

  const panel = await (await getPanel(env, DAY2)).json();
  check('the panel shows this month\'s winner', panel.monthlyWinner && panel.monthlyWinner.month, CUR);
  check('and last month\'s during grace', panel.monthlyPrevWinner && panel.monthlyPrevWinner.month, PREV);
  ok('without shipping the 48-name reel strip', !('reveal' in panel.monthlyWinner) && panel.monthlyWinner.replayable === true);
  check('re-roll count is surfaced', panel.monthlyWinner.rerolls, 1);

  const day8 = await (await getPanel(env, DAY8_NOON)).json();
  check('after grace a SENT last-month winner drops off the panel', day8.monthlyPrevWinner, null);

  /* Replay targets the month asked for, else the most recent draw. */
  const rPrev = await (await post(env, { action: 'replay', which: 'monthly', month: PREV }, BROADCASTER, DAY2)).json();
  check('replay with a month re-pushes that month', [rPrev.who, rPrev.month], ['olduser', PREV]);
  const rDefault = await (await post(env, { action: 'replay', which: 'monthly' }, BROADCASTER, DAY2)).json();
  check('replay without one re-pushes the latest draw', rDefault.month, CUR);
  check('the status replay entry names that same record', panel.replay.monthly.month, CUR);
  check('replay of an out-of-range month is refused', (await post(env, { action: 'replay', which: 'monthly', month: '2020-01' }, BROADCASTER, DAY2)).status, 400);
}

/* ── An UNSENT last-month winner stays on the panel past grace ───────── */
{
  const env = makeEnv({ pools: { mythic: 2 } });
  seedLedger(env, PREV, { olduser: 4 });
  await post(env, { action: 'draw-monthly', month: PREV }, BROADCASTER, DAY7_LATE);
  const day8 = await (await getPanel(env, DAY8_NOON)).json();
  check('an undelivered prize does not vanish on day 8', day8.monthlyPrevWinner && day8.monthlyPrevWinner.username, 'olduser');
  const send = await (await post(env, { action: 'send-monthly-code', month: PREV }, BROADCASTER, DAY8_NOON)).json();
  check('and its code can still be sent', [send.success, send.month], [true, PREV]);
}

/* ── Records persist with no TTL; the family is registered as permanent ── */
{
  const env = makeEnv({ pools: { mythic: 2 } });
  seedLedger(env, CUR, { alice: 3 });
  await post(env, { action: 'draw-monthly' }, BROADCASTER, DAY2);
  check('the draw writes no TTL', env._ttls.get(winnerKey(CUR)), null);
  await post(env, { action: 'send-monthly-code', month: CUR }, BROADCASTER, DAY2);
  check('the send writes no TTL either', env._ttls.get(winnerKey(CUR)), null);
  check('the per-month family resolves to a permanent singleton row', resolveKey(winnerKey(CUR)), { table: 'singletons', expiry: 'none' });
  check('the legacy key keeps its own exact entry', resolveKey('giveaway_monthly_winner'), { table: 'singletons', expiry: 'real' });
}

/* ── The legacy single key is still read ─────────────────────────────── */
{
  const env = makeEnv({ pools: { mythic: 2 } });
  seedLedger(env, CUR, { alice: 3 });
  env._store.set('giveaway_monthly_winner', JSON.stringify({ userId: 'legacyWinner', username: 'legacyWinner', month: CUR, sent: true, code: 'OLD', reveal: { entrants: [{ username: 'legacyWinner' }], winnerIndex: 0 } }));

  const panel = await (await getPanel(env, DAY2)).json();
  check('the panel shows a legacy winner for its month', panel.monthlyWinner && panel.monthlyWinner.username, 'legacyWinner');
  check('a legacy SENT winner still blocks a re-draw', (await post(env, { action: 'draw-monthly' }, BROADCASTER, DAY2)).status, 409);
  check('and refuses a second send', (await post(env, { action: 'send-monthly-code', month: CUR }, BROADCASTER, DAY2)).status, 400);
  check('a legacy record from another month is ignored', (await (await getPanel(env, Date.UTC(2026, 10, 2, 19))).json()).monthlyWinner, null);

  const env2 = makeEnv({ pools: { mythic: 2 } });
  env2._store.set('giveaway_monthly_winner', JSON.stringify({ userId: 'legacyWinner', username: 'legacyWinner', month: CUR, sent: false, rarity: 'mythic' }));
  const send = await (await post(env2, { action: 'send-monthly-code', month: CUR }, BROADCASTER, DAY2)).json();
  check('an unsent legacy winner can be sent its code', [send.success, send.winner.username], [true, 'legacyWinner']);
  check('which lands in the per-month record', stored(env2, CUR).sent, true);
  check('and the legacy key is left as it was', JSON.parse(env2._store.get('giveaway_monthly_winner')).sent, false);
}

/* ── Two sends at once pull ONE code ─────────────────────────────────── */
{
  const env = makeEnv({ pools: { mythic: 5 } });
  seedLedger(env, CUR, { alice: 3 });
  await post(env, { action: 'draw-monthly' }, BROADCASTER, DAY2);
  const [a, b] = await Promise.all([
    post(env, { action: 'send-monthly-code', month: CUR }, BROADCASTER, DAY2),
    post(env, { action: 'send-monthly-code', month: CUR }, BROADCASTER, DAY2),
  ]);
  check('exactly one concurrent send succeeds', [a.status, b.status].sort(), [200, 409]);
  check('and only one mythic code left the pool', env._pools.mythic.length, 4);
  ok('the claim marker is cleared once sent', !('sendingAt' in stored(env, CUR)));

  const env2 = makeEnv({ pools: { mythic: 0 } });
  seedLedger(env2, CUR, { alice: 3 });
  await post(env2, { action: 'draw-monthly' }, BROADCASTER, DAY2);
  check('an empty pool fails the send', (await post(env2, { action: 'send-monthly-code', month: CUR }, BROADCASTER, DAY2)).status, 400);
  ok('and releases the claim so it can be retried', !('sendingAt' in stored(env2, CUR)));
  check('a re-roll is not blocked by a released claim', (await post(env2, { action: 'draw-monthly' }, BROADCASTER, DAY2)).status, 200);
}

/* ── The rig draw script: Pacific month, per-month key, same guard ───── */
{
  const src = fs.readFileSync(path.join(HERE, 'draw-monthly-giveaway.js'), 'utf8');
  ok('the script no longer does UTC month math', !/getUTCMonth|getUTCFullYear/.test(src));
  ok('it takes the default month from season-time prevMonthKey', /prevMonthKey/.test(src) && /season-time\.js/.test(src));

  const env = makeEnv();
  seedLedger(env, '2026-08', { scriptUser: 6 });
  const dry = await runMonthlyDraw(env, { month: '2026-08' });
  check('dry run draws but writes nothing', [dry.status, stored(env, '2026-08')], ['dry-run', null]);
  const real = await runMonthlyDraw(env, { month: '2026-08', confirm: true });
  check('confirm writes the per-month key', [real.status, stored(env, '2026-08').username], ['stored', 'scriptUser']);
  check('with no TTL', env._ttls.get(winnerKey('2026-08')), null);
  ok('and never the legacy key', !env._store.has('giveaway_monthly_winner'));

  const rec = stored(env, '2026-08');
  env._store.set(winnerKey('2026-08'), JSON.stringify({ ...rec, sent: true, code: 'X1' }));
  const refused = await runMonthlyDraw(env, { month: '2026-08', confirm: true });
  check('the script refuses a re-draw after send', refused.status, 'refused');
  check('leaving the record alone', stored(env, '2026-08').code, 'X1');
  const forced = await runMonthlyDraw(env, { month: '2026-08', confirm: true, force: true });
  check('--force re-draws it', [forced.status, stored(env, '2026-08').sent, stored(env, '2026-08').history.length], ['stored', false, 1]);
  check('a malformed month is rejected', (await runMonthlyDraw(env, { month: 'sept' })).status, 'bad-month');
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
