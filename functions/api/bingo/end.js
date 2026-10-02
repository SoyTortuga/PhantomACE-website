import { releaseOnEnd } from './overlay.js';

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

  let failure = null;
  let players = [];

  await env.MARKETPLACE.mutate(`bingo_${code}`, (game) => {
    if (!game) { failure = json({ error: 'Game not found' }, 404); return undefined; }

    /* Unauthenticated before this, so any player could end the host's game
       mid-stream. */
    if (!session || String(session.user_id) !== String(game.host)) {
      failure = json({ error: 'Only the host can end the game.' }, 403);
      return undefined;
    }

    game.status = 'ended';
    game.endedAt = Date.now();
    players = game.players || [];
    return game;
  }, { expirationTtl: GAME_TTL });

  if (failure) return failure;

  /* Take the overlay pointer down with the game, but ONLY if it still names
     this room — a newer game may have claimed it, and clearing it blind
     would blank that live game's overlay. The pointer remembers the room it
     ended on, so the prizes awarded from the results screen still alert. */
  try {
    await releaseOnEnd(env, code);
  } catch (err) {
    console.error('[bingo/end] could not clear bingo_current:', err.message);
  }

  return json({ success: true, players });
}
