/* ══════════════════════════════════════════════
   COMMANDER BINGO END — closes the room and settles the Bingos board.

   lb_bingo ('Bingos') pays monthly prizes, so it is written HERE, from the
   room's own record — the called squares, each player's server-dealt cards
   and server-recorded wildcard stamps — never from a player's browser. The
   old client POST let one hand-made request take first place.

   Two guards on the board write:
     - Only on the active-to-ended transition. A repeated end (a host
       retrying after a dropped response) returns the same results and
       writes nothing twice.
     - Only rooms hosted by the broadcaster or a moderator. Anyone may host
       a card for their pod, and those rooms play exactly as before — but a
       viewer who opens a room, joins it, and calls every square would
       otherwise mint a blackout onto a prize board. Same line award.js
       draws: identity alone hosts, staff alone pays.
   ══════════════════════════════════════════════ */

import { releaseOnEnd } from './overlay.js';

const GAME_TTL = 14400;
const LB_KEY = 'lb_bingo';
const LB_MAX = 50;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function getSession(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)pham_session=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match[1])); } catch { return null; }
}

const LINES = [
  [0, 1, 2, 3, 4], [5, 6, 7, 8, 9], [10, 11, 12, 13, 14], [15, 16, 17, 18, 19], [20, 21, 22, 23, 24],
  [0, 5, 10, 15, 20], [1, 6, 11, 16, 21], [2, 7, 12, 17, 22], [3, 8, 13, 18, 23], [4, 9, 14, 19, 24],
  [0, 6, 12, 18, 24], [4, 8, 12, 16, 20],
  [0, 4, 20, 24],
];

/** Patterns on one card — the same set the player page counts: 5 rows,
    5 columns, 2 diagonals, four corners, and blackout. */
export function cardScore(ids, called, wildIds) {
  const m = ids.map(id => id === 0 || called.has(id) || wildIds.has(id));
  let bingos = 0;
  for (const line of LINES) if (line.every(i => m[i])) bingos++;
  if (m.every(Boolean)) bingos++;
  return { bingos, marked: m.filter(Boolean).length };
}

/**
 * Every player's result, worth their BEST card (two cards are two chances at
 * one score, not two scores). Counts only — no cards leave the server here.
 */
export function standings(game) {
  const called = new Set(Array.isArray(game.calledEvents) ? game.calledEvents : []);
  const rows = [];
  for (const p of (Array.isArray(game.players) ? game.players : [])) {
    if (!p || !p.id) continue;
    const cards = (Array.isArray(p.cards) && p.cards.length) ? p.cards : [p.cardIds];
    const wilds = Array.isArray(p.wildcards) ? p.wildcards : [];
    let best = { bingos: 0, marked: 0 };
    let seen = false;
    cards.forEach((ids, ci) => {
      if (!Array.isArray(ids) || ids.length !== 25) return;
      const wildIds = new Set(wilds.filter(w => w.cardIndex === ci).map(w => w.eventId));
      const s = cardScore(ids, called, wildIds);
      if (!seen || s.bingos > best.bingos || (s.bingos === best.bingos && s.marked > best.marked)) best = s;
      seen = true;
    });
    rows.push({
      id: p.id, name: p.name, bingos: best.bingos, marked: best.marked,
      cardCount: cards.length, wildcardsUsed: wilds.length,
    });
  }
  rows.sort((a, b) => b.bingos - a.bingos || b.marked - a.marked);
  return rows;
}

/** What the host's results screen needs to mark a row as already paid. */
export function paidPrizes(game) {
  return (Array.isArray(game.prizes) ? game.prizes : [])
    .map(p => ({ playerId: p.playerId, name: p.name, rarity: p.rarity, entries: p.entries }));
}

/** Fold a finished room's bingos into lb_bingo, best score kept per account. */
export async function writeBoard(env, board) {
  const scored = board.filter(r => r.bingos > 0 && String(r.id).startsWith('u_'));
  if (!scored.length) return 0;
  await env.MARKETPLACE.mutate(LB_KEY, (lb) => {
    const list = Array.isArray(lb) ? lb : [];
    for (const r of scored) {
      const id = String(r.id).slice(2);
      const row = list.find(e => String(e.id) === id);
      if (row) {
        if (r.bingos > row.score) { row.score = r.bingos; row.updatedAt = Date.now(); }
        row.name = r.name;
      } else {
        list.push({ id, name: r.name, score: r.bingos, updatedAt: Date.now() });
      }
    }
    list.sort((a, b) => b.score - a.score);
    return list.slice(0, LB_MAX);
  });
  return scored.length;
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);
  if (!session || !session.user_id) return json({ error: 'Your login has expired. Log in again to end the game.' }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  const code = (body.code || '').toUpperCase().trim();
  if (!code) return json({ error: 'Missing code' }, 400);

  let failure = null;
  let final = null;
  let justEnded = false;

  await env.MARKETPLACE.mutate(`bingo_${code}`, (game) => {
    if (!game) { failure = json({ error: 'Game not found — the room may have expired.' }, 404); return undefined; }

    /* Unauthenticated before this, so any player could end the host's game
       mid-stream. */
    if (String(session.user_id) !== String(game.host)) {
      failure = json({ error: 'Only the host can end the game.' }, 403);
      return undefined;
    }

    final = game;
    if (game.status === 'ended') return undefined;
    game.status = 'ended';
    game.endedAt = Date.now();
    justEnded = true;
    return game;
  }, { expirationTtl: GAME_TTL });

  if (failure) return failure;

  /* Take the overlay pointer down with the game, but ONLY if it still names
     this room — a newer game may have claimed it, and clearing it blind
     would blank that live game's overlay. The pointer remembers the room it
     ended on, so the prizes awarded from the results screen still alert. */
  try {
    await releaseOnEnd(env, code);
  } catch (err) {
    console.error('[bingo/end] could not clear bingo_current:', err.message);
  }

  const board = standings(final);
  let boardWritten = false;

  if (justEnded) {
    const { isModerator } = await import('../admin/moderators.js');
    if (await isModerator(env, session)) {
      /* Settle last month first, so a game finished after midnight on the 1st
         lands on the new month's board rather than the one being paid out
         and wiped. Idempotent; never blocks the end of a game. */
      try {
        const { maybeRunMonthlyAwards } = await import('../leaderboards.js');
        await maybeRunMonthlyAwards(env);
      } catch (err) {
        console.error('[bingo/end] monthly award settle failed:', err.message);
      }
      try {
        await writeBoard(env, board);
        boardWritten = true;
      } catch (err) {
        console.error('[bingo/end] could not update lb_bingo:', err.message);
      }
    }
  }

  return json({
    success: true,
    alreadyEnded: !justEnded,
    players: final.players || [],
    standings: board,
    prizes: paidPrizes(final),
    calledCount: Array.isArray(final.calledEvents) ? final.calledEvents.length : 0,
    boardWritten,
  });
}
