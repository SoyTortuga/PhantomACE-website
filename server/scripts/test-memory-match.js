#!/usr/bin/env node
/* ══════════════════════════════════════════════
   MEMORY MATCH RANKED — test suite

     node server/scripts/test-memory-match.js

   Plays real games through the real handler with a fake MARKETPLACE whose
   mutate() holds a per-key lock, like the Postgres one does.

   - start never hands out the deck order; it deals a real deck server-side.
   - a perfect game ends at pairs moves and writes the board exactly once,
     after settling the monthly awards.
   - forged / replayed / out-of-order flips are rejected and change nothing.
   - each deck size ranks on its own board; packs need to be owned.
   - best (lowest) per user is kept.
   - the server's set sizes and pack-name resolver match the game page, and
     the page no longer posts its own score.
   ══════════════════════════════════════════════ */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  onRequestGet, onRequestPost, SET_PAIRS, BOARD_BY_PAIRS, setKeyForItemName, dealDeck,
} from '../../functions/api/memory-match.js';

const here = dirname(fileURLToPath(import.meta.url));

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
  let claims = 0;
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
      async claimMonthlyAward() { claims++; return false; },
    },
    store, writes, ttls,
    get claims() { return claims; },
  };
}

const USERS = {
  a: { user_id: '101', display_name: 'Ash' },
  b: { user_id: '202', display_name: 'Bry' },
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

async function get(env, who) {
  const res = await onRequestGet({ env, request: new Request('http://localhost/api/memory-match', {
    headers: who ? { Cookie: cookie(who) } : {},
  }) });
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text), raw: text };
}

const stored = (env, key) => (env.store.has(key) ? JSON.parse(env.store.get(key)) : null);
const gameOf = (env, who) => stored(env, 'mm_game_' + USERS[who].user_id);

/* Play the stored deck perfectly (the test can see what the client can't).
   Returns every flip response. */
async function playPerfect(env, who, gameId, { extraMisses = 0 } = {}) {
  const deck = gameOf(env, who).deck;
  const byPair = {};
  deck.forEach((p, i) => { (byPair[p] = byPair[p] || []).push(i); });
  let seq = 0;
  const out = [];
  const pairs = Object.values(byPair);
  for (let m = 0; m < extraMisses; m++) {
    const [x] = pairs[m];
    const [y] = pairs[m + 1];
    out.push(await post(env, who, { action: 'flip', gameId, index: x, seq: seq++ }));
    out.push(await post(env, who, { action: 'flip', gameId, index: y, seq: seq++ }));
  }
  for (const [x, y] of pairs) {
    out.push(await post(env, who, { action: 'flip', gameId, index: x, seq: seq++ }));
    out.push(await post(env, who, { action: 'flip', gameId, index: y, seq: seq++ }));
  }
  return out;
}

/* ── Start: auth, shape, no deck ───────────────────────────────────── */
{
  const env = makeEnv();
  const guest = await post(env, null, { action: 'start', set: 'default' });
  check('guest start → 401', guest.status, 401);
  check('guest start writes nothing', env.store.size, 0);

  const s = await post(env, 'a', { action: 'start', set: 'default' });
  check('start → 200', s.status, 200);
  check('start returns only id/pairs/ranked/board', Object.keys(s.body).sort(), ['board', 'gameId', 'pairs', 'ranked']);
  check('default deck is 20 pairs', s.body.pairs, 20);
  check('default deck ranks on the original board', s.body.board, 'memory-match');
  ok('start response carries no deck', !/deck/i.test(s.raw));

  const g = gameOf(env, 'a');
  check('stored under mm_game_<userId>', !!g, true);
  check('stored with a 1h TTL', env.ttls['mm_game_101'], 3600);
  check('stored deck is 40 cards', g.deck.length, 40);
  const counts = {};
  for (const p of g.deck) counts[p] = (counts[p] || 0) + 1;
  check('every pair id appears exactly twice', Object.values(counts).every(c => c === 2) && Object.keys(counts).length === 20, true);
  check('stored fields', ['userId', 'set', 'pairs', 'deck', 'startedAt'].every(k => k in g), true);
  ok('start response does not leak any face', !s.raw.includes(JSON.stringify(g.deck.slice(0, 4)).slice(1, -1)));

  const s2 = await post(env, 'a', { action: 'start', set: 'default' });
  ok('a new start gets a new id', s2.body.gameId !== s.body.gameId);
  ok('and a fresh shuffle', JSON.stringify(gameOf(env, 'a').deck) !== JSON.stringify(g.deck));
  const stale = await post(env, 'a', { action: 'flip', gameId: s.body.gameId, index: 0, seq: 0 });
  check('the replaced game can no longer be flipped', stale.status, 404);

  const gs = await get(env, 'a');
  check('GET → 200', gs.status, 200);
  ok('GET carries no deck', !/deck/i.test(gs.raw));
  check('GET reveals nothing before a flip', gs.body.game.revealed, []);
  check('GET guest → 401', (await get(env, null)).status, 401);

  const fixed = dealDeck(3, () => 0);
  check('dealDeck: pairs twice each', [...fixed].sort(), [0, 0, 1, 1, 2, 2]);
}

