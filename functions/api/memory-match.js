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

const GAME_TTL = 3600;
const MAX_ENTRIES = 50;
const MAX_FLIPS = 4000;
const GAME_PREFIX = 'mm_game_';

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
    if (row) {
      if (game.moves >= row.score) {
        best = row.score;
        if (row.name === player.displayName) return undefined;
        row.name = player.displayName;
        return lb;
      }
      row.score = game.moves;
      row.name = player.displayName;
      row.updatedAt = now;
    } else {
      lb.push({ id: player.userId, name: player.displayName, score: game.moves, updatedAt: now });
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

async function handleFlip(env, player, body) {
  const { gameId, index, seq } = body;
  if (typeof gameId !== 'string' || !gameId) return json({ error: 'Missing game.' }, 400);
  if (!Number.isInteger(index)) return json({ error: 'Bad card index.' }, 400);
  if (!Number.isInteger(seq) || seq < 0) return json({ error: 'Bad flip sequence.' }, 400);

  let err = null;
  let out = null;
  let finished = null;
  await env.MARKETPLACE.mutate(GAME_PREFIX + player.userId, (g) => {
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
      finished = { pairs: g.pairs, moves: g.moves };
    }
    return g;
  }, { expirationTtl: GAME_TTL });

  if (err) return json({ error: err[1] }, err[0]);
  if (!finished) return json(out);

  out.done = true;
  try {
    Object.assign(out, await recordResult(env, player, finished));
  } catch (e) {
    console.error('[memory-match] board write failed:', e && e.message);
    Object.assign(out, { recorded: false, best: null, improved: false, board: null });
  }
  return json(out);
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const player = getPlayer(request);
  if (!player) return json({ error: 'Not logged in' }, 401);
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

  if (body.action === 'start') return handleStart(env, player, body);
  if (body.action === 'flip') return handleFlip(env, player, body);
  return json({ error: 'Unknown action' }, 400);
}
