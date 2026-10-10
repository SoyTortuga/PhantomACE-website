/* ══════════════════════════════════════════════
   COMMANDER BINGO — CHAT'S OWN CARD.

     mod:   POST /api/bingo-chat { action:'open' }    deal chat a card
            POST /api/bingo-chat { action:'stamp' }   place the voted wildcard
            POST /api/bingo-chat { action:'close' }   take it down
     chat:  !stamp <1-25>
     OBS:   GET  /api/bingo-chat

   WHY. Until now chat could only CLAIM a bingo — `!bingo` verifies a card the
   chatter went to the site to get. Anyone watching without an account had
   nothing. This gives the whole channel one shared card: no joining, no site
   visit, no account. Chat is a single player at the table.

   THE MARKS ARE NEVER STORED. They are computed from the room's own
   `calledEvents` every time the card is read, through the same cardScore() the
   players' cards are scored with. A stored copy would be a second truth about
   what has been called, and the first time an undo desynced it the card on
   stream would be lying to the entire channel.

   ONE WILDCARD, PLACED BY VOTE. Without it the card is a lottery ticket chat
   watches rather than plays. `!stamp <square>` votes; the host places the
   winner when chat has settled. It mirrors the wildcard item players can spend
   (bingo/powers.js), so it is one rule, not a new one.

   PAID ON THE CALL, NOT ON THE READ. A new bingo can only appear when the host
   calls a square, so call.js tells this module and the payout happens on that
   authenticated path. Detecting it on the overlay's public GET would mean a
   poll could trigger a payout.
   ══════════════════════════════════════════════ */

import { generateCard } from './bingo/join.js';
import { cardScore } from './bingo/end.js';
import { squareText } from './bingo/squares.js';

const KEY = 'bingo_chat';
/* Matches the room's own lifetime (bingo/create.js GAME_TTL). */
const TTL = 14400;
const MAX_VOTERS = 2000;
const WIN_ENTRIES = 2;

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

/** The square indices chat's stamp may land on: anything but the free space. */
function validSquare(n) {
  return Number.isInteger(n) && n >= 0 && n < 25 && n !== 12;
}

/** Most-voted square first, ties to whoever got there first. */
export function stampTally(card) {
  const byIdx = new Map();
  for (const v of Object.values(card.votes || {})) {
    const cur = byIdx.get(v.square);
    if (!cur) byIdx.set(v.square, { square: v.square, votes: 1, at: v.at });
    else { cur.votes++; if (v.at < cur.at) cur.at = v.at; }
  }
  return [...byIdx.values()].sort((a, b) => (b.votes - a.votes) || (a.at - b.at));
}

/**
 * Score chat's card against what the host has actually called.
 * Returns null when there is no card, or no room for it any more.
 */
export async function scoreChatCard(env, card) {
  if (!card || !Array.isArray(card.cardIds)) return null;
  let game = null;
  try { game = await env.MARKETPLACE.get(`bingo_${card.code}`, 'json'); } catch { return null; }
  if (!game) return null;

  const called = new Set(Array.isArray(game.calledEvents) ? game.calledEvents : []);
  /* The stamp is stored as a SQUARE index but scored as an event id, because
     that is the shape cardScore shares with every player's wildcard. */
  const wildIds = new Set();
  if (validSquare(card.stamp)) wildIds.add(card.cardIds[card.stamp]);

  const score = cardScore(card.cardIds, called, wildIds);
  const marked = card.cardIds.map((id, i) =>
    id === 0 || called.has(id) || (validSquare(card.stamp) && i === card.stamp));

  return { ...score, marked, called, ended: game.status === 'ended' };
}

/* ── Chat ────────────────────────────────────────────────────────────────── */

/**
 * One chatter's stamp vote. Silent on every rejection. A later vote replaces
 * an earlier one — the card is on screen, so moving behind a square that is
 * winning is the point, not an exploit.
 */
