/* ══════════════════════════════════════════════
   MEMORY MATCH — TWITCH PLAYS.

     mod:   POST /api/memory-match-chat { action:'start', pairs }
            POST /api/memory-match-chat { action:'stop' }
     chat:  !flip <card number>
     OBS:   GET  /api/memory-match-chat

   WHY A SEPARATE MODULE. The personal game is keyed to a userId and advanced
   by a strict flip SEQUENCE the client echoes back, because it defends a board
   that carries a monthly prize. A shared board has no owner, no sequence, and
   no prize — bolting it onto that handler would mean loosening the checks that
   exist to stop a solo score being forged.

   THE CLOCK IS LAZY, like the Safari's. Nothing schedules a flip: every read
   works out what should have happened by now and persists it if it is due.
   There is no job to miss and no timer to lose when the process restarts.

   A MOVE IS TWO WINDOWS. Chat votes a card, it flips; chat votes again, the
   second flips and the pair resolves. A non-match stays face up for a beat
   before turning back, because a memory game chat cannot SEE is not a memory
   game — that pause is the entire mechanic.

   IT NEVER TOUCHES THE REAL LEADERBOARD. Memory Match's boards carry a monthly
   prize and are server-only for that reason. Chat's result is kept apart, as
   its own best-moves record, rather than injected as a player.
   ══════════════════════════════════════════════ */

import { dealDeck, BOARD_BY_PAIRS } from './memory-match.js';

const KEY = 'mm_chat';
const BEST_KEY = 'mm_chat_best';

/* Long enough to read the board and type, short enough that a 20-pair game
   does not outlast the stream. */
const VOTE_MS = 8000;
/* The beat a non-match stays face up. The mechanic lives here. */
const REVEAL_MS = 2500;
const DONE_LINGER_MS = 30000;
const TTL = 7200;

const MAX_VOTERS = 2000;
const ALLOWED_PAIRS = [10, 15, 20];
/* The maze pays the chatter who made the winning move; this follows it. */
const WIN_ENTRIES = 1;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function getSession(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)pham_session=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match[1])); } catch { return null; }
}

async function read(env) {
  try { return await env.MARKETPLACE.get(KEY, 'json'); } catch { return null; }
}

/** A card chat may still vote for: on the board, not matched, not face up. */
export function selectable(g, i) {
  return Number.isInteger(i) && i >= 0 && i < g.deck.length && !g.matched[i] && g.open !== i;
}

/** Most-voted first, ties to whoever got there first. */
export function voteTally(g) {
  const byIdx = new Map();
  for (const [userId, v] of Object.entries(g.votes || {})) {
    const cur = byIdx.get(v.index);
    if (!cur) byIdx.set(v.index, { index: v.index, votes: 1, firstBy: userId, firstName: v.display, at: v.at });
    else { cur.votes++; if (v.at < cur.at) { cur.at = v.at; cur.firstBy = userId; cur.firstName = v.display; } }
  }
  return [...byIdx.values()].sort((a, b) => (b.votes - a.votes) || (a.at - b.at));
}

/**
 * Work the board forward to `now`. Pure on the record: mutates and reports
 * whether anything changed, so a read can persist only when it must.
 *
 * Returns { changed, finished } — `finished` carries who to pay, decided here
 * so the caller can do the slow part outside the lock.
 */
