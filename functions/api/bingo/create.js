import { takeOverlay } from './overlay.js';

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

  /* A host has to be someone. An anonymous host cannot be checked when a
     prize is awarded later, and 'anonymous' as an id meant every anonymous
     game shared one — so anybody could call events in, or end, a game they
     had never opened. */
  if (!session || !session.user_id) {
    return json({ error: 'Log in with Twitch to host a game.' }, 401);
  }

  const code = (body.code || '').toUpperCase().trim();
  if (!code || code.length < 3 || code.length > 6) return json({ error: 'Invalid code' }, 400);

  const key = `bingo_${code}`;
  const existing = await env.MARKETPLACE.get(key);
  if (existing) return json({ error: 'Code already in use' }, 409);

  const game = {
    code,
    host: String(session.user_id),
    hostName: session.display_name || '',
    status: 'active',
    calledEvents: [],
    players: [],
    createdAt: Date.now(),
  };

  await env.MARKETPLACE.put(key, JSON.stringify(game), { expirationTtl: GAME_TTL });

  /* Only STAFF creating a room takes the overlay. Anyone with a login may
     host a card for their pod, but bingo_current is what puts a room — and
     its call/win alerts — on the live stream, so a viewer's room must not
     claim it just by existing. A moderator can still put any running room
     on stream from the Overlay Dashboard. Best-effort: a game is playable
     without the overlay, so a failure here must not fail the create. */
  const { isModerator } = await import('../admin/moderators.js');
  let onOverlay = false;
  if (await isModerator(env, session)) {
    try {
      await takeOverlay(env, code);
      onOverlay = true;
    } catch (err) {
      console.error('[bingo/create] could not set bingo_current:', err.message);
    }
  }

  return json({ success: true, code, onOverlay });
}
