const GAME_TTL = 14400;
const TOTAL_EVENTS = 60;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
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

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  const code = (body.code || '').toUpperCase().trim();
  const name = (body.name || '').trim().slice(0, 30);
  if (!code || !name) return json({ error: 'Missing code or name' }, 400);

  const key = `bingo_${code}`;
  const raw = await env.MARKETPLACE.get(key);
  if (!raw) return json({ error: 'Game not found' }, 404);

  const game = JSON.parse(raw);
  if (game.status === 'ended') return json({ error: 'Game has ended' }, 400);

  const cardIds = generateCard();

  game.players.push({ name, cardIds });
  await env.MARKETPLACE.put(key, JSON.stringify(game), { expirationTtl: GAME_TTL });

  return json({ cardIds, calledEvents: game.calledEvents });
}
