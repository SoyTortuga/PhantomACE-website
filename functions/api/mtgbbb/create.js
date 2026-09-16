/* ══════════════════════════════════════════════
   MTGBBB CREATE — a moderator opens a room.

   FROZEN AT CREATION, not referenced live: the pool (25+ card names, images,
   rarities) and the treatment table are copied into the room as it is built,
   not re-read from the mtgbbb_set_ cache on every poll. That cache can never
   change for a given DATA_VERSION today, but a future version bump would
   rebuild it out from under a room that is mid-game — and the plan's own
   rule is that nothing may move under a live game. Snapshotting once here is
   what makes that true regardless of what step 2's cache does later.

   AUTHORIZATION: moderator or broadcaster, matching "run a room" in the
   plan's namespace section — not "anyone with a login" the way Commander
   Bingo allows hosting. MTGBBB rooms award real giveaway entries, same as
   bingo's award.js, so opening one is not open to just anybody.
   ══════════════════════════════════════════════ */

import { loadSetData, unplayableReason } from '../mtgbbb-scryfall.js';

const GAME_TTL = 14400; // 4h, matching bingo_/mc_room_/ps_room_
const PACK_SIZE = 30;
const MAX_BOXES = 12;

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
    return json({ error: 'Only the broadcaster and moderators can open a game.' }, 403);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  const code = String(body.code || '').toUpperCase().trim();
  if (!code || code.length < 3 || code.length > 6 || !/^[A-Z0-9]+$/.test(code)) {
    return json({ error: 'Code must be 3-6 letters or numbers.' }, 400);
  }

  const setCode = String(body.setCode || '').trim().toLowerCase();
  if (!/^[a-z0-9]{3,6}$/.test(setCode)) return json({ error: 'Unknown set.' }, 400);

  /* parseInt() alone would silently floor 2.5 to 2 rather than refusing it,
     so a string is only accepted if it is nothing but digits. */
  let boxes;
  if (typeof body.boxes === 'number') boxes = body.boxes;
  else if (typeof body.boxes === 'string' && /^\d+$/.test(body.boxes.trim())) boxes = parseInt(body.boxes, 10);
  else boxes = NaN;
  if (!Number.isInteger(boxes) || boxes < 1 || boxes > MAX_BOXES) {
    return json({ error: `Boxes must be a whole number from 1 to ${MAX_BOXES}.` }, 400);
  }

  /* Product is fixed. Collector Booster shows in the dropdown client-side
     and is disabled there — this is the server refusing it too, since the
     client check alone is not a security boundary. */
  const product = String(body.product || 'play');
  if (product !== 'play') {
    return json({ error: 'Only Play Booster boxes are supported right now.' }, 400);
  }

  const key = `mtgbbb_${code}`;
  const existing = await env.MARKETPLACE.get(key);
  if (existing) return json({ error: 'Code already in use' }, 409);

  let data;
  try {
    data = await loadSetData(env, setCode);
  } catch (err) {
    const status = err && err.status === 404 ? 404 : 502;
    return json({
      error: status === 404 ? 'Scryfall has no such set.' : 'Could not reach Scryfall. Try again in a moment.',
    }, status);
  }

  /* Same guard sets.js applies, checked again here because the moderator's
     dropdown selection and the actual room creation are two separate
     requests — nothing stops a stale or hand-crafted one from skipping the
     first check. */
  if (!data.playable) {
    return json({ error: unplayableReason(data), set: data.code, playable: false }, 422);
  }

  const allIds = new Set(data.treatments.map(t => t.id));
  let treatmentIds;
  if (Array.isArray(body.treatments)) {
    treatmentIds = [...new Set(body.treatments.map(String))];
    const unknown = treatmentIds.find(id => !allIds.has(id));
    if (unknown) return json({ error: `Unknown treatment: ${unknown}` }, 400);
  } else {
    /* Default: every non-collector-only treatment starts ticked. The
       moderator adjusts from here before the room is created; nothing
       adjusts it afterward. */
    treatmentIds = data.treatments.filter(t => !t.collectorOnly).map(t => t.id);
  }
  const treatmentIdSet = new Set(treatmentIds);
  const treatments = data.treatments.filter(t => treatmentIdSet.has(t.id));

  /* Call-your-shot defaults OFF. The plan itself flags the code volume as
     unresolved product judgement, not an engineering question — a common
     shot lands ~14 codes per 60-player box — so a brand-new feature that
     spends real giveaway codes should not turn itself on silently. A cap
     lets a host open it without an open-ended commitment. */
  const cysBody = (body.callYourShot && typeof body.callYourShot === 'object') ? body.callYourShot : {};
  const callYourShotEnabled = cysBody.enabled === true;
  let callYourShotCap = null;
  if (cysBody.cap !== undefined && cysBody.cap !== null) {
    const cap = Number.isInteger(cysBody.cap) ? cysBody.cap : parseInt(cysBody.cap, 10);
    if (!Number.isInteger(cap) || cap < 1) {
      return json({ error: 'Call-your-shot cap must be a positive whole number, or omitted for unlimited.' }, 400);
    }
    callYourShotCap = cap;
  }

  const room = {
    code,
    host: String(session.user_id),
    hostName: session.display_name || '',
    status: 'active',
    setCode: data.code,
    setName: data.name,
    setIcon: data.icon,
    boxes,
    product,
    packCount: boxes * PACK_SIZE,
    packsOpened: 0,
    pool: data.cards,
    treatments,
    players: [],
    pulls: [],
    nextPullId: 1,
    prizes: [],
    callYourShot: { enabled: callYourShotEnabled, cap: callYourShotCap },
    shots: [],
    createdAt: Date.now(),
  };

  await env.MARKETPLACE.put(key, JSON.stringify(room), { expirationTtl: GAME_TTL });

  /* The overlay's only way to find a live game without a per-stream OBS URL
     edit. Best-effort: a miss here costs the overlay panel, not the room —
     the game is fully playable either way. */
  try {
    await env.MARKETPLACE.put('mtgbbb_current', JSON.stringify({
      code, setName: room.setName, startedAt: room.createdAt,
    }));
  } catch (err) {
    console.error('[mtgbbb/create] could not set mtgbbb_current:', err.message);
  }

  return json({
    success: true, code, setName: room.setName, boxes, packCount: room.packCount,
    treatments, poolSize: room.pool.length, callYourShot: room.callYourShot,
  });
}
