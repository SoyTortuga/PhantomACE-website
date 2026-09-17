/* ══════════════════════════════════════════════
   /api/room — somebody's rooms

   GET  ?id=<userId>       the room their profile shows, or the empty
                           default if they have not built one. Public.
   GET  ?mine=1            all of the session's rooms, which is public,
                           the categories they have unlocked, and how
                           many rooms they may keep.
   POST { index, room }    validate and save one room.
   POST { action: 'public', index }   choose which room the profile shows.
   POST { action: 'clear',  index }   reset one room to the default.

   The document is rooms_<userId> through the KV shim, written whole under
   mutate() so two tabs saving at once cannot interleave. Every write goes
   through validateRoom() first, against the catalog, the caps, and what
   the inventory says the person has unlocked; a refused save is refused
   whole, with the reason.
   ══════════════════════════════════════════════ */

import {
  validateRoom, defaultRoom, ownedCategories, ownedPieces, roomSlots, DEFAULT_SIZE,
} from './room-catalog.js';

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

function parseUserId(raw) {
  const s = String(raw == null ? '' : raw).trim();
  return /^[0-9]{1,20}$/.test(s) ? s : null;
}

/** The stored document, or a fresh one. Shape: { v, public, rooms }. */
function normaliseDoc(doc) {
  const rooms = doc && Array.isArray(doc.rooms) ? doc.rooms : [];
  const pub = doc && Number.isInteger(doc.public) && doc.public >= 0 && doc.public < rooms.length ? doc.public : 0;
  return { v: 1, public: pub, rooms };
}

async function loadInventory(env, userId) {
  try { return await env.MARKETPLACE.get(`inv_${userId}`, 'json'); } catch { return null; }
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const session = getSession(request);

  if (url.searchParams.get('mine')) {
    if (!session || !session.user_id) return json({ error: 'Log in first.' }, 401);
    const me = String(session.user_id);
    const [doc, inv] = await Promise.all([
      env.MARKETPLACE.get(`rooms_${me}`, 'json'),
      loadInventory(env, me),
    ]);
    const d = normaliseDoc(doc);
    const slots = roomSlots(inv);
    while (d.rooms.length < slots) d.rooms.push(defaultRoom(DEFAULT_SIZE));
    return json({
      rooms: d.rooms.slice(0, slots),
      public: Math.min(d.public, slots - 1),
      slots,
      owned: [...ownedCategories(inv)].sort(),
      /* Single pieces out of sets they do not own outright — the pass
         drips these, and the palette lights them inside a locked set. */
      ownedPieces: [...ownedPieces(inv)].sort(),
    });
  }

  const id = parseUserId(url.searchParams.get('id'));
  if (!id) return json({ error: 'There is nobody by that name.' }, 404);
  const profile = await env.MARKETPLACE.get(`profile_${id}`, 'json');
  if (!profile) return json({ error: 'There is nobody by that name.' }, 404);

  const doc = normaliseDoc(await env.MARKETPLACE.get(`rooms_${id}`, 'json'));
  const room = doc.rooms[doc.public] || null;
  return json({
    owner: { userId: id, login: profile.login || '', displayName: profile.displayName || profile.login || '' },
    name: `${profile.displayName || profile.login || 'Someone'}'s Room`,
    room: room || defaultRoom(DEFAULT_SIZE),
    empty: !room,
    viewer: { isOwner: !!session && String(session.user_id) === id },
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const session = getSession(request);
  if (!session || !session.user_id) return json({ error: 'Log in first.' }, 401);
  const me = String(session.user_id);

  let payload;
  try { payload = await request.json(); } catch { return json({ error: 'Bad request' }, 400); }
  if (!payload || typeof payload !== 'object') return json({ error: 'Bad request' }, 400);

  const inv = await loadInventory(env, me);
  const slots = roomSlots(inv);
  const index = Number.isInteger(payload.index) ? payload.index : 0;
  if (index < 0 || index >= slots) return json({ error: 'You do not have that room.' }, 403);

  if (payload.action === 'public') {
    const after = await env.MARKETPLACE.mutate(`rooms_${me}`, (doc) => {
      const d = normaliseDoc(doc);
      while (d.rooms.length <= index) d.rooms.push(defaultRoom(DEFAULT_SIZE));
      d.public = index;
      return d;
    });
    return json({ ok: true, public: after.public });
  }

  if (payload.action === 'clear') {
    await env.MARKETPLACE.mutate(`rooms_${me}`, (doc) => {
      const d = normaliseDoc(doc);
      while (d.rooms.length <= index) d.rooms.push(defaultRoom(DEFAULT_SIZE));
      d.rooms[index] = defaultRoom(DEFAULT_SIZE);
      return d;
    });
    return json({ ok: true, room: defaultRoom(DEFAULT_SIZE) });
  }

  const owned = ownedCategories(inv);
  const v = validateRoom(payload.room, owned, ownedPieces(inv));
  if (!v.ok) return json({ error: v.error }, 400);
  const room = { ...v.room, updatedAt: Date.now() };

  await env.MARKETPLACE.mutate(`rooms_${me}`, (doc) => {
    const d = normaliseDoc(doc);
    while (d.rooms.length <= index) d.rooms.push(defaultRoom(DEFAULT_SIZE));
    d.rooms[index] = room;
    return d;
  });
  return json({ ok: true, room });
}