/* ── Happy path: perfect game, board written once ───────────────────── */
{
  const env = makeEnv();
  const s = await post(env, 'a', { action: 'start', set: 'default' });
  const flips = await playPerfect(env, 'a', s.body.gameId);
  check('every flip accepted', flips.every(f => f.status === 200), true);
  const first = flips[0].body;
  check('first flip of a pair: face, no verdict', [typeof first.face, 'first' in first, 'match' in first], ['number', false, false]);
  check('first flip does not count a move', first.moves, 0);
  check('second flip counts the move', flips[1].body.moves, 1);
  check('second flip names its partner', flips[1].body.first, flips[0].body.index);
  check('and it matched', flips[1].body.match, true);
  const last = flips[flips.length - 1].body;
  check('last flip finishes', last.done, true);
  check('perfect game = 20 moves', last.moves, 20);
  check('result recorded', [last.recorded, last.improved, last.board, last.best], [true, true, 'memory-match', 20]);
  check('board written once', env.writes.lb_memory_match, 1);
  check('board holds the server-counted run', stored(env, 'lb_memory_match'), [{ id: '101', name: 'Ash', score: 20, updatedAt: stored(env, 'lb_memory_match')[0].updatedAt }]);
  check('monthly awards settled before writing', env.claims, 1);
  check('no other size board touched', [env.writes.lb_memory_match_10, env.writes.lb_memory_match_15], [undefined, undefined]);
  ok('only the finishing flip reported done', flips.slice(0, -1).every(f => !f.body.done));

  const after = await post(env, 'a', { action: 'flip', gameId: s.body.gameId, index: 0, seq: 40 });
  check('flip after finish → 409', after.status, 409);
  const replayLast = await post(env, 'a', { action: 'flip', gameId: s.body.gameId, index: last.index, seq: 39 });
  check('replayed finishing flip → 409', replayLast.status, 409);
  check('board still written once', env.writes.lb_memory_match, 1);

  const gs = await get(env, 'a');
  check('GET after finish shows done', gs.body.game.done, true);
  check('GET reveals the matched cards', gs.body.game.revealed.length, 40);
}

/* ── Moves: mismatches count, best is kept ──────────────────────────── */
{
  const env = makeEnv();
  let s = await post(env, 'a', { action: 'start', set: 'default' });
  let flips = await playPerfect(env, 'a', s.body.gameId, { extraMisses: 3 });
  check('a mismatch is a move with no match', [flips[1].body.match, flips[1].body.moves, flips[1].body.pairsFound], [false, 1, 0]);
  check('3 misses + 20 pairs = 23 moves', flips[flips.length - 1].body.moves, 23);
  check('board has 23', stored(env, 'lb_memory_match')[0].score, 23);

  s = await post(env, 'a', { action: 'start', set: 'default' });
  flips = await playPerfect(env, 'a', s.body.gameId, { extraMisses: 5 });
  const worse = flips[flips.length - 1].body;
  check('worse run: not improved, best reported', [worse.recorded, worse.improved, worse.best], [true, false, 23]);
  check('worse run leaves the board alone', [stored(env, 'lb_memory_match')[0].score, env.writes.lb_memory_match], [23, 1]);

  s = await post(env, 'a', { action: 'start', set: 'default' });
  flips = await playPerfect(env, 'a', s.body.gameId);
  check('better run replaces it', [flips[flips.length - 1].body.improved, stored(env, 'lb_memory_match')[0].score], [true, 20]);
  check('one row per player', stored(env, 'lb_memory_match').length, 1);

  const sb = await post(env, 'b', { action: 'start', set: 'default' });
  await playPerfect(env, 'b', sb.body.gameId, { extraMisses: 1 });
  check('sorted ascending', stored(env, 'lb_memory_match').map(e => [e.id, e.score]), [['101', 20], ['202', 21]]);
}