export function advance(g, now = Date.now()) {
  let changed = false;
  let finished = null;
  if (!g || g.status !== 'live') return { changed, finished };

  /* A non-match has had its beat: turn them back over. */
  if (g.phase === 'reveal' && now >= g.revealUntil) {
    if (g.lastPair && !g.lastPair.match) g.open = null;
    g.lastPair = null;
    g.phase = 'vote';
    g.voteUntil = now + VOTE_MS;
    g.votes = {};
    return { changed: true, finished: null };
  }
  if (g.phase !== 'vote' || now < g.voteUntil) return { changed, finished };

  /* The window closed. Whatever chat backed hardest, flips. */
  const top = voteTally(g).find(t => selectable(g, t.index));
  if (!top) {
    /* Nobody voted, or everything voted for became unavailable. Run it back
       rather than stalling — a silent board that never moves looks broken. */
    g.voteUntil = now + VOTE_MS;
    g.votes = {};
    g.idleRounds = (g.idleRounds || 0) + 1;
    return { changed: true, finished: null };
  }
  g.idleRounds = 0;

  const i = top.index;
  if (g.open === null) {
    /* First of the move. */
    g.open = i;
    g.phase = 'vote';
    g.voteUntil = now + VOTE_MS;
    g.votes = {};
    g.lastPair = null;
    return { changed: true, finished: null };
  }

  /* Second of the move: resolve it. */
  const a = g.open;
  const match = g.deck[a] === g.deck[i];
  g.moves += 1;
  if (match) {
    g.matched[a] = 1;
    g.matched[i] = 1;
    g.pairsFound += 1;
    g.open = null;
  } else {
    /* Both stay visible through the reveal; `open` keeps the first and
       lastPair carries the second so the panel can show them together. */
    g.open = a;
  }
  g.lastPair = { a, b: i, match, by: top.firstName, byId: top.firstBy };
  g.phase = 'reveal';
  g.revealUntil = now + REVEAL_MS;
  changed = true;

  if (g.pairsFound === g.pairs) {
    g.status = 'done';
    g.finishedAt = now;
    g.phase = 'done';
    g.open = null;
    finished = { moves: g.moves, pairs: g.pairs, byId: top.firstBy, byName: top.firstName };
  }
  return { changed, finished };
}

/**
 * Advance the board AND settle anything that finished.
 *
 * Every entry point goes through this. The board can complete on the advance
 * a VOTE triggers just as easily as on the one a read triggers — an earlier
 * version only settled from the read, so a game whose last pair landed while
 * chat was still typing recorded nothing and paid nobody.
 */
export async function tick(env) {
  const { game, finished } = await advanceStored(env);
  if (!finished) return game;
  await recordFinish(env, finished);
  return await read(env);
}

/** Persist the worked-forward board, and hand back what finished. */
async function advanceStored(env) {
  let finished = null;
  let after = null;
  await env.MARKETPLACE.mutate(KEY, (g) => {
    if (!g) return undefined;
    const r = advance(g, Date.now());
    after = g;
    finished = r.finished;
    return r.changed ? g : undefined;
  }, { expirationTtl: TTL });
  return { game: after, finished };
}

/* ── Chat ────────────────────────────────────────────────────────────────── */

/**
 * One chatter's pick. A later vote replaces an earlier one — the board is on
 * screen and nothing is hidden, so swinging behind a card is the game.
 */
export async function flipFromChat(env, { userId, name, text }) {
  if (!userId) return { ok: false, reason: 'empty' };

  /* Work the clock forward first, or a vote lands in a window that has
     already closed — and settle anything that finished on the way, since a
     board can complete on this advance as readily as on a read's. */
  await tick(env);

  const n = Number(String(text || '').trim());
  if (!Number.isInteger(n)) return { ok: false, reason: 'no-match' };
  const index = n - 1;          // 1-based for chat; nobody types "card 0"

  const id = String(userId);
  let outcome = { ok: false, reason: 'closed' };
  await env.MARKETPLACE.mutate(KEY, (g) => {
    if (!g || g.status !== 'live' || g.phase !== 'vote') return undefined;
    if (!selectable(g, index)) { outcome = { ok: false, reason: 'no-match' }; return undefined; }
    const had = !!g.votes[id];
    if (!had && Object.keys(g.votes).length >= MAX_VOTERS) { outcome = { ok: false, reason: 'full' }; return undefined; }
    if (had && g.votes[id].index === index) { outcome = { ok: false, reason: 'same' }; return undefined; }
    g.votes[id] = { index, display: String(name || 'Someone').slice(0, 30), at: had ? g.votes[id].at : Date.now() };
    outcome = { ok: true, index, changed: had };
    return g;
  }, { expirationTtl: TTL });

  return outcome;
}

/* ── Mod actions ─────────────────────────────────────────────────────────── */

export async function startGame(env, pairs) {
  const p = ALLOWED_PAIRS.includes(Number(pairs)) ? Number(pairs) : 10;
  const now = Date.now();
  await env.MARKETPLACE.put(KEY, JSON.stringify({
    status: 'live',
    pairs: p,
    deck: dealDeck(p),
    matched: new Array(p * 2).fill(0),
    open: null,
    lastPair: null,
    moves: 0,
    pairsFound: 0,
    phase: 'vote',
    voteUntil: now + VOTE_MS,
    revealUntil: 0,
    votes: {},
    idleRounds: 0,
    startedAt: now,
  }), { expirationTtl: TTL });
  return { ok: true, pairs: p };
}

