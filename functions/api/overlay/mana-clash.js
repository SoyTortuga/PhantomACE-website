/* ══════════════════════════════════════════════
   MANA CLASH ON THE OVERLAY

   Two callers, two different ways of proving who they are, which is why
   they share a file rather than a check:

     GET  ?key=…        the OBS browser source. No cookie, no header, no
                        session — a browser source is a URL and nothing
                        else — so it carries the overlay key, exactly like
                        the event feed it sits beside.

     GET  ?rooms=1      the control panel, with a moderator session.
     POST               the control panel, choosing the room or switching
                        the panel off.

   WHY A POINTER AND NOT A ROOM CODE IN THE OBS URL.
   The same reason the MTGBBB panel finds its own game: editing the browser
   source every stream is a step that gets forgotten once and then silently
   shows nothing all night. The panel writes which room to watch, the
   overlay reads it, and the URL in OBS is set once and never touched.

   THE OVERLAY IS A READER. It never advances the game clock. get-state
   does that, driven by the players who are actually playing; a spectator
   that also advanced rounds would be a second writer on a hot row for no
   gain, and a game nobody is playing should stall rather than be walked
   forward by a panel on a screen.
   ══════════════════════════════════════════════ */

import { viewFor } from '../mana-clash.js';

const KEY = 'overlay_mana_clash';
/* The pointer outlives a stream but not a month. A stale pointer shows
   nothing anyway — the room it names is long gone — but there is no reason
   to keep it for ever. */
const POINTER_TTL = 2592000;

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

/** Every Mana Clash room, for the panel's picker. */
async function listRooms(env) {
  const rows = await env.MARKETPLACE.listValues({ prefix: 'mc_room_' });
  const rooms = [];
  for (const { value: room } of rows) {
    if (!room || !room.code) continue;
    /* INCLUDING GAMES ALREADY RUNNING, which the public list deliberately
       leaves out — it answers "what can I join", and a game in progress is
       not joinable. This answers "what could I put on stream", and a game
       in progress is the only interesting answer. */
    rooms.push({
      code: room.code,
      host: room.hostName || '',
      status: room.status,
      practice: !!room.practice,
      playerCount: Object.keys(room.players || {}).length,
      goal: room.goal,
      round: room.round || 0,
    });
  }
  /* Playing first, then lobbies, then finished — the order a moderator
     picking a room to show would want them in. */
  const rank = (r) => (r.status === 'playing' ? 0 : r.status === 'lobby' ? 1 : 2);
  rooms.sort((a, b) => rank(a) - rank(b) || a.code.localeCompare(b.code));
  return rooms;
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);

  /* ── The control panel's room picker ── */
  if (url.searchParams.get('rooms')) {
    const { isModerator } = await import('../admin/moderators.js');
    if (!(await isModerator(env, getSession(request)))) {
      return json({ error: 'You need broadcaster or moderator access for this.' }, 403);
    }
    const pointer = await env.MARKETPLACE.get(KEY, 'json') || { enabled: false, code: null };
    return json({ rooms: await listRooms(env), pointer });
  }

  /* ── The overlay itself ── */
  const { getOverlayKey } = await import('./events.js');
  const key = await getOverlayKey(env);
  if (url.searchParams.get('key') !== key) {
    return json({ error: 'Bad or missing key' }, 403);
  }

  const pointer = await env.MARKETPLACE.get(KEY, 'json');
  if (!pointer || !pointer.enabled || !pointer.code) {
    /* Switched off is an ordinary answer, not a fault. The panel hides and
       slows its polling; nothing on stream says anything went wrong. */
    return json({ enabled: false, room: null, serverNow: Date.now() });
  }

  const room = await env.MARKETPLACE.get('mc_room_' + pointer.code, 'json');
  if (!room) {
    /* The room expired or was closed while the panel was still pointed at
       it. Same answer as switched off: show nothing. */
    return json({ enabled: true, code: pointer.code, room: null, serverNow: Date.now() });
  }

  return json({
    enabled: true,
    code: pointer.code,
    room: viewFor(room, null, Date.now(), { dice: true }),
    serverNow: Date.now(),
  });
}

export async function onRequestPost(context) {
  const { env, request } = context;

  const { isModerator } = await import('../admin/moderators.js');
  const session = getSession(request);
  if (!(await isModerator(env, session))) {
    return json({ error: 'You need broadcaster or moderator access for this.' }, 403);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  if (body.action === 'off') {
    await env.MARKETPLACE.put(KEY, JSON.stringify({ enabled: false, code: null, at: Date.now() }), {
      expirationTtl: POINTER_TTL,
    });
    return json({ success: true, enabled: false, code: null });
  }

  if (body.action === 'show') {
    const code = String(body.code || '').toUpperCase().trim();
    if (!code) return json({ error: 'Pick a room first.' }, 400);

    /* Checked before it is stored, so a typo is answered here rather than
       by an empty panel on stream that nobody can explain. */
    const room = await env.MARKETPLACE.get('mc_room_' + code, 'json');
    if (!room) return json({ error: `No Mana Clash room ${code}. It may have expired.` }, 404);

    await env.MARKETPLACE.put(KEY, JSON.stringify({
      enabled: true, code, at: Date.now(), by: session.display_name || '',
    }), { expirationTtl: POINTER_TTL });

    return json({ success: true, enabled: true, code, status: room.status });
  }

  return json({ error: 'Invalid action' }, 400);
}