/* ── Forged and replayed flips ──────────────────────────────────────── */
{
  const env = makeEnv();
  const s = await post(env, 'a', { action: 'start', set: 'default' });
  const id = s.body.gameId;
  const deck = gameOf(env, 'a').deck;
  const snapshot = () => JSON.stringify(gameOf(env, 'a'));
  const before = snapshot();

  for (const index of [-1, 40, 1.5, '3', null]) {
    const r = await post(env, 'a', { action: 'flip', gameId: id, index, seq: 0 });
    check(`index ${JSON.stringify(index)} rejected`, r.status, 400);
  }
  check('missing seq rejected', (await post(env, 'a', { action: 'flip', gameId: id, index: 0 })).status, 400);
  check('seq ahead rejected', (await post(env, 'a', { action: 'flip', gameId: id, index: 0, seq: 5 })).status, 409);
  check('forged game id rejected', (await post(env, 'a', { action: 'flip', gameId: 'nope', index: 0, seq: 0 })).status, 404);
  check("another player can't flip it", (await post(env, 'b', { action: 'flip', gameId: id, index: 0, seq: 0 })).status, 404);
  check('guest flip rejected', (await post(env, null, { action: 'flip', gameId: id, index: 0, seq: 0 })).status, 401);
  check('unknown action rejected', (await post(env, 'a', { action: 'win', gameId: id })).status, 400);
  check('rejections changed nothing', snapshot(), before);

  const f0 = await post(env, 'a', { action: 'flip', gameId: id, index: 0, seq: 0 });
  check('real flip → 200', f0.status, 200);
  check('real flip returns that card', f0.body.face, deck[0]);
  check('replaying it → 409', (await post(env, 'a', { action: 'flip', gameId: id, index: 0, seq: 0 })).status, 409);
  check('same card twice in a pair → 409', (await post(env, 'a', { action: 'flip', gameId: id, index: 0, seq: 1 })).status, 409);
  check('still one flip recorded', gameOf(env, 'a').flips, [0]);

  const partner = deck.findIndex((p, i) => i !== 0 && p === deck[0]);
  const f1 = await post(env, 'a', { action: 'flip', gameId: id, index: partner, seq: 1 });
  check('partner matches', [f1.body.match, f1.body.pairsFound], [true, 1]);
  check('flipping a matched card → 409', (await post(env, 'a', { action: 'flip', gameId: id, index: 0, seq: 2 })).status, 409);
  check('or its partner → 409', (await post(env, 'a', { action: 'flip', gameId: id, index: partner, seq: 2 })).status, 409);

  const other = deck.findIndex((p, i) => i !== 0 && i !== partner);
  const racers = await Promise.all([
    post(env, 'a', { action: 'flip', gameId: id, index: other, seq: 2 }),
    post(env, 'a', { action: 'flip', gameId: id, index: other, seq: 2 }),
  ]);
  check('a double-sent flip lands once', racers.map(r => r.status).sort(), [200, 409]);
  check('flip sequence recorded in order', gameOf(env, 'a').flips, [0, partner, other]);
  check('moves counted per pair of flips', gameOf(env, 'a').moves, 1);
}

/* ── The finishing flip sent twice at once writes once ──────────────── */
{
  const env = makeEnv();
  const s = await post(env, 'a', { action: 'start', set: 'default' });
  const deck = gameOf(env, 'a').deck;
  const byPair = {};
  deck.forEach((p, i) => { (byPair[p] = byPair[p] || []).push(i); });
  const pairs = Object.values(byPair);
  let seq = 0;
  for (const [x, y] of pairs.slice(0, -1)) {
    await post(env, 'a', { action: 'flip', gameId: s.body.gameId, index: x, seq: seq++ });
    await post(env, 'a', { action: 'flip', gameId: s.body.gameId, index: y, seq: seq++ });
  }
  const [x, y] = pairs[pairs.length - 1];
  await post(env, 'a', { action: 'flip', gameId: s.body.gameId, index: x, seq: seq++ });
  const both = await Promise.all([0, 1].map(() => post(env, 'a', { action: 'flip', gameId: s.body.gameId, index: y, seq })));
  check('one finishing flip wins', both.map(r => r.status).sort(), [200, 409]);
  check('board written exactly once', env.writes.lb_memory_match, 1);
}

