/* ══════════════════════════════════════════════
   BINGO POWERS — spending inventory items inside a live game.

     POST { action: 'extra-card', code }
     POST { action: 'wildcard',   code, cardIndex, eventId }

   THE BUGS THIS REPLACES, both found on stream. "Extra card" was
   client-only: it overwrote the player's one card in the page, the server
   still held the original, and a refresh handed the original back — the
   item was spent for a card that stopped existing. The wildcard was
   client-only too: the poll's mark-sweep deleted any mark that was not in
   calledEvents, so the stamp vanished within three seconds of being paid
   for.

   So both effects live in the ROOM now. Extra cards are appended to the
   player's server-side card list and come back on every rejoin; wildcard
   stamps are recorded per player and the client derives its marks from
   called-plus-wildcards, so no sweep can eat them. The ITEM is taken by
   the server in the same breath as the effect is recorded — the generic
   client-side inventory `use` is exactly the trust-the-caller gap that
   made "spent but nothing happened" possible.

   ITEMS ARE THE commander-bingo POOL ON PURPOSE, in MTGBBB too. That is
   the namespace every already-granted pass reward carries, and this
   session has already paid once for renaming reward identity out from
   under existing claims. One shared pool, spendable in either bingo.

   The host sees wildcard counts (via state.js) because a bingo the host
   cannot verify honestly is a prize dispute on stream.
   ══════════════════════════════════════════════ */

import { generateCard } from './join.js';
import { consumeConsumable, refundConsumable } from '../inventory.js';

const GAME_TTL = 14400;
const MAX_CARDS = 3;
const ITEM_GAME = 'commander-bingo';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function getSession(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/pham_session=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match[1])); } catch { return null; }
}

/**
 * Every room written before powers existed holds players shaped
 * { id, name, cardIds }. Normalised IN PLACE wherever a power touches one:
 * cards[0] is the original card, and cardIds stays mirrored to cards[0]
 * because the host page still reads it.
 */
export function normalizePlayer(p) {
  if (!Array.isArray(p.cards) || !p.cards.length) p.cards = [p.cardIds];
  if (!Array.isArray(p.wildcards)) p.wildcards = [];
  p.cardIds = p.cards[0];
  return p;
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);
  if (!session || !session.user_id) return json({ error: 'Log in first.' }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  const code = String(body.code || '').toUpperCase().trim();
  if (!code) return json({ error: 'Missing code' }, 400);
  const playerId = 'u_' + session.user_id;
  const key = `bingo_${code}`;

  /* Validate against a fresh read BEFORE spending the item: most refusals
     (full hand, square already called) should cost nothing and say why. */
  const raw = await env.MARKETPLACE.get(key);
  if (!raw) return json({ error: 'Game not found' }, 404);
  const game = JSON.parse(raw);
  if (game.status === 'ended') return json({ error: 'Game has ended' }, 400);
  const me = game.players.find(p => p.id === playerId);
  if (!me) return json({ error: 'Join the game first.' }, 403);
  normalizePlayer(me);

  if (body.action === 'extra-card') {
    if (me.cards.length >= MAX_CARDS) {
      return json({ error: `You are already playing ${MAX_CARDS} cards.` }, 400);
    }

    const spent = await consumeConsumable(env, session.user_id, { game: ITEM_GAME, type: 'bonus-card' });
    if (!spent.ok) return json({ error: 'No extra card in your inventory.' }, 400);

    const newCard = generateCard();
    const wrote = await appendToPlayer(env, key, playerId, (p) => {
      if (p.cards.length >= MAX_CARDS) return false;
      p.cards.push(newCard);
      return true;
    });
    if (!wrote) {
      await refundConsumable(env, session.user_id, { game: ITEM_GAME, type: 'bonus-card', name: 'Extra Bingo Card' });
      return json({ error: 'Could not add the card — the item was returned.' }, 409);
    }
    return json({ success: true, cardIds: newCard, cardIndex: null, remaining: spent.remaining });
  }

  if (body.action === 'wildcard') {
    const cardIndex = Number(body.cardIndex);
    const eventId = Number(body.eventId);
    if (!Number.isInteger(cardIndex) || cardIndex < 0 || cardIndex >= me.cards.length) {
      return json({ error: 'No such card.' }, 400);
    }
    if (!Number.isInteger(eventId) || eventId <= 0) return json({ error: 'No such square.' }, 400);
    if (!me.cards[cardIndex].includes(eventId)) return json({ error: 'That square is not on this card.' }, 400);
    if ((game.calledEvents || []).includes(eventId)) {
      /* Refused BEFORE the spend: stamping a called square burns the item
         for nothing, and "did nothing" is the bug this file exists to end. */
      return json({ error: 'That square has already been called.' }, 400);
    }
    if (me.wildcards.some(w => w.cardIndex === cardIndex && w.eventId === eventId)) {
      return json({ error: 'Already stamped.' }, 400);
    }

    const spent = await consumeConsumable(env, session.user_id, { game: ITEM_GAME, type: 'wildcard' });
    if (!spent.ok) return json({ error: 'No wildcard stamp in your inventory.' }, 400);

    const wrote = await appendToPlayer(env, key, playerId, (p) => {
      if (p.wildcards.some(w => w.cardIndex === cardIndex && w.eventId === eventId)) return false;
      p.wildcards.push({ cardIndex, eventId });
      return true;
    });
    if (!wrote) {
      await refundConsumable(env, session.user_id, { game: ITEM_GAME, type: 'wildcard', name: 'Wildcard Stamp' });
      return json({ error: 'Could not stamp — the item was returned.' }, 409);
    }
    return json({ success: true, wildcard: { cardIndex, eventId }, remaining: spent.remaining });
  }

  return json({ error: 'Unknown action' }, 400);
}

/**
 * Re-read, re-find, apply, write — under the room key's lock, because the
 * validation read above races the host calling squares. `fn` sees the
 * normalised CURRENT player and returns false to abandon the write.
 */
async function appendToPlayer(env, key, playerId, fn) {
  let applied = false;
  await env.MARKETPLACE.mutate(key, (game) => {
    if (!game || game.status === 'ended') return undefined;
    const p = game.players.find(x => x.id === playerId);
    if (!p) return undefined;
    normalizePlayer(p);
    if (!fn(p)) return undefined;
    p.cardIds = p.cards[0];
    applied = true;
    return game;
  }, { expirationTtl: GAME_TTL });
  return applied;
}
