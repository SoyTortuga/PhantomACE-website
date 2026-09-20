/* ══════════════════════════════════════════════
   MTGBBB POWERS — extra cards and wildcard stamps, server-side.

     POST { action: 'extra-card', code }
     POST { action: 'wildcard',   code, cardIndex, squareIndex }

   MTGBBB never had these at all — the pass sells the items, Commander
   Bingo half-had them, and here they simply did not exist. Same design as
   bingo/powers.js: the effect lives in the room, the item is taken by the
   server in the same breath, and the ITEMS ARE THE commander-bingo POOL —
   the namespace every already-granted reward carries. One pool, spendable
   in either bingo; renaming item identity out from under existing claims
   is a mistake this project has already paid for once.

   AN EXTRA CARD IS DEALT LIKE THE FIRST ONE: deterministically, from the
   room's frozen pool, seeded by code, player and card number. Same
   inputs, same card — a refresh cannot reroll it, and neither can buying
   it again after seeing it (the cap is by card count, so the same seed
   comes back). Randomness a player can shop from is a slot machine.

   A wildcard stamps a SQUARE INDEX, not a card name: MTGBBB squares are
   positional, and two cards can carry the same name in different places.
   Stamping a square the pulls already marked is refused BEFORE the spend
   — a stamp that visibly did nothing is the exact bug that sent this
   feature back here.
   ══════════════════════════════════════════════ */

import { buildCard, scoreCard, playerCards, wildsFor, SQUARES } from '../mtgbbb-scoring.js';
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

function normalize(p) {
  if (!Array.isArray(p.cards) || !p.cards.length) p.cards = [p.card];
  if (!Array.isArray(p.wildcards)) p.wildcards = [];
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
  const key = `mtgbbb_${code}`;

  const room = await env.MARKETPLACE.get(key, 'json');
  if (!room) return json({ error: 'Game not found' }, 404);
  if (room.status === 'ended') return json({ error: 'Game has ended' }, 400);
  const me = room.players.find(p => p.id === playerId);
  if (!me) return json({ error: 'Join the game first.' }, 403);
  normalize(me);

  if (body.action === 'extra-card') {
    if (me.cards.length >= MAX_CARDS) {
      return json({ error: `You are already playing ${MAX_CARDS} cards.` }, 400);
    }

    const spent = await consumeConsumable(env, session.user_id, { game: ITEM_GAME, type: 'bonus-card' });
    if (!spent.ok) return json({ error: 'No extra card in your inventory.' }, 400);

    let added = null;
    const wrote = await mutatePlayer(env, key, playerId, (p, r) => {
      if (p.cards.length >= MAX_CARDS) return false;
      /* Seeded by how many cards the player already has, so the deal is
         reproducible and never re-rollable. */
      /* NAMES, not the pool records — buildCard deals ids, and join.js
         maps the pool the same way. Passing the objects through dealt a
         card that could never match a pull, caught by the suite's own
         round-trip rather than by a player mid-box. */
      added = buildCard(r.pool.map(c => c.name), `${code}:${session.user_id}:extra${p.cards.length}`);
      p.cards.push(added);
      return true;
    });
    if (!wrote) {
      await refundConsumable(env, session.user_id, { game: ITEM_GAME, type: 'bonus-card', name: 'Extra Bingo Card' });
      return json({ error: 'Could not add the card — the item was returned.' }, 409);
    }
    return json({ success: true, card: added, remaining: spent.remaining });
  }

  if (body.action === 'wildcard') {
    const cardIndex = Number(body.cardIndex);
    const squareIndex = Number(body.squareIndex);
    if (!Number.isInteger(cardIndex) || cardIndex < 0 || cardIndex >= me.cards.length) {
      return json({ error: 'No such card.' }, 400);
    }
    if (!Number.isInteger(squareIndex) || squareIndex < 0 || squareIndex >= SQUARES) {
      return json({ error: 'No such square.' }, 400);
    }
    const { wildcards } = playerCards(me);
    const already = scoreCard(me.cards[cardIndex], room.pulls, wildsFor(wildcards, cardIndex));
    if (already.marked[squareIndex]) {
      return json({ error: 'That square is already marked.' }, 400);
    }

    const spent = await consumeConsumable(env, session.user_id, { game: ITEM_GAME, type: 'wildcard' });
    if (!spent.ok) return json({ error: 'No wildcard stamp in your inventory.' }, 400);

    const wrote = await mutatePlayer(env, key, playerId, (p) => {
      if (p.wildcards.some(w => w.cardIndex === cardIndex && w.squareIndex === squareIndex)) return false;
      p.wildcards.push({ cardIndex, squareIndex });
      return true;
    });
    if (!wrote) {
      await refundConsumable(env, session.user_id, { game: ITEM_GAME, type: 'wildcard', name: 'Wildcard Stamp' });
      return json({ error: 'Could not stamp — the item was returned.' }, 409);
    }
    return json({ success: true, wildcard: { cardIndex, squareIndex }, remaining: spent.remaining });
  }

  return json({ error: 'Unknown action' }, 400);
}

/** Re-read and apply under the room's lock; the read above was a preview. */
async function mutatePlayer(env, key, playerId, fn) {
  let applied = false;
  await env.MARKETPLACE.mutate(key, (room) => {
    if (!room || room.status === 'ended') return undefined;
    const p = room.players.find(x => x.id === playerId);
    if (!p) return undefined;
    normalize(p);
    if (!fn(p, room)) return undefined;
    applied = true;
    return room;
  }, { expirationTtl: GAME_TTL });
  return applied;
}
