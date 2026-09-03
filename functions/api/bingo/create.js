const GAME_TTL = 14400;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
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

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  const code = (body.code || '').toUpperCase().trim();
  if (!code || code.length < 3 || code.length > 6) return json({ error: 'Invalid code' }, 400);

  const key = `bingo_${code}`;
  const existing = await env.MARKETPLACE.get(key);
  if (existing) return json({ error: 'Code already in use' }, 409);

  const game = {
    code,
    host: session ? session.user_id : 'anonymous',
    status: 'active',
    calledEvents: [],
    players: [],
    createdAt: Date.now(),
  };

  await env.MARKETPLACE.put(key, JSON.stringify(game), { expirationTtl: GAME_TTL });
  return json({ success: true, code });
}