export async function stampFromChat(env, { userId, name, text }) {
  if (!userId) return { ok: false, reason: 'empty' };

  const card = await read(env);
  if (!card) return { ok: false, reason: 'closed' };
  if (validSquare(card.stamp)) return { ok: false, reason: 'placed' };

  /* 1-based for chat, 0-based inside — nobody types "square 0". */
  const n = Number(String(text || '').trim());
  if (!Number.isInteger(n) || n < 1 || n > 25) return { ok: false, reason: 'no-match' };
  const square = n - 1;
  if (square === 12) return { ok: false, reason: 'free-space' };

  /* A square the host has already called is not worth a wildcard. */
  const scored = await scoreChatCard(env, card);
  if (!scored) return { ok: false, reason: 'closed' };
  if (scored.marked[square]) return { ok: false, reason: 'already-marked' };

  const id = String(userId);
  let outcome = { ok: false, reason: 'closed' };
  await env.MARKETPLACE.mutate(KEY, (cur) => {
    if (!cur || validSquare(cur.stamp)) return undefined;
    const had = !!cur.votes[id];
    if (!had && Object.keys(cur.votes).length >= MAX_VOTERS) {
      outcome = { ok: false, reason: 'full' };
      return undefined;
    }
    if (had && cur.votes[id].square === square) { outcome = { ok: false, reason: 'same' }; return undefined; }
    cur.votes[id] = { square, display: String(name || 'Someone').slice(0, 30), at: had ? cur.votes[id].at : Date.now() };
    outcome = { ok: true, square };
    return cur;
  }, { expirationTtl: TTL });

  return outcome;
}

/* ── Mod actions ─────────────────────────────────────────────────────────── */

export async function openChatCard(env, code) {
  const c = String(code || '').toUpperCase().trim();
  if (!c) return { ok: false, error: 'No game code.' };
  let game = null;
  try { game = await env.MARKETPLACE.get(`bingo_${c}`, 'json'); } catch { /* handled below */ }
  if (!game) return { ok: false, error: 'No such bingo game.' };
  if (game.status === 'ended') return { ok: false, error: 'That game has ended.' };

  await env.MARKETPLACE.put(KEY, JSON.stringify({
    code: c,
    cardIds: generateCard(),
    votes: {},
    stamp: null,
    bingosPaid: 0,
    openedAt: Date.now(),
  }), { expirationTtl: TTL });
  return { ok: true };
}

/** Place the wildcard on whichever square chat backed hardest. */
export async function placeStamp(env) {
  let placed = null;
  await env.MARKETPLACE.mutate(KEY, (cur) => {
    if (!cur || validSquare(cur.stamp)) return undefined;
    const tally = stampTally(cur);
    if (!tally.length) return undefined;
    cur.stamp = tally[0].square;
    cur.stampedAt = Date.now();
    placed = tally[0];
    return cur;
  }, { expirationTtl: TTL });
  return placed ? { ok: true, square: placed.square, votes: placed.votes } : { ok: false, error: 'Nobody has voted for a square yet.' };
}

export async function closeChatCard(env) {
  try { await env.MARKETPLACE.delete(KEY); } catch { /* best effort */ }
  return { ok: true };
}

/**
 * Called by bingo/call.js after a square lands.
 *
 * A bingo on chat's card can only appear here, so this is where it is noticed
 * and paid — on a moderator-authenticated path, never on the overlay's poll.
 * Pays once, the first time: `bingosPaid` is the high-water mark, so a second
 * line does not re-pay the same people.
 */
