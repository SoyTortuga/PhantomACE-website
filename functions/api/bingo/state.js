function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const code = (url.searchParams.get('code') || '').toUpperCase().trim();
  if (!code) return json({ error: 'Missing code' }, 400);

  const key = `bingo_${code}`;
  const raw = await env.MARKETPLACE.get(key);
  if (!raw) return json({ error: 'Game not found' }, 404);

  const game = JSON.parse(raw);
  return json({ calledEvents: game.calledEvents, status: game.status });
}
