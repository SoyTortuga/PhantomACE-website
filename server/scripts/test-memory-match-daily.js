#!/usr/bin/env node
/* ══════════════════════════════════════════════
   MEMORY MATCH DAILY SEED — test suite

     node server/scripts/test-memory-match-daily.js

   The daily challenge is one fixed board per Pacific calendar day: everyone is
   dealt the SAME shuffle, derived deterministically from the date, and the deal
   is server-authoritative (the client never picks the layout and can't retry
   it). Mirrors test-memory-match.js — real handler, a fake MARKETPLACE whose
   mutate() holds a per-key lock.

   - the same dayKey yields the identical deck; a different day differs.
   - the daily is server-dealt (start hands out no deck) and server-validated
     (forged / out-of-order flips rejected), exactly like ranked.
   - a player can finish the daily once per day — a second start is refused and
     returns their standing; the board keeps one row per player.
   - the day's board ranks fewest moves first.
   - the day boundary is Pacific, not UTC, and a rollover resets the board.
   - the daily never touches the monthly ranked boards.
   ══════════════════════════════════════════════ */

import {
  onRequestGet, onRequestPost, dayKey, seededDeck, dailySeedString,
} from '../../functions/api/memory-match.js';

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), x = JSON.stringify(expected);
  if (a === x) { passed++; return; }
  failures.push(`${label}\n      expected ${x}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

function makeEnv() {
  const store = new Map();
  const writes = {};
  const locks = new Map();
  const ttls = {};
  return {
    MARKETPLACE: {
      async get(key, type) {
        if (!store.has(key)) return null;
        const raw = store.get(key);
        return type === 'json' ? JSON.parse(raw) : raw;
      },
      async put(key, value) {
        writes[key] = (writes[key] || 0) + 1;
        store.set(key, typeof value === 'string' ? value : JSON.stringify(value));
      },
      async mutate(key, fn, opts = {}) {
        const prev = locks.get(key) || Promise.resolve();
        let release;
        const mine = new Promise(r => { release = r; });
        locks.set(key, prev.then(() => mine));
        await prev;
        try {
          const current = store.has(key) ? JSON.parse(store.get(key)) : null;
          const next = await fn(current);
          if (next === undefined) return current;
          writes[key] = (writes[key] || 0) + 1;
          if (opts.expirationTtl) ttls[key] = opts.expirationTtl;
          store.set(key, JSON.stringify(next));
          return JSON.parse(store.get(key));
        } finally {
          release();
        }
      },
      async claimMonthlyAward() { return false; },
    },
    store, writes, ttls,
  };
}

const USERS = {
  a: { user_id: '101', display_name: 'Ash' },
  b: { user_id: '202', display_name: 'Bry' },
  c: { user_id: '303', display_name: 'Cas' },
};
const cookie = (u) => `pham_session=${encodeURIComponent(JSON.stringify(USERS[u]))}`;

async function post(env, who, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (who) headers.Cookie = cookie(who);
  const res = await onRequestPost({ env, request: new Request('http://localhost/api/memory-match', {
    method: 'POST', headers, body: JSON.stringify(body),
  }) });
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text), raw: text };
}

async function get(env, who, query = '') {
  const res = await onRequestGet({ env, request: new Request('http://localhost/api/memory-match' + query, {
    headers: who ? { Cookie: cookie(who) } : {},
  }) });
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text), raw: text };
}

const stored = (env, key) => (env.store.has(key) ? JSON.parse(env.store.get(key)) : null);
const dailyGameOf = (env, who) => stored(env, 'mm_daily_game_' + USERS[who].user_id);

/* Play the stored daily deck perfectly (the test can see what the client can't). */
async function playDaily(env, who, gameId, { extraMisses = 0 } = {}) {
  const deck = dailyGameOf(env, who).deck;
  const byPair = {};
  deck.forEach((p, i) => { (byPair[p] = byPair[p] || []).push(i); });
  const pairs = Object.values(byPair);
  let seq = 0;
  const out = [];
  for (let m = 0; m < extraMisses; m++) {
    const [x] = pairs[m];
    const [y] = pairs[m + 1];
    out.push(await post(env, who, { action: 'flip', mode: 'daily', gameId, index: x, seq: seq++ }));
    out.push(await post(env, who, { action: 'flip', mode: 'daily', gameId, index: y, seq: seq++ }));
  }
  for (const [x, y] of pairs) {
    out.push(await post(env, who, { action: 'flip', mode: 'daily', gameId, index: x, seq: seq++ }));
    out.push(await post(env, who, { action: 'flip', mode: 'daily', gameId, index: y, seq: seq++ }));
  }
  return out;
}

/* ── Determinism: same day = same deck, different day differs ──────────── */
{
  const d1 = seededDeck(20, '2026-05-01');
  const d2 = seededDeck(20, '2026-05-01');
  check('same dayKey yields the identical deck', d1, d2);
  const d3 = seededDeck(20, '2026-05-02');
  ok('a different day yields a different deck', JSON.stringify(d1) !== JSON.stringify(d3));

  check('the seeded deck is 40 cards', d1.length, 40);
  const counts = {};
  for (const p of d1) counts[p] = (counts[p] || 0) + 1;
  check('every pair id appears exactly twice', Object.values(counts).every(c => c === 2) && Object.keys(counts).length === 20, true);

  check('the seed string is namespaced by day + size', dailySeedString('2026-05-01', 20), 'memory-match-daily:2026-05-01:20');
  /* Determinism holds across a fresh module-level run: recomputing from the
     seed string reproduces the deck byte-for-byte. */
  check('recomputed from the same seed string', seededDeck(20, '2026-05-01'), d1);
}

/* ── dayKey follows the Pacific calendar, not UTC ──────────────────────── */
{
  /* 06:00 UTC on the 16th is still the 15th in Pacific (PDT, UTC-7); 07:00 UTC
     is Pacific midnight, the 16th. The UTC date is the 16th in both — so a key
     reading 2026-03-15 proves the boundary is Pacific. */
  check('before Pacific midnight is still the previous day', dayKey(new Date('2026-03-16T06:00:00Z')), '2026-03-15');
  check('at Pacific midnight the day rolls', dayKey(new Date('2026-03-16T07:00:00Z')), '2026-03-16');
  ok('the boundary is not UTC', dayKey(new Date('2026-03-16T06:00:00Z')) !== '2026-03-16');
}

/* ── Server-dealt, no client-chosen layout ─────────────────────────────── */
{
  const env = makeEnv();
  const guest = await post(env, null, { action: 'start', mode: 'daily' });
  check('guest daily start → 401', guest.status, 401);
  check('guest start writes nothing', env.store.size, 0);

  const s = await post(env, 'a', { action: 'start', mode: 'daily' });
  check('daily start → 200', s.status, 200);
  check('daily start is 20 pairs', s.body.pairs, 20);
  check('daily start flags daily + board', [s.body.daily, s.body.board], [true, 'memory-match-daily']);
  ok('daily start hands out no deck', !/deck/i.test(s.raw));
  ok('daily start returns a game id', typeof s.body.gameId === 'string' && s.body.gameId.length > 0);

  const g = dailyGameOf(env, 'a');
  check('the game is stored server-side under mm_daily_game_<userId>', !!g, true);
  check('stored under a 1h sliding TTL', env.ttls['mm_daily_game_101'], 3600);
  check('the deck is the seed for today', g.deck, seededDeck(20, g.dayKey));
  check('the stored game is marked daily with its dayKey', [g.daily, typeof g.dayKey], [true, 'string']);

  /* Forged / out-of-order flips are rejected, exactly like ranked. */
  check('a forged game id is rejected', (await post(env, 'a', { action: 'flip', mode: 'daily', gameId: 'nope', index: 0, seq: 0 })).status, 404);
  check('a seq ahead is rejected', (await post(env, 'a', { action: 'flip', mode: 'daily', gameId: s.body.gameId, index: 0, seq: 9 })).status, 409);
  check("another player can't flip it", (await post(env, 'b', { action: 'flip', mode: 'daily', gameId: s.body.gameId, index: 0, seq: 0 })).status, 404);
  const f0 = await post(env, 'a', { action: 'flip', mode: 'daily', gameId: s.body.gameId, index: 0, seq: 0 });
  check('a real flip reveals exactly that card', f0.body.face, g.deck[0]);
  check('replaying it is rejected', (await post(env, 'a', { action: 'flip', mode: 'daily', gameId: s.body.gameId, index: 0, seq: 0 })).status, 409);
}

/* ── Everyone gets the same deal that day ──────────────────────────────── */
{
  const env = makeEnv();
  const sa = await post(env, 'a', { action: 'start', mode: 'daily' });
  const sb = await post(env, 'b', { action: 'start', mode: 'daily' });
  ok('two players get distinct game ids', sa.body.gameId !== sb.body.gameId);
  check('but the identical deck', dailyGameOf(env, 'a').deck, dailyGameOf(env, 'b').deck);
}

/* ── Resume, not re-deal: a half-played board keeps its moves ───────────── */
{
  const env = makeEnv();
  const s = await post(env, 'a', { action: 'start', mode: 'daily' });
  const deck = dailyGameOf(env, 'a').deck;
  const byPair = {};
  deck.forEach((p, i) => { (byPair[p] = byPair[p] || []).push(i); });
  const pairs = Object.values(byPair);
  /* One matched pair, so the board is mid-game. */
  await post(env, 'a', { action: 'flip', mode: 'daily', gameId: s.body.gameId, index: pairs[0][0], seq: 0 });
  await post(env, 'a', { action: 'flip', mode: 'daily', gameId: s.body.gameId, index: pairs[0][1], seq: 1 });

  const again = await post(env, 'a', { action: 'start', mode: 'daily' });
  check('re-starting mid-game resumes the same board', [again.body.resumed, again.body.gameId], [true, s.body.gameId]);
  check('the resumed state carries the moves so far', again.body.game.moves, 1);
  ok('the resume carries the matched cards', again.body.game.revealed.length === 2 && again.body.game.revealed.every(r => r.matched));
  ok('resume leaks no face-down deck', !/\"deck\"/.test(again.raw));
}

/* ── One finish per day; the board ranks fewest moves first ─────────────── */
{
  const env = makeEnv();
  const sa = await post(env, 'a', { action: 'start', mode: 'daily' });
  const fa = await playDaily(env, 'a', sa.body.gameId);
  const lastA = fa[fa.length - 1].body;
  check('a perfect daily finishes in 20 moves', lastA.moves, 20);
  check('it is recorded with a rank', [lastA.recorded, lastA.rank, lastA.total, lastA.board], [true, 1, 1, 'memory-match-daily']);
  ok("it does NOT touch the ranked board", env.writes.lb_memory_match === undefined);

  const dk = dailyGameOf(env, 'a').dayKey;
  const board = stored(env, 'mm_daily_' + dk);
  check('the day board has one row for the finisher', board.results.map(r => [r.id, r.score]), [['101', 20]]);
  check('the day board stored with its own TTL', env.ttls['mm_daily_' + dk], 60 * 60 * 24 * 3);

  /* A second start is refused: the player is already on today's board. */
  const again = await post(env, 'a', { action: 'start', mode: 'daily' });
  check('a second start that day is refused as done', again.body.dailyDone, true);
  check('and returns their standing', [again.body.best, again.body.rank, again.body.total], [20, 1, 1]);
  ok('no new game is dealt', !again.body.gameId);
  check('the board still has exactly one row for them', stored(env, 'mm_daily_' + dk).results.length, 1);

  /* Bry plays worse; Cas plays best. The board sorts fewest-moves-first. */
  const sb = await post(env, 'b', { action: 'start', mode: 'daily' });
  const fb = await playDaily(env, 'b', sb.body.gameId, { extraMisses: 4 });
  check('a worse run ranks below', [fb[fb.length - 1].body.moves, fb[fb.length - 1].body.rank], [24, 2]);

  const sc = await post(env, 'c', { action: 'start', mode: 'daily' });
  const fc = await playDaily(env, 'c', sc.body.gameId);
  check('a tie on moves ranks by finish time (earlier first)', fc[fc.length - 1].body.rank, 2);

  const finalBoard = stored(env, 'mm_daily_' + dk);
  check('the day board is sorted ascending by moves', finalBoard.results.map(r => [r.id, r.score]), [['101', 20], ['303', 20], ['202', 24]]);

  /* The daily GET reports the player's standing and today's top list. */
  const gv = await get(env, 'a', '?mode=daily');
  check('GET mode=daily reports done + best + rank', [gv.body.done, gv.body.best, gv.body.rank, gv.body.total], [true, 20, 1, 3]);
  check('the top list is names + scores only (no ids leak)', gv.body.top.map(r => [r.rank, r.name, r.score, r.you]),
    [[1, 'Ash', 20, true], [2, 'Cas', 20, false], [3, 'Bry', 24, false]]);
  ok('GET mode=daily leaks no ids', !/\"id\"/.test(gv.raw));
}

/* ── Day rollover (Pacific) resets the board ────────────────────────────── */
{
  const RealDate = Date;
  const setNow = (iso) => {
    const fixed = new RealDate(iso).getTime();
    class FakeDate extends RealDate {
      constructor(...args) { if (args.length === 0) super(fixed); else super(...args); }
      static now() { return fixed; }
    }
    globalThis.Date = FakeDate;
  };
  try {
    const env = makeEnv();

    setNow('2026-07-10T19:00:00Z');           // Pacific: 2026-07-10 noon
    const dayA = dayKey();
    const sa = await post(env, 'a', { action: 'start', mode: 'daily' });
    await playDaily(env, 'a', sa.body.gameId);
    const doneA = await post(env, 'a', { action: 'start', mode: 'daily' });
    check('done on day A', doneA.body.dailyDone, true);

    setNow('2026-07-11T19:00:00Z');           // the next Pacific day
    const dayB = dayKey();
    ok('the day rolled over', dayA !== dayB);
    const sb = await post(env, 'a', { action: 'start', mode: 'daily' });
    check('the same player may play again the next day', [sb.body.dailyDone, !!sb.body.gameId], [undefined, true]);
    ok("day B's board is a fresh key", !env.store.has('mm_daily_' + dayB) || stored(env, 'mm_daily_' + dayB).results.length === 0);
    ok("day A's board is untouched by the new day", stored(env, 'mm_daily_' + dayA).results.length === 1);
    ok('the two days deal different decks', JSON.stringify(seededDeck(20, dayA)) !== JSON.stringify(seededDeck(20, dayB)));
  } finally {
    globalThis.Date = RealDate;
  }
}

/* ── The daily never writes a monthly ranked board ─────────────────────── */
{
  const env = makeEnv();
  const s = await post(env, 'a', { action: 'start', mode: 'daily' });
  await playDaily(env, 'a', s.body.gameId);
  ok('no ranked board was written', [env.writes.lb_memory_match, env.writes.lb_memory_match_15, env.writes.lb_memory_match_10].every(w => w === undefined));
  ok('a daily board WAS written', Object.keys(env.writes).some(k => k.startsWith('mm_daily_') && !k.startsWith('mm_daily_game_')));
}

if (failures.length) {
  console.error(`\n✗ ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`✓ all ${passed} memory match daily checks passed`);
