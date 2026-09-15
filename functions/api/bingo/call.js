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

export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  const code = (body.code || '').toUpperCase().trim();
  const eventId = body.eventId;
  const action = body.action;
  if (!code || eventId == null) return json({ error: 'Missing code or eventId' }, 400);
  if (!Number.isInteger(eventId) || eventId < 1 || eventId > TOTAL_EVENTS) {
    return json({ error: 'Invalid eventId' }, 400);
  }

  const key = `bingo_${code}`;
  const raw = await env.MARKETPLACE.get(key);
  if (!raw) return json({ error: 'Game not found' }, 404);

  const game = JSON.parse(raw);

  /* ONLY THE HOST. There was no check at all, so anybody who knew a room
     code — and players are told it, that is how they join — could call
     events into somebody else's game or un-call them. Harmless while bingo
     was for fun; not harmless now that a called event is what decides who
     gets a prize. */
  if (!session || String(session.user_id) !== String(game.host)) {
    return json({ error: 'Only the host can call events.' }, 403);
  }

  if (game.status === 'ended') return json({ error: 'Game has ended' }, 400);

  if (action === 'uncall') {
    game.calledEvents = game.calledEvents.filter(id => id !== eventId);
  } else {
    if (!game.calledEvents.includes(eventId)) {
      game.calledEvents.push(eventId);
    }
  }

  await env.MARKETPLACE.put(key, JSON.stringify(game), { expirationTtl: GAME_TTL });
  return json({ success: true, calledEvents: game.calledEvents });
}
