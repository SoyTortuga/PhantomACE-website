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

  let newlyCalled = false;
  if (action === 'uncall') {
    game.calledEvents = game.calledEvents.filter(id => id !== eventId);
  } else {
    if (!game.calledEvents.includes(eventId)) {
      game.calledEvents.push(eventId);
      newlyCalled = true;
    }
  }

  await env.MARKETPLACE.put(key, JSON.stringify(game), { expirationTtl: GAME_TTL });

  /* Overlay alert on a GENUINELY new call only — never on an uncall, and
     never on re-calling a square already up, or the stream would flash the
     same alert twice. Suppressed entirely when the host has the game off the
     overlay: the switch means "no bingo on stream", alerts included. The
     label is the host's own event text (the host page already has it); it is
     cosmetic and host-only, so it is trusted here and escaped where the
     overlay renders it. Best-effort: an overlay hiccup must not fail the
     call itself. */
  if (newlyCalled && game.showOnOverlay !== false) {
    const label = String(body.text || '').slice(0, 120).trim();
    try {
      const { pushOverlayEvent } = await import('../overlay/events.js');
      await pushOverlayEvent(env, {
        type: 'bingo-call',
        eventId,
        label,
        called: game.calledEvents.length,
        total: TOTAL_EVENTS,
      });
    } catch (err) {
      console.error('[bingo/call] could not push overlay event:', err.message);
    }
  }

  return json({ success: true, calledEvents: game.calledEvents });
}
