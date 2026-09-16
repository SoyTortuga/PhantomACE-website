/* ══════════════════════════════════════════════
   MTGBBB END — closes the room to new pulls.

   Any moderator or broadcaster, not only the host — same reasoning as
   mark.js. Ending does not settle anything by itself: award.js is the
   separate, host-locked step that actually pays out, exactly like bingo.
   ══════════════════════════════════════════════ */

import { standings } from '../mtgbbb-scoring.js';

const GAME_TTL = 14400;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
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
  if (!session || !session.user_id) return json({ error: 'Log in first.' }, 401);

  const { isModerator } = await import('../admin/moderators.js');
  if (!(await isModerator(env, session))) {
    return json({ error: 'Only the broadcaster and moderators can end a game.' }, 403);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  const code = String(body.code || '').toUpperCase().trim();
  if (!code) return json({ error: 'Missing code' }, 400);

  let failure = null;
  let final = null;

  await env.MARKETPLACE.mutate(`mtgbbb_${code}`, (room) => {
    if (!room) { failure = json({ error: 'Game not found' }, 404); return undefined; }
    if (room.status === 'ended') { final = room; return undefined; }

    room.status = 'ended';
    room.endedAt = Date.now();
    final = room;
    return room;
  }, { expirationTtl: GAME_TTL });

  if (failure) return failure;

  const board = standings(final.players, final.pulls)
    .map(p => ({ id: p.id, name: p.name, points: p.points, marks: p.marks, blackout: p.blackout }));

  return json({ success: true, standings: board });
}
