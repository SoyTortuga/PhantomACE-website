import { TOTAL_EVENTS, squareText } from './squares.js';
import { readPointer, alertsAllowed } from './overlay.js';

const GAME_TTL = 14400;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function getSession(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)pham_session=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match[1])); } catch { return null; }
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);
  /* 401, not the 403 below: the host page tells "log in again" apart from
     "this is not your game", and a lapsed session mid-stream is the former. */
  if (!session || !session.user_id) {
    return json({ error: 'Your login has expired. Log in again to keep calling squares.' }, 401);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  const code = (body.code || '').toUpperCase().trim();
  const eventId = body.eventId;
  const action = body.action;
  if (!code || eventId == null) return json({ error: 'Missing code or eventId' }, 400);
  if (!Number.isInteger(eventId) || squareText(eventId) == null) {
    return json({ error: 'Invalid eventId' }, 400);
  }

  /* Read before the room lock, not inside it: it is a different row, and
     the decision only needs to be as fresh as this request. */
  const pointer = await readPointer(env);

  let failure = null;
  let alert = null;
  let calledEvents = [];

  await env.MARKETPLACE.mutate(`bingo_${code}`, (game) => {
    if (!game) { failure = json({ error: 'Game not found — the room may have expired.' }, 404); return undefined; }

    /* ONLY THE HOST. Anybody who knew a room code — and players are told
       it, that is how they join — could otherwise call events into somebody
       else's game, and a called event is what decides who gets a prize. */
    if (String(session.user_id) !== String(game.host)) {
      failure = json({ error: 'Only the host can call events.' }, 403);
      return undefined;
    }
    if (game.status === 'ended') { failure = json({ error: 'Game has ended' }, 400); return undefined; }

    if (!Array.isArray(game.calledEvents)) game.calledEvents = [];
    if (action === 'uncall') {
      game.calledEvents = game.calledEvents.filter(id => id !== eventId);
    } else if (!game.calledEvents.includes(eventId)) {
      game.calledEvents.push(eventId);

      /* ONE ALERT PER SQUARE PER GAME, on the off->on edge only. A host
         toggling a square call/undo/call must not flash it on stream each
         time, so the squares that have alerted are remembered in the room. */
      const alerted = Array.isArray(game.alertedEvents) ? game.alertedEvents : [];
      if (!alerted.includes(eventId) && alertsAllowed(pointer, code, game)) {
        alerted.push(eventId);
        game.alertedEvents = alerted;
        alert = { called: game.calledEvents.length };
      }
    }
    calledEvents = game.calledEvents;
    return game;
  }, { expirationTtl: GAME_TTL });

  if (failure) return failure;

  /* The label is the server's own text for the square — never the request
     body, which let any host put arbitrary text on stream. Best-effort: an
     overlay hiccup must not fail the call itself. */
  if (alert) {
    try {
      const { pushOverlayEvent } = await import('../overlay/events.js');
      await pushOverlayEvent(env, {
        type: 'bingo-call',
        eventId,
        label: squareText(eventId),
        called: alert.called,
        total: TOTAL_EVENTS,
      });
    } catch (err) {
      console.error('[bingo/call] could not push overlay event:', err.message);
    }
  }

  return json({ success: true, calledEvents });
}
