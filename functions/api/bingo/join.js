const GAME_TTL = 14400;
const TOTAL_EVENTS = 68;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function getSession(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/pham_session=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match[1])); } catch { return null; }
}

/* Exported for powers.js — an extra card must be dealt by the same hand
   as the first one. */
export function generateCard() {
  const all = [];
  for (let i = 1; i <= TOTAL_EVENTS; i++) all.push(i);
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  const selected = all.slice(0, 24);
  selected.splice(12, 0, 0);
  return selected;
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  /* LOGIN REQUIRED, for the same reason Mana Clash requires it: prizes ride
     on identity. A guest id is free to mint, so a guest could take a prize
     and come back as somebody else for another — and there is nobody to
     credit entries to afterwards.

     It also closes a smaller hole. A player with neither a session nor a
     guest id got id: null, and every such player collided on that one id:
     the second one to join was handed the first one's card. */
  if (!session || !session.user_id) {
    return json({ error: 'Log in with Twitch to play Commander Bingo.' }, 401);
  }

  const code = (body.code || '').toUpperCase().trim();
  const name = (body.name || '').trim().slice(0, 30) || session.display_name || 'Player';
  if (!code) return json({ error: 'Missing code' }, 400);

  const playerId = 'u_' + session.user_id;

  const key = `bingo_${code}`;
  const raw = await env.MARKETPLACE.get(key);
  if (!raw) return json({ error: 'Game not found' }, 404);

  const game = JSON.parse(raw);
  if (game.status === 'ended') return json({ error: 'Game has ended' }, 400);

  const existing = game.players.find(p => p.id === playerId);
  if (existing) {
    if (existing.name !== name) existing.name = name;
    /* Pre-powers players hold only cardIds; hand back everything they own
       so a refresh restores extra cards and wildcard stamps, not just the
       original card — losing those on reload was half of the extra-card
       bug as shipped. */
    if (!Array.isArray(existing.cards) || !existing.cards.length) existing.cards = [existing.cardIds];
    if (!Array.isArray(existing.wildcards)) existing.wildcards = [];
    existing.cardIds = existing.cards[0];
    await env.MARKETPLACE.put(key, JSON.stringify(game), { expirationTtl: GAME_TTL });
    return json({ cardIds: existing.cardIds, cards: existing.cards, wildcards: existing.wildcards, calledEvents: game.calledEvents });
  }

  const cardIds = generateCard();

  /* cards[0] === cardIds, mirrored: the host page and older rooms read
     cardIds, powers.js reads cards. One truth, two spellings, kept equal
     by everything that writes a player. */
  game.players.push({ id: playerId, name, cardIds, cards: [cardIds], wildcards: [] });
  await env.MARKETPLACE.put(key, JSON.stringify(game), { expirationTtl: GAME_TTL });

  return json({ cardIds, cards: [cardIds], wildcards: [], calledEvents: game.calledEvents });
}
