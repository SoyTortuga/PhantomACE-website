/* ══════════════════════════════════════════════
   MEMORY MATCH — server-dealt ranked games

   The board pays monthly prizes, so the server deals and the server counts.
   The client never holds the deck order: `start` returns only a game id and
   a pair count, and each `flip` reveals exactly one card's face. The move
   count on the board is the one this file counted, written by this file when
   it saw the last pair matched. There is no client score POST to forge.

   A move is a PAIR of flips (the second flip of a pair is what counts),
   exactly the rule the game has always used.

   ONE GAME PER PLAYER. The game lives at mm_game_<userId>; starting a new one
   replaces it, so the family is bounded by player count and an abandoned run
   simply expires. Every flip goes through mutate() so two racing requests
   (a double click, a replayed request) are serialised and the second one is
   rejected by its stale `seq`.

   ONE BOARD PER DECK SIZE. The default deck is 20 pairs; the emote packs are
   10 or 15. A smaller deck is an easier game, so each size ranks only against
   itself: lb_memory_match (20, the original board), lb_memory_match_15 and
   lb_memory_match_10.
   ══════════════════════════════════════════════ */

import { SEASON_TZ, weekKey } from './season-time.js';

const GAME_TTL = 3600;
const MAX_ENTRIES = 50;
const MAX_FLIPS = 4000;
const GAME_PREFIX = 'mm_game_';

/* ── Daily seed mode ──────────────────────────────────────────────────
   One fixed board per Pacific calendar day: every player is dealt the SAME
   shuffle, derived deterministically from the date, so the daily is a single
   shared puzzle AND the deal is server-authoritative (the client can neither
   pick an easier layout nor retry it). Always the 20-pair default set, so
   nobody's cosmetic pack makes the daily shorter. One completion per player
   per day is recorded; a started board resumes rather than re-deals, so the
   move count can't be reset by refreshing.

   DAILY_GAME_PREFIX and DAILY_BOARD_PREFIX both begin 'mm_daily_', so a single
   registry family (mm_daily_ -> singletons, 'real') maps the in-progress game
   (mm_daily_game_<userId>) and the per-day board (mm_daily_<dayKey>). */
const DAILY_PAIRS = 20;
const DAILY_GAME_PREFIX = 'mm_daily_game_';
const DAILY_BOARD_PREFIX = 'mm_daily_';
const DAILY_TTL = 60 * 60 * 24 * 3;   // a day's board lingers a couple days, then clears
const MAX_DAILY_ENTRIES = 500;

/* Pair counts per card set, matching EMOTE_SETS in games/memory-match. A set
   key the game draws with the default images (any pack name that resolves
   outside this table) is the full 20-pair deck. Kept in step by
   server/scripts/test-memory-match.js, which reads the game's own catalog. */
export const SET_PAIRS = Object.freeze({
  default: 20,
  bonus: 10,
  premium: 15,
  spooky: 10,
  haunted: 10,
  barrow: 10,
  harvest: 10,
});

export const BOARD_BY_PAIRS = Object.freeze({
  20: { key: 'lb_memory_match',    game: 'memory-match' },
  15: { key: 'lb_memory_match_15', game: 'memory-match-15' },
  10: { key: 'lb_memory_match_10', game: 'memory-match-10' },
});

/* The game's getCosmeticId(item, 'emote'), verbatim in order: an owned pack is
   recognised by its name, the same way the page decides what to draw. */
export function setKeyForItemName(name) {
  const n = String(name || '').toLowerCase();
  if (n.includes('legendary')) return 'legendary';
  if (n.includes('phamily')) return 'phamily';
  if (n.includes('rare')) return 'rare';
  if (n.includes('premium')) return 'premium';
  if (n.includes('cobweb')) return 'cobweb';
  if (n.includes('crypt')) return 'crypt';
  if (n.includes('bat')) return 'bat';
  if (n.includes('ghost')) return 'ghost';
  if (n.includes('spooky')) return 'spooky';
  if (n.includes('haunt')) return 'haunted';
  if (n.includes('wheat')) return 'wheat';
  if (n.includes('crow')) return 'crow';
  if (n.includes('sickle')) return 'sickle';
  if (n.includes('moon')) return 'moon';
  if (n.includes('barrow')) return 'barrow';
  if (n.includes('harvest')) return 'harvest';
  return 'bonus';
}

