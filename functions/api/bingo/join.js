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

function generateCard() {
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

  const code = (body.code || '').toUpperCase().trim();
  const name = (body.name || '').trim().slice(0, 30);
  const guestId = (body.guestId || '').trim().slice(0, 40);
  if (!code || !name) return json({ error: 'Missing code or name' }, 400);

  const playerId = session ? 'u_' + session.user_id : (guestId ? 'g_' + guestId : null);

  const key = `bingo_${code}`;
  const raw = await env.MARKETPLACE.get(key);
  if (!raw) return json({ error: 'Game not found' }, 404);

  const game = JSON.parse(raw);
  if (game.status === 'ended') return json({ error: 'Game has ended' }, 400);

  if (playerId) {
    const existing = game.players.find(p => p.id === playerId);
    if (existing) {
      if (existing.name !== name) existing.name = name;
      await env.MARKETPLACE.put(key, JSON.stringify(game), { expirationTtl: GAME_TTL });
      return json({ cardIds: existing.cardIds, calledEvents: game.calledEvents });
    }
  }

  const cardIds = generateCard();

  game.players.push({ id: playerId, name, cardIds });
  await env.MARKETPLACE.put(key, JSON.stringify(game), { expirationTtl: GAME_TTL });

  return json({ cardIds, calledEvents: game.calledEvents });
}
