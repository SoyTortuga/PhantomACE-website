const GAME_TTL = 14400;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestPost(context) {
  const { env, request } = context;

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  const code = (body.code || '').toUpperCase().trim();
  if (!code) return json({ error: 'Missing code' }, 400);

  const key = `bingo_${code}`;
  const raw = await env.MARKETPLACE.get(key);
  if (!raw) return json({ error: 'Game not found' }, 404);

  const game = JSON.parse(raw);
  game.status = 'ended';

  await env.MARKETPLACE.put(key, JSON.stringify(game), { expirationTtl: GAME_TTL });
  return json({ success: true, players: game.players });
}
