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
  if (!code) return json({ error: 'Missing code' }, 400);

  const key = `bingo_${code}`;
  const raw = await env.MARKETPLACE.get(key);
  if (!raw) return json({ error: 'Game not found' }, 404);

  const game = JSON.parse(raw);

  /* Unauthenticated before this, so any player could end the host's game
     mid-stream. */
  if (!session || String(session.user_id) !== String(game.host)) {
    return json({ error: 'Only the host can end the game.' }, 403);
  }

  game.status = 'ended';
  game.endedAt = Date.now();

  await env.MARKETPLACE.put(key, JSON.stringify(game), { expirationTtl: GAME_TTL });

  /* Take the overlay pointer down with the game, but ONLY if it still names
     this room — a newer game may have opened and claimed it, and clearing it
     blind would blank that live game's overlay. */
  try {
    const current = await env.MARKETPLACE.get('bingo_current', 'json');
    if (current && current.code === code) await env.MARKETPLACE.delete('bingo_current');
  } catch (err) {
    console.error('[bingo/end] could not clear bingo_current:', err.message);
  }

  return json({ success: true, players: game.players });
}