export function pairsForSet(set) {
  return SET_PAIRS[set] || SET_PAIRS.default;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function getSession(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)pham_session=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match[1])); } catch { return null; }
}

function getPlayer(request) {
  const session = getSession(request);
  if (!session || !session.user_id) return null;
  return { userId: String(session.user_id), displayName: String(session.display_name || 'Player').slice(0, 40) };
}

/* Unbiased integer in [0, n) from the platform CSPRNG. */
function secureInt(n) {
  const limit = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % n;
  }
}

export function dealDeck(pairs, randInt = secureInt) {
  const deck = [];
  for (let p = 0; p < pairs; p++) deck.push(p, p);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

/* 'YYYY-MM-DD' for the instant in the stream timezone (same calendar every
   monthly cycle rolls on). en-CA formats as YYYY-MM-DD, so a day rolls at
   Pacific midnight, not UTC. season-time exports no dayKey, so derive it here
   from the one SEASON_TZ it does export. */
export function dayKey(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: SEASON_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

/* A deterministic unbiased integer generator seeded from a string: xmur3 to a
   32-bit seed, mulberry32 for the stream, rejection sampling for an unbiased
   [0, n). Same seed string -> same sequence -> same deck, on any machine. */
function seededRandInt(seedStr) {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) {
    h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = (h ^= h >>> 16) >>> 0;
  const next = () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
  return (n) => {
    const limit = Math.floor(0x100000000 / n) * n;
    for (;;) { const x = next(); if (x < limit) return x % n; }
  };
}

export function dailySeedString(dk, pairs = DAILY_PAIRS) {
  return `memory-match-daily:${dk}:${pairs}`;
}

/* The one deck for a given day — dealt through the same shuffle as a ranked
   game, only with a seeded RNG instead of the CSPRNG. */
export function seededDeck(pairs, dk) {
  return dealDeck(pairs, seededRandInt(dailySeedString(dk, pairs)));
}

/* Today's board, trimmed to a public top-N: names and scores only (no user
   ids leak), with the asking player's own row flagged. */
function dailyTop(results, youId, n = 10) {
  return results.slice(0, n).map((r, i) => ({
    rank: i + 1, name: r.name, score: r.score, you: String(r.id) === String(youId),
  }));
}

async function ownsSet(env, userId, set) {
  const inv = await env.MARKETPLACE.get('inv_' + userId, 'json');
  const items = inv && Array.isArray(inv.items) ? inv.items : [];
  return items.some(i => i && i.game === 'memory-match' && i.type === 'emote-pack' && setKeyForItemName(i.name) === set);
}

/* What a player may see of their own game: matched cards and the one card
   currently face up. Never the face-down deck. */
function publicGame(g) {
  const revealed = [];
  for (let i = 0; i < g.deck.length; i++) {
    if (g.matched[i] || g.open === i) revealed.push({ index: i, face: g.deck[i], matched: !!g.matched[i] });
  }
  return {
    gameId: g.gameId, set: g.set, pairs: g.pairs, moves: g.moves, pairsFound: g.pairsFound,
    seq: g.flips.length, open: g.open, revealed, done: !!g.done,
    board: BOARD_BY_PAIRS[g.pairs] ? BOARD_BY_PAIRS[g.pairs].game : null,
  };
}

async function recordResult(env, player, game) {
  const board = BOARD_BY_PAIRS[game.pairs];
  if (!board) return { recorded: false, best: null, improved: false, board: null };

  /* Settle last month first, so a run finished after midnight on the 1st
     lands on the new month's board rather than the one being paid out. */
  try {
    const { maybeRunMonthlyAwards } = await import('./leaderboards.js');
    await maybeRunMonthlyAwards(env);
  } catch (err) {
    console.error('[memory-match] monthly award settle failed:', err && err.message);
  }

  let best = game.moves;
  let improved = false;
  await env.MARKETPLACE.mutate(board.key, (current) => {
    const lb = Array.isArray(current) ? current : [];
    const row = lb.find(e => e && String(e.id) === player.userId);
    const now = Date.now();
    const wk = weekKey(new Date(now));

    /* THIS WEEK'S BEST, stamped on every run rather than only on a record.
       `updatedAt` moves only when the score improves — the early return
       below is exactly that — so a weekly quest reading it was
       unachievable for anyone already at their target. Reset when the week
       turns over so last week's run cannot satisfy this week's quest. */
    const stampWeek = (r) => {
      if (!r.weekBest || r.weekBest.wk !== wk) r.weekBest = { wk, moves: game.moves };
      else if (game.moves < r.weekBest.moves) r.weekBest.moves = game.moves;
    };

    if (row) {
      if (game.moves >= row.score) {
        best = row.score;
        stampWeek(row);
        /* The week stamp changed even when the score did not, so this can
           no longer return undefined on a name match — that would discard
           the stamp and put the quest right back where it was. */
        row.name = player.displayName;
        return lb;
      }
      row.score = game.moves;
      row.name = player.displayName;
      row.updatedAt = now;
      stampWeek(row);
    } else {
      const fresh = { id: player.userId, name: player.displayName, score: game.moves, updatedAt: now };
      stampWeek(fresh);
      lb.push(fresh);
    }
    improved = true;
    lb.sort((a, b) => (a.score - b.score) || ((a.updatedAt || 0) - (b.updatedAt || 0)));
    return lb.slice(0, MAX_ENTRIES);
  });
  return { recorded: true, best, improved, board: board.game };
}

async function handleStart(env, player, body) {
  const set = typeof body.set === 'string' && /^[a-z]{1,32}$/.test(body.set) ? body.set : 'default';
  if (set !== 'default' && !(await ownsSet(env, player.userId, set))) {
    return json({ error: "You don't own that card set." }, 403);
  }
  const pairs = pairsForSet(set);
  const game = {
    gameId: crypto.randomUUID(),
    userId: player.userId,
    set,
    pairs,
    deck: dealDeck(pairs),
    matched: new Array(pairs * 2).fill(0),
    open: null,
    flips: [],
    moves: 0,
    pairsFound: 0,
    done: false,
    startedAt: Date.now(),
  };
  await env.MARKETPLACE.mutate(GAME_PREFIX + player.userId, () => game, { expirationTtl: GAME_TTL });
  return json({
    gameId: game.gameId,
    pairs,
    ranked: !!BOARD_BY_PAIRS[pairs],
    board: BOARD_BY_PAIRS[pairs] ? BOARD_BY_PAIRS[pairs].game : null,
  });
}

/* The shared flip engine for both ranked and daily games: identical move
   validation and server-held solution, differing only in which game key it
   mutates and which recorder settles the finished run. The daily path passes
   the same object shape, so anti-cheat (server deals, server reveals one face,
   stale/forged/out-of-order flips rejected) carries over unchanged. */
async function doFlip(env, player, body, gameKey, finisher) {
  const { gameId, index, seq } = body;
  if (typeof gameId !== 'string' || !gameId) return json({ error: 'Missing game.' }, 400);
  if (!Number.isInteger(index)) return json({ error: 'Bad card index.' }, 400);
  if (!Number.isInteger(seq) || seq < 0) return json({ error: 'Bad flip sequence.' }, 400);

  let err = null;
  let out = null;
  let finished = null;
  await env.MARKETPLACE.mutate(gameKey, (g) => {
    if (!g || g.gameId !== gameId || g.userId !== player.userId) {
      err = [404, 'That game is gone. Deal a new one.'];
      return undefined;
    }
    if (g.done) { err = [409, 'That game is already finished.']; return undefined; }
    if (index < 0 || index >= g.deck.length) { err = [400, 'No card there.']; return undefined; }
    if (seq !== g.flips.length) { err = [409, 'Flip out of order.']; return undefined; }
    if (g.matched[index]) { err = [409, 'That card is already matched.']; return undefined; }
    if (g.open === index) { err = [409, 'That card is already face up.']; return undefined; }
    if (g.flips.length >= MAX_FLIPS) { err = [409, 'That game ran too long. Deal a new one.']; return undefined; }

    g.flips.push(index);
    const face = g.deck[index];
    if (g.open === null) {
      g.open = index;
      out = { index, face, moves: g.moves, pairsFound: g.pairsFound, seq: g.flips.length };
      return g;
    }
    const first = g.open;
    g.open = null;
    g.moves += 1;
    const match = g.deck[first] === face;
    if (match) {
      g.matched[first] = 1;
      g.matched[index] = 1;
      g.pairsFound += 1;
    }
    out = { index, face, first, match, moves: g.moves, pairsFound: g.pairsFound, seq: g.flips.length };
    if (g.pairsFound === g.pairs) {
      g.done = true;
      g.finishedAt = Date.now();
      finished = { pairs: g.pairs, moves: g.moves, dayKey: g.dayKey };
    }
    return g;
  }, { expirationTtl: GAME_TTL });

  if (err) return json({ error: err[1] }, err[0]);
  if (!finished) return json(out);

  out.done = true;
  try {
    Object.assign(out, await finisher(env, player, finished));
  } catch (e) {
    console.error('[memory-match] result write failed:', e && e.message);
    Object.assign(out, { recorded: false, best: null, improved: false, board: null });
  }
  return json(out);
}

function handleFlip(env, player, body) {
  return doFlip(env, player, body, GAME_PREFIX + player.userId, recordResult);
}

function handleDailyFlip(env, player, body) {
  return doFlip(env, player, body, DAILY_GAME_PREFIX + player.userId, recordDailyResult);
}

/* Record a finished daily run on the day's board. One entry per player, so a
   second completion is a no-op (idempotent) — but the start gate already
   refuses a replay once a player is on the board, so this is defence in depth.
   The board is this day's ranking, fewest moves first; it is never written to
   the monthly ranked boards. */
async function recordDailyResult(env, player, finished) {
  const dk = finished.dayKey || dayKey();
  const key = DAILY_BOARD_PREFIX + dk;
  let already = false;
  let best = finished.moves;
  let rank = null;
  let total = 0;
  await env.MARKETPLACE.mutate(key, (current) => {
    const board = (current && Array.isArray(current.results))
      ? current : { dayKey: dk, pairs: finished.pairs, results: [] };
    const sort = (arr) => arr.sort((a, b) => (a.score - b.score) || ((a.finishedAt || 0) - (b.finishedAt || 0)));
    const existing = board.results.find(r => String(r.id) === player.userId);
    if (existing) {
      already = true;
      best = existing.score;
      sort(board.results);
      rank = board.results.findIndex(r => String(r.id) === player.userId) + 1;
      total = board.results.length;
      return undefined;
    }
    board.results.push({ id: player.userId, name: player.displayName, score: finished.moves, finishedAt: Date.now() });
    sort(board.results);
    if (board.results.length > MAX_DAILY_ENTRIES) board.results = board.results.slice(0, MAX_DAILY_ENTRIES);
    rank = board.results.findIndex(r => String(r.id) === player.userId) + 1;
    total = board.results.length;
    return board;
  }, { expirationTtl: DAILY_TTL });

  const stored = await env.MARKETPLACE.get(key, 'json');
  const results = (stored && Array.isArray(stored.results)) ? stored.results : [];
  return {
    recorded: !already, already, best, rank, total,
    dayKey: dk, board: 'memory-match-daily', top: dailyTop(results, player.userId),
  };
}

async function handleDailyStart(env, player) {
  const dk = dayKey();
  const board = await env.MARKETPLACE.get(DAILY_BOARD_PREFIX + dk, 'json');
  const results = (board && Array.isArray(board.results)) ? board.results : [];
  const idx = results.findIndex(r => String(r.id) === player.userId);
  if (idx >= 0) {
    return json({
      daily: true, dailyDone: true, dayKey: dk, pairs: DAILY_PAIRS,
      best: results[idx].score, rank: idx + 1, total: results.length,
      top: dailyTop(results, player.userId),
    });
  }

  /* A board already started today resumes rather than re-deals, so the move
     count can't be reset by refreshing a half-played daily. */
  const existing = await env.MARKETPLACE.get(DAILY_GAME_PREFIX + player.userId, 'json');
  if (existing && existing.dayKey === dk && !existing.done) {
    return json({
      daily: true, dayKey: dk, pairs: existing.pairs, board: 'memory-match-daily',
      gameId: existing.gameId, resumed: true, game: publicGame(existing),
      total: results.length, top: dailyTop(results, player.userId),
    });
  }

  const pairs = DAILY_PAIRS;
  const game = {
    gameId: crypto.randomUUID(),
    userId: player.userId,
    set: 'default',
    pairs,
    daily: true,
    dayKey: dk,
    deck: seededDeck(pairs, dk),
    matched: new Array(pairs * 2).fill(0),
    open: null,
    flips: [],
    moves: 0,
    pairsFound: 0,
    done: false,
    startedAt: Date.now(),
  };
  await env.MARKETPLACE.mutate(DAILY_GAME_PREFIX + player.userId, () => game, { expirationTtl: GAME_TTL });
  return json({
    daily: true, dayKey: dk, pairs, board: 'memory-match-daily', gameId: game.gameId, resumed: false,
    total: results.length, top: dailyTop(results, player.userId),
  });
}

async function dailyGet(env, player) {
  const dk = dayKey();
  const board = await env.MARKETPLACE.get(DAILY_BOARD_PREFIX + dk, 'json');
  const results = (board && Array.isArray(board.results)) ? board.results : [];
  const idx = results.findIndex(r => String(r.id) === player.userId);
  const g = await env.MARKETPLACE.get(DAILY_GAME_PREFIX + player.userId, 'json');
  const game = (g && g.dayKey === dk && !g.done) ? publicGame(g) : null;
  return json({
    mode: 'daily', dayKey: dk, pairs: DAILY_PAIRS,
    done: idx >= 0,
    best: idx >= 0 ? results[idx].score : null,
    rank: idx >= 0 ? idx + 1 : null,
    total: results.length,
    top: dailyTop(results, player.userId),
    game,
  });
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const player = getPlayer(request);
  if (!player) return json({ error: 'Not logged in' }, 401);
  const url = new URL(request.url);
  if (url.searchParams.get('mode') === 'daily') return dailyGet(env, player);
  const g = await env.MARKETPLACE.get(GAME_PREFIX + player.userId, 'json');
  if (!g) return json({ game: null });
  return json({ game: publicGame(g) });
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const player = getPlayer(request);
  if (!player) return json({ error: 'Log in to play ranked.' }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }
  if (!body || typeof body !== 'object') return json({ error: 'Invalid request' }, 400);

  const daily = body.mode === 'daily' || body.daily === true;
  if (body.action === 'start') return daily ? handleDailyStart(env, player) : handleStart(env, player, body);
  if (body.action === 'flip') return daily ? handleDailyFlip(env, player, body) : handleFlip(env, player, body);
  return json({ error: 'Unknown action' }, 400);
}