export async function stopGame(env) {
  try { await env.MARKETPLACE.delete(KEY); } catch { /* best effort */ }
  return { ok: true };
}

export async function readBest(env) {
  try {
    const b = await env.MARKETPLACE.get(BEST_KEY, 'json');
    if (b) return b;
  } catch { /* fall through */ }
  return {};
}

/**
 * Record chat's result and pay the winning voter.
 *
 * Deliberately NOT the real Memory Match board: those carry a monthly prize
 * and are server-only for that reason, and a collective score is not
 * comparable to a solo one. Chat keeps its own best, per board size.
 */
async function recordFinish(env, finished) {
  let improved = false;
  await env.MARKETPLACE.mutate(BEST_KEY, (cur) => {
    const b = cur || {};
    const key = String(finished.pairs);
    if (!b[key] || finished.moves < b[key].moves) {
      b[key] = { moves: finished.moves, at: Date.now() };
      improved = true;
      return b;
    }
    return undefined;
  });

  /* The chatter whose vote landed the last pair, following the Chat Maze's
     rule for a collective clear. Entries only for an account that exists —
     crediting a Twitch id that never signed in would seed the monthly draw
     with an entrant it cannot pay. */
  let paid = false;
  if (finished.byId) {
    try {
      const profile = await env.MARKETPLACE.get(`profile_${finished.byId}`, 'json');
      if (profile) {
        const { addEntries } = await import('./giveaway-entries.js');
        await addEntries(env, String(finished.byId), finished.byName, WIN_ENTRIES, 'memory-match-chat');
        paid = true;
      }
    } catch (err) {
      console.error('[memory-match-chat] could not credit the winner:', err.message);
    }
  }

  await env.MARKETPLACE.mutate(KEY, (g) => {
    if (!g) return undefined;
    g.result = { moves: finished.moves, by: finished.byName, paid, improved };
    return g;
  }, { expirationTtl: TTL });

  return { improved, paid };
}

/* ── Routes ──────────────────────────────────────────────────────────────── */

export async function onRequestGet(context) {
  const { env } = context;
  const g = await tick(env);
  if (!g) return json({ status: 'none' });

  const now = Date.now();
  if (g.status === 'done' && now - (g.finishedAt || 0) > DONE_LINGER_MS) return json({ status: 'none' });

  const best = await readBest(env);
  const pair = g.lastPair;
  /* FACES ARE NOT SENT FOR FACE-DOWN CARDS. The overlay is a public URL; the
     whole board in the payload would let anyone read the answers off it. */
  const cards = g.deck.map((face, i) => {
    const visible = !!g.matched[i] || g.open === i || (pair && (pair.a === i || pair.b === i));
    return { n: i + 1, face: visible ? face : null, matched: !!g.matched[i], up: visible && !g.matched[i] };
  });

  const tally = g.phase === 'vote' ? voteTally(g).filter(t => selectable(g, t.index)).slice(0, 3) : [];
  return json({
    status: g.status === 'done' ? 'done' : 'live',
    pairs: g.pairs,
    cols: (BOARD_BY_PAIRS[g.pairs] && BOARD_BY_PAIRS[g.pairs].game) || null,
    moves: g.moves,
    pairsFound: g.pairsFound,
    phase: g.phase,
    secondsLeft: g.phase === 'vote' ? Math.max(0, Math.round((g.voteUntil - now) / 1000)) : 0,
    cards,
    lastMatch: pair ? !!pair.match : null,
    voters: Object.keys(g.votes || {}).length,
    leading: tally.length ? tally[0].index : null,
    tally: tally.map(t => ({ n: t.index + 1, votes: t.votes })),
    best: best[String(g.pairs)] ? best[String(g.pairs)].moves : null,
    result: g.result || null,
  });
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);

  const { isModerator } = await import('./admin/moderators.js');
  if (!(await isModerator(env, session))) {
    return json({ error: 'Only the broadcaster and moderators can run a chat game.' }, 403);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }
  const action = String(body.action || '');

  if (action === 'start') {
    const r = await startGame(env, body.pairs);
    return json({ success: true, pairs: r.pairs });
  }
  if (action === 'stop') { await stopGame(env); return json({ success: true }); }
  return json({ error: 'Unknown action' }, 400);
}