/* ── Per-size boards and pack ownership ─────────────────────────────── */
{
  const env = makeEnv();
  env.store.set('inv_101', JSON.stringify({ userId: '101', equips: {}, items: [
    { id: 'emote-pack-haunted-emote-pack', game: 'memory-match', type: 'emote-pack', name: 'Haunted Emote Pack' },
    { id: 'emote-pack-premium-emote-pack', game: 'memory-match', type: 'emote-pack', name: 'Premium Emote Pack' },
    { id: 'badge-haunted', game: 'profile', type: 'badge', name: 'Haunted Emote Pack' },
  ] }));

  const unowned = await post(env, 'a', { action: 'start', set: 'spooky' });
  check('unowned pack → 403', unowned.status, 403);
  const wrongType = await post(env, 'b', { action: 'start', set: 'haunted' });
  check("someone else's pack → 403", wrongType.status, 403);

  const h = await post(env, 'a', { action: 'start', set: 'haunted' });
  check('haunted is a 10-pair deck', [h.status, h.body.pairs, h.body.board], [200, 10, 'memory-match-10']);
  const hf = await playPerfect(env, 'a', h.body.gameId);
  check('10-pair perfect game = 10 moves', hf[hf.length - 1].body.moves, 10);
  check('lands on lb_memory_match_10', stored(env, 'lb_memory_match_10').map(e => e.score), [10]);
  check('not on the 20-pair board', env.store.has('lb_memory_match'), false);

  const p = await post(env, 'a', { action: 'start', set: 'premium' });
  check('premium is a 15-pair deck', [p.body.pairs, p.body.board], [15, 'memory-match-15']);
  await playPerfect(env, 'a', p.body.gameId);
  check('lands on lb_memory_match_15', stored(env, 'lb_memory_match_15').map(e => e.score), [15]);

  const d = await post(env, 'a', { action: 'start', set: 'default' });
  await playPerfect(env, 'a', d.body.gameId, { extraMisses: 2 });
  check('default lands on lb_memory_match', stored(env, 'lb_memory_match').map(e => e.score), [22]);
  check('each board kept its own best', [stored(env, 'lb_memory_match_10')[0].score, stored(env, 'lb_memory_match_15')[0].score], [10, 15]);

  check('junk set name falls back to default', (await post(env, 'b', { action: 'start', set: '../../x' })).body.pairs, 20);
  check('board map', Object.fromEntries(Object.entries(BOARD_BY_PAIRS).map(([k, v]) => [k, v.key])),
    { 10: 'lb_memory_match_10', 15: 'lb_memory_match_15', 20: 'lb_memory_match' });
}

/* ── Server and page agree ──────────────────────────────────────────── */
{
  const src = readFileSync(join(here, '../../games/memory-match/index.html'), 'utf8');
  const script = src.slice(src.indexOf('<script>', src.indexOf('<body>')) + 8, src.lastIndexOf('</script>'));
  const catalogSrc = script.slice(0, script.indexOf('let activeCardBack'));
  const start = script.indexOf('function getCosmeticId(');
  let depth = 0, i = script.indexOf('{', start);
  for (; i < script.length; i++) {
    if (script[i] === '{') depth++;
    else if (script[i] === '}' && --depth === 0) break;
  }
  // eslint-disable-next-line no-eval
  const MM = (0, eval)(`(function(){${catalogSrc}\n${script.slice(start, i + 1)}\nreturn { EMOTE_SETS, CARD_BACKS, getCosmeticId };})()`);

  for (const [key, set] of Object.entries(MM.EMOTE_SETS)) {
    check(`set ${key}: server pair count = page's emote count`, SET_PAIRS[key], set.images.length);
  }
  check('server knows no set the page lacks', Object.keys(SET_PAIRS).filter(k => !MM.EMOTE_SETS[k]), []);

  const names = [
    ...Object.values(MM.EMOTE_SETS).map(s => s.name), ...Object.values(MM.CARD_BACKS).map(s => s.name),
    'Emote Pack', 'Phamily Emote Pack', 'Mystery Bundle', '', 'BARROW pack', 'Bat Harvest',
  ];
  for (const n of names) check(`resolver agrees on "${n}"`, setKeyForItemName(n), MM.getCosmeticId({ name: n }, 'emote'));

  ok('page no longer posts to /api/leaderboards', !src.includes('/api/leaderboards'));
  ok('page plays ranked through /api/memory-match', src.includes("'/api/memory-match'"));
  ok('no box-shadow', !/box-shadow/.test(src));
  for (const hex of ['#00cc66', '#3344aa', '#4466ee', '#8833cc', '#aa44ff', '#444;']) {
    ok(`off-palette ${hex} gone`, !src.includes(hex));
  }
  ok('in-game login link breaks out of the iframe', /a\.target = '_top'/.test(script));
}

if (failures.length) {
  console.error(`\n✗ ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`✓ all ${passed} memory match ranked checks passed`);