export async function onSquareCalled(env, code) {
  const card = await read(env);
  if (!card || card.code !== String(code || '').toUpperCase()) return { fired: false };

  const scored = await scoreChatCard(env, card);
  if (!scored || scored.bingos <= (card.bingosPaid || 0)) return { fired: false };

  let voters = [];
  await env.MARKETPLACE.mutate(KEY, (cur) => {
    if (!cur || scored.bingos <= (cur.bingosPaid || 0)) return undefined;
    cur.bingosPaid = scored.bingos;
    voters = Object.entries(cur.votes || {}).map(([id, v]) => ({ userId: id, name: v.display }));
    return cur;
  }, { expirationTtl: TTL });

  if (!voters.length) {
    /* Chat bingo'd on the calls alone, without placing a stamp. Still worth
       announcing — there is simply nobody who earned it. */
    await pushBingoAlert(env, scored.bingos, 0);
    return { fired: true, paid: 0 };
  }

  /* Entries only for an account that exists. profile_<id> is written on every
     login; crediting an id that never signed in would seed the monthly draw
     with an entrant it cannot pay. Same rule as every other chat reward.

     IN PARALLEL, FIVE AT A TIME. This was a profile read and then a ledger
     write per voter, awaited one after the other, so a forty-voter card meant
     eighty serialised queries while the moderator's call waited and the
     overlay alert held off -- the bigger the chat, the slower its own win
     appeared. The voters are independent (`votes` is keyed by user id, so each
     appears once, and each ledger row is their own), so nothing here has to
     wait on anything else.

     Bounded rather than all at once: the pool holds ten connections and this
     runs during a live game, so a hundred-voter card firing a hundred queries
     would put every other request on the site behind it. */
  const { addEntries } = await import('./giveaway-entries.js');
  const PAY_CONCURRENCY = 5;
  let paid = 0;

  const payOne = async (v) => {
    try {
      const profile = await env.MARKETPLACE.get(`profile_${v.userId}`, 'json');
      if (!profile) return;
      await addEntries(env, v.userId, v.name, WIN_ENTRIES, 'bingo-chat');
      paid++;
    } catch (err) {
      /* One voter who cannot be credited must not cost the rest their
         entries, nor swallow the alert below. */
      console.error('[bingo-chat] could not credit a voter:', err.message);
    }
  };

  for (let i = 0; i < voters.length; i += PAY_CONCURRENCY) {
    await Promise.all(voters.slice(i, i + PAY_CONCURRENCY).map(payOne));
  }

  await pushBingoAlert(env, scored.bingos, paid);
  return { fired: true, paid };
}

async function pushBingoAlert(env, bingos, paid) {
  try {
    const { pushOverlayEvent } = await import('./overlay/events.js');
    await pushOverlayEvent(env, { type: 'bingo-win', who: 'CHAT', bingos, paid, chat: true });
  } catch (err) {
    console.error('[bingo-chat] overlay alert failed:', err.message);
  }
}

/* ── Routes ──────────────────────────────────────────────────────────────── */

export async function onRequestGet(context) {
  const { env } = context;
  const card = await read(env);
  if (!card) return json({ status: 'none' });

  const scored = await scoreChatCard(env, card);
  if (!scored || scored.ended) return json({ status: 'none' });

  const tally = stampTally(card);
  return json({
    status: 'live',
    code: card.code,
    bingos: scored.bingos,
    marked: scored.marked.filter(Boolean).length,
    stamp: validSquare(card.stamp) ? card.stamp : null,
    votes: Object.keys(card.votes || {}).length,
    /* The square chat is currently backing, so the panel can show it building
       before it is placed. */
    leading: !validSquare(card.stamp) && tally.length ? tally[0].square : null,
    squares: card.cardIds.map((id, i) => ({
      n: i + 1,
      text: id === 0 ? 'FREE' : squareText(id),
      marked: scored.marked[i],
      free: id === 0,
      stamped: validSquare(card.stamp) && i === card.stamp,
    })),
  });
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);

  const { isModerator } = await import('./admin/moderators.js');
  if (!(await isModerator(env, session))) {
    return json({ error: 'Only the broadcaster and moderators can run chat\'s card.' }, 403);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }
  const action = String(body.action || '');

  if (action === 'open') {
    /* Defaults to whichever room is on the overlay, so the usual case is one
       button with nothing to type. */
    let code = body.code;
    if (!code) {
      try {
        const cur = await env.MARKETPLACE.get('bingo_current', 'json');
        code = cur && cur.code;
      } catch { /* fall through to the error below */ }
    }
    if (!code) return json({ error: 'No bingo game on the overlay — pick one first.' }, 400);
    const r = await openChatCard(env, code);
    return r.ok ? json({ success: true }) : json({ error: r.error }, 400);
  }
  if (action === 'stamp') {
    const r = await placeStamp(env);
    return r.ok ? json({ success: true, square: r.square + 1, votes: r.votes }) : json({ error: r.error }, 400);
  }
  if (action === 'close') { await closeChatCard(env); return json({ success: true }); }
  return json({ error: 'Unknown action' }, 400);
}
