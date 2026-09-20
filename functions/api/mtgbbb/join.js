/* ══════════════════════════════════════════════
   MTGBBB JOIN — a viewer gets a card.

   The card is dealt from the room's OWN frozen pool (room.pool, set by
   create.js) — never re-read from the set cache — and seeded from the room
   code and the player's user id via mtgbbb-scoring's buildCard(). Same
   inputs, same card, every time: a refresh cannot reroll it, and a late
   joiner gets the same card they would have gotten at pack one, per the
   plan's "entry stays open for the whole game" rule.

   LOGIN REQUIRED, not a guest id, for the same reason bingo's join.js
   requires one now: a prize rides on this at the end of the game, and a
   guest id is free to mint.

   Concurrent joins use mutate() rather than get-then-put. A stream opening
   is exactly when many viewers hit this within the same second, and a lost
   update here means a player who thinks they joined never actually appears
   in the room.
   ══════════════════════════════════════════════ */

import { buildCard } from '../mtgbbb-scoring.js';

const GAME_TTL = 14400;

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

export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);
  if (!session || !session.user_id) return json({ error: 'Log in with Twitch to play MTGBBB.' }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  const code = String(body.code || '').toUpperCase().trim();
  const name = String(body.name || '').trim().slice(0, 30) || session.display_name || 'Player';
  if (!code) return json({ error: 'Missing code' }, 400);

  const playerId = 'u_' + session.user_id;

  let failure = null;
  let result = null;

  await env.MARKETPLACE.mutate(`mtgbbb_${code}`, (room) => {
    if (!room) { failure = json({ error: 'Game not found' }, 404); return undefined; }
    if (room.status === 'ended') { failure = json({ error: 'This game has ended.' }, 400); return undefined; }

    const existing = room.players.find(p => p.id === playerId);
    if (existing) {
      if (existing.name !== name) existing.name = name;
      if (!Array.isArray(existing.cards) || !existing.cards.length) existing.cards = [existing.card];
      if (!Array.isArray(existing.wildcards)) existing.wildcards = [];
      result = { card: existing.card };
      return room;
    }

    const pool = room.pool.map(c => c.name);
    const card = buildCard(pool, `${code}:${session.user_id}`);
    room.players.push({ id: playerId, name, card, cards: [card], wildcards: [] });
    result = { card };
    return room;
  }, { expirationTtl: GAME_TTL });

  if (failure) return failure;

  return json({ success: true, card: result.card });
}
