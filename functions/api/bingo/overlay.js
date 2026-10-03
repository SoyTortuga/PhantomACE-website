import { refreshStreamNow, clearStreamNow } from '../stream-now.js';

const GAME_TTL = 14400;
const POINTER = 'bingo_current';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function getSession(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)pham_session=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match[1])); } catch { return null; }
}

const norm = (c) => (c ? String(c).toUpperCase().trim() : null);

/* ══════════════════════════════════════════════
   THE OVERLAY POINTER — shared by every bingo route.

   bingo_current is the ONE room the stream overlay follows:
     { code, at }              a live room is on the overlay
     { code: null, at }        nothing is (cleared from the dashboard)
     { code: null, ended, at } nothing is, but `ended` was on it when its
                               host ended the game — prizes are awarded
                               from the results screen AFTER the end, and
                               those win alerts still belong on stream.
   An absent row means nothing is on the overlay either.

   ALERTS FOLLOW THE POINTER, not the room's own flag. showOnOverlay alone
   was what call/award checked, so a room cleared from the dashboard — or
   replaced by another — kept its flag on and kept posting alerts.
   ══════════════════════════════════════════════ */

export async function readPointer(env) {
  try { return (await env.MARKETPLACE.get(POINTER, 'json')) || null; } catch { return null; }
}

/** The room code the overlay currently shows, or null. */
export function pointerCode(pointer) {
  return pointer ? norm(pointer.code) : null;
}

/**
 * May room `code` push an alert to the stream right now? Only the room the
 * pointer names (or, once ended, the room it named when it ended), and only
 * while its host has not switched it off.
 */
export function alertsAllowed(pointer, code, game) {
  if (!pointer || !game || game.showOnOverlay === false) return false;
  const c = norm(code);
  if (pointerCode(pointer) === c) return game.status !== 'ended';
  if (norm(pointer.ended) === c) return game.status === 'ended';
  return false;
}

/* Flip a room's own show flag. No TTL passed, so a room being switched OFF
   keeps its original expiry instead of being kept alive by this write. */
async function setRoomShown(env, code, show) {
  if (!code) return;
  try {
    await env.MARKETPLACE.mutate(`bingo_${code}`, (g) => {
      if (!g || g.showOnOverlay === show) return undefined;
      g.showOnOverlay = show;
      return g;
    });
  } catch (err) {
    console.error('[bingo/overlay] could not update room ' + code + ':', err.message);
  }
}

async function releaseRooms(env, prev, keep) {
  const olds = new Set([pointerCode(prev), norm(prev && prev.ended)]);
  for (const old of olds) {
    if (old && old !== keep) await setRoomShown(env, old, false);
  }
}

/** Point the overlay at `code`, switching off whichever room had it. */
export async function takeOverlay(env, code) {
  const c = norm(code);
  let prev = null;
  await env.MARKETPLACE.mutate(POINTER, (cur) => { prev = cur; return { code: c, at: Date.now() }; });
  await releaseRooms(env, prev, c);
  /* Put it on the unified "what's on stream" pointer too, so the overlay's one
     whatsOn read shows this game. Last-writer-wins replaces any other game. */
  await refreshStreamNow(env, { game: 'bingo', code: c });
}

/** Point the overlay at nothing, switching off whichever room had it. */
export async function clearOverlay(env) {
  let prev = null;
  await env.MARKETPLACE.mutate(POINTER, (cur) => {
    prev = cur;
    return cur ? { code: null, at: Date.now() } : undefined;
  });
  await releaseRooms(env, prev, null);
  /* Take bingo off the unified pointer immediately — but only if bingo is what
     it currently shows, so clearing bingo cannot blank another live game. */
  await clearStreamNow(env, 'bingo');
}

/** Take the pointer off `code` when its game ends — only if it still names it. */
export async function releaseOnEnd(env, code) {
  const c = norm(code);
  await env.MARKETPLACE.mutate(POINTER, (cur) => {
    if (!cur || pointerCode(cur) !== c) return undefined;
    return { code: null, ended: c, at: Date.now() };
  });
  /* Explicit end clears the unified pointer now (its "clear on end" path), but
     only if it still names THIS room. The post-end award alerts keep firing off
     bingo_current.ended above — they never read stream_now, so a null here does
     not suppress a final win alert. */
  await clearStreamNow(env, 'bingo', c);
}

/** Drop a pointer that names a room which no longer exists — only if it still does. */
export async function dropStalePointer(env, code) {
  const c = norm(code);
  await env.MARKETPLACE.mutate(POINTER, (cur) => {
    if (!cur || pointerCode(cur) !== c) return undefined;
    return { code: null, at: Date.now() };
  });
}

/**
 * SHOW ON OVERLAY — the switches for putting a game on the stream.
 *
 *   { code, show }          the host's own on/off for their room. Host or
 *                           staff. It can only take a room OFF the stream
 *                           in practice: a room the pointer does not name
 *                           posts nothing whatever its flag says.
 *   { code, makeCurrent }   point the overlay at this room. Staff only —
 *                           letting a host do it would let any logged-in
 *                           viewer put their room (and its alerts) on stream.
 *   { clear: true }         point the overlay at nothing. Staff only.
 */
export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);
  if (!session || !session.user_id) return json({ error: 'Log in first.' }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  const code = norm(body.code) || '';
  const makeCurrent = body.makeCurrent === true;
  const clear = body.clear === true || (makeCurrent && !code);

  const { isModerator } = await import('../admin/moderators.js');

  if (clear) {
    if (!(await isModerator(env, session))) {
      return json({ error: 'Only the broadcaster or a moderator can clear the overlay.' }, 403);
    }
    try { await clearOverlay(env); } catch (err) {
      console.error('[bingo/overlay] could not clear bingo_current:', err.message);
      return json({ error: 'Could not clear the overlay.' }, 500);
    }
    return json({ success: true, cleared: true, showOnOverlay: false });
  }

  if (!code) return json({ error: 'Missing code' }, 400);
  const key = `bingo_${code}`;

  if (makeCurrent) {
    if (!(await isModerator(env, session))) {
      return json({ error: 'Only the broadcaster or a moderator can put a game on the overlay.' }, 403);
    }
    let failure = null;
    await env.MARKETPLACE.mutate(key, (game) => {
      if (!game) { failure = json({ error: 'Game not found' }, 404); return undefined; }
      if (game.status !== 'active') {
        failure = json({ error: 'That game has ended — pick a running one.' }, 409);
        return undefined;
      }
      game.showOnOverlay = true;
      return game;
    }, { expirationTtl: GAME_TTL });
    if (failure) return failure;

    try { await takeOverlay(env, code); } catch (err) {
      console.error('[bingo/overlay] could not set bingo_current:', err.message);
      return json({ error: 'Could not point the overlay at that game.' }, 500);
    }
    return json({ success: true, makeCurrent: true, code, showOnOverlay: true });
  }

  const show = !!body.show;
  let failure = null;
  let isHost = false;
  const staff = await isModerator(env, session);
  await env.MARKETPLACE.mutate(key, (game) => {
    if (!game) { failure = json({ error: 'Game not found' }, 404); return undefined; }
    isHost = String(session.user_id) === String(game.host);
    if (!isHost && !staff) {
      failure = json({ error: 'Only the host, broadcaster, or a moderator can change the overlay.' }, 403);
      return undefined;
    }
    game.showOnOverlay = show;
    return game;
  }, { expirationTtl: GAME_TTL });
  if (failure) return failure;

  const pointer = await readPointer(env);
  return json({ success: true, showOnOverlay: show, isCurrent: pointerCode(pointer) === code });
}
