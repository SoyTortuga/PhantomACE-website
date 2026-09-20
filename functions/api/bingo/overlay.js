const GAME_TTL = 14400;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function getSession(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/pham_session=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match[1])); } catch { return null; }
}

/**
 * SHOW ON OVERLAY — the host's switch for putting this game on the stream.
 *
 * The overlay panel finds the live room on its own, so without this switch a
 * game would appear on stream the instant it is created. This lets the host
 * decide: off, and the panel stays hidden AND the call/win alerts are
 * suppressed — nothing bingo reaches the overlay. On, and it all does.
 *
 * THE HOST OR A MODERATOR. The host runs it from their panel; the
 * broadcaster and moderators run it from Bot Control, because the overlay is
 * theirs to produce and the bingo host may be a different person. Knowing the
 * room code is not enough — players are told it — so it rests on identity.
 */
export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);
  if (!session || !session.user_id) return json({ error: 'Log in first.' }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  const code = String(body.code || '').toUpperCase().trim();
  if (!code) return json({ error: 'Missing code' }, 400);
  const show = !!body.show;

  const key = `bingo_${code}`;
  const raw = await env.MARKETPLACE.get(key);
  if (!raw) return json({ error: 'Game not found' }, 404);

  const game = JSON.parse(raw);

  const isHost = String(session.user_id) === String(game.host);
  if (!isHost) {
    const { isModerator } = await import('../admin/moderators.js');
    if (!(await isModerator(env, session))) {
      return json({ error: 'Only the host, broadcaster, or a moderator can change the overlay.' }, 403);
    }
  }

  game.showOnOverlay = show;
  await env.MARKETPLACE.put(key, JSON.stringify(game), { expirationTtl: GAME_TTL });

  return json({ success: true, showOnOverlay: show });
}
