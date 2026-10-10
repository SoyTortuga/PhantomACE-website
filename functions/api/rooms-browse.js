/* ══════════════════════════════════════════════
   ROOM CRAWL  (Community epic C3)

     GET  /api/rooms-browse                — the gallery of opted-in parks
     GET  /api/rooms-browse?u=<login>      — one keeper's public park
     GET  /api/rooms-browse?id=<userId>    — same, by numeric id
     POST /api/rooms-browse                — guestbook stamp / haunted entry /
                                             Room of the Week (broadcaster)

   This is a READER over Dino Park saves, not a second store of parks. A park
   is "public" for the gallery exactly when its owner has opted into visiting
   in the game — the same `parkpub_` consent row dino-park.js writes — so there
   is ONE opt-in with one meaning and no second flag to drift out of sync.

   WHAT A VISITOR RECEIVES IS A PROJECTION, NOT THE SAVE. The park save is
   client-written and stored wholesale, so every field in it is attacker-
   controlled. The single-room view echoes it through dino-park.js's own
   projectPark() — the same whitelist the in-game visit view already uses — so
   nicknames are capped, positions are clamped, and a field added to the save
   later is private until someone projects it on purpose. The favourite dino
   is echoed the way profile.js echoes it (already sanitised on save); the
   client still escapes its text and validates its src.
   ══════════════════════════════════════════════ */

import { isBroadcaster } from './admin/moderators.js';
import { projectPark, VISIT_KEY_PREFIX, visitKey } from './dino-park.js';
import { weekKey, monthKey } from './season-time.js';
import { softRead } from './soft-read.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

/* Anchored exactly like every other handler's cookie read, so a cookie whose
   name merely ends in pham_session cannot be mistaken for the real one. */
function getSession(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)pham_session=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match[1])); } catch { return null; }
}

const SAVE_PREFIX = 'dino_park_';
const guestbookKey = (ownerId) => `roomguestbook_${ownerId}`;
const visitsKey = (userId, wk) => `roomvisits_${userId}_${wk}`;
const hauntedKey = (mk) => `room_haunted_${mk}`;
const ROTW_KEY = 'room_of_week';

const GALLERY_MAX = 60;       /* a wall to browse, not every park ever opened */
const GUESTBOOK_MAX = 50;     /* newest 50 stamps; older ones drop off */
const VISITS_MAX = 60;        /* owner ids a visitor can bank in one week */
const HAUNTED_MAX = 500;      /* contest entrants in a month */
const VISITS_TTL = 14 * 86400;        /* the week's tally is quest fuel, not history */
const HAUNTED_TTL = 60 * 86400;       /* outlives the contest month, then clears */
const NAME_MAX = 40;
const NOTE_MAX = 80;
const ROTW_NOTE_MAX = 160;

const NUMERIC_ID = /^[0-9]{1,20}$/;
const LOGIN_RE = /^[a-z0-9_]{1,30}$/;
const SAFE_ID = /^[a-z0-9_-]{1,40}$/i;

/* The fixed set of stamps a visitor can leave. A closed list, so the mark a
   guestbook can carry is chosen by this build, not by whoever posts. */
const STAMP_IDS = new Set([
  'skull', 'bat', 'pumpkin', 'ghost', 'candle', 'rose',
  'heart', 'star', 'crown', 'paw', 'flame', 'clover',
]);

/* A login maps to an id through the same index profile.js uses; a numeric id
   is taken as-is after a charset check. */
async function resolveUserId(env, id, login) {
  const rawId = String(id || '').trim();
  if (rawId) return NUMERIC_ID.test(rawId) ? rawId : null;
  const l = String(login || '').trim().toLowerCase();
  if (!LOGIN_RE.test(l)) return null;
  const mapped = await env.MARKETPLACE.get(`loginidx_${l}`);
  return mapped ? String(mapped).trim() : null;
}

/* The favourite dino as the gallery card needs it — enough to draw the sprite
   and name it, and no inline portrait, so a wall of cards stays light. Echoed,
   not re-validated: sanitizeFavorite already ran on save (see dino-park.js). */
function favoriteCard(fav) {
  if (!fav || typeof fav !== 'object' || !fav.specId || !fav.src) return null;
  return {
    specId: fav.specId,
    mutation: fav.mutation || '',
    nickname: fav.nickname || '',
    src: fav.src,
    filter: fav.filter || '',
  };
}

/* The full favourite, as the single-room view shows it — same fields
   profile.js echoes for a public profile. */
function favoriteFull(fav) {
  if (!fav || typeof fav !== 'object' || !fav.specId || !fav.src) return null;
  return {
    specId: fav.specId,
    mutation: fav.mutation || '',
    nickname: fav.nickname || '',
    src: fav.src,
    filter: fav.filter || '',
    portrait: fav.portrait || '',
    portraitFilter: fav.portraitFilter || '',
    species: fav.species || '',
    rarity: fav.rarity || '',
    diet: fav.diet || '',
    habitat: fav.habitat || '',
    era: fav.era || '',
    build: fav.build || '',
    desc: fav.desc || '',
    mutationLabel: fav.mutationLabel || '',
  };
}

/* The one-line summary under a gallery card. Counts and ids only — never the
   roster itself; that is what the single-room view is for. */
function summarize(state) {
  const s = (state && typeof state === 'object') ? state : {};
  return {
    parkCount: Array.isArray(s.park) ? s.park.length : 0,
    species: Array.isArray(s.discovered) ? s.discovered.length : 0,
    day: Math.max(1, Math.min(100000, Math.floor(Number(s.parkDay) || 1))),
    background: SAFE_ID.test(String(s.background || '')) ? String(s.background) : '',
  };
}

/* Where the Room of the Week record is read, and shaped the same whether it
   came back as the stored singleton or is absent. */
async function readFeatured(env) {
  const rec = await softRead(env.MARKETPLACE.get(ROTW_KEY, 'json'), ROTW_KEY);
  if (!rec || !rec.ownerId) return null;
  return {
    ownerId: String(rec.ownerId),
    ownerName: String(rec.ownerName || 'A keeper').slice(0, NAME_MAX),
    avatar: String(rec.avatar || ''),
    note: String(rec.note || '').slice(0, ROTW_NOTE_MAX),
    weekKey: String(rec.weekKey || ''),
    setAt: Number(rec.setAt) || 0,
  };
}

/* The set of owner ids tagged into this month's haunted contest. */
async function readHaunted(env, mk) {
  const rec = await softRead(env.MARKETPLACE.get(hauntedKey(mk), 'json'), hauntedKey(mk));
  const ids = Array.isArray(rec && rec.owners) ? rec.owners.map(String) : [];
  return new Set(ids);
}

/* ── GET ────────────────────────────────────────────────────────────── */

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const session = getSession(request);

  const idParam = url.searchParams.get('id');
  const uParam = url.searchParams.get('u');
  if (idParam || uParam) return viewRoom(env, session, idParam, uParam);

  return gallery(env, session);
}

/**
 * The gallery.
 *
 * ONE prefix scan, then a keyed read per park that is actually on the wall.
 * The `parkpub_` consent rows say WHICH parks are public and carry the
 * owner's name and avatar; they stay a listValues scan because they are small
 * by design, which is the whole reason consent lives outside the save
 * document rather than inside one the client rewrites wholesale.
 *
 * The SAVES used to be scanned the same way, and that was the expensive
 * mistake: listValues selects the whole jsonb value, so it loaded a complete
 * park document -- tilemaps, decor arrays, rosters -- for every player who
 * has ever opened Dino Park, and the loop then discarded every one without a
 * consent row. The wall is opt-in, so nearly all of it was read to be thrown
 * away. Consent is known first, so only those saves are fetched, in parallel.
 *
 * Public by design: a logged-out viewer browses the same wall.
 */
async function gallery(env, session) {
  const [consentRows, featured, mk] = await Promise.all([
    env.MARKETPLACE.listValues({ prefix: VISIT_KEY_PREFIX }),
    readFeatured(env),
    Promise.resolve(monthKey()),
  ]);

  const consent = new Map();
  for (const { name, value } of consentRows) {
    const id = name.slice(VISIT_KEY_PREFIX.length);
    if (!NUMERIC_ID.test(id) || !value) continue;
    consent.set(id, {
      name: String(value.name || 'A keeper').slice(0, NAME_MAX),
      avatar: String(value.avatar || ''),
      since: Number(value.since) || 0,
    });
  }

  /* Only the parks on the wall, by key. One unreadable save drops that one
     card rather than the whole gallery — the same tolerance the single-park
     route shows, and softRead says in the log which save it was. */
  const ids = [...consent.keys()];
  const [haunted, saves] = await Promise.all([
    readHaunted(env, mk),
    Promise.all(ids.map(id =>
      softRead(env.MARKETPLACE.get(`${SAVE_PREFIX}${id}`, 'json'), `${SAVE_PREFIX}${id}`))),
  ]);

  const rooms = [];
  ids.forEach((id, i) => {
    const value = saves[i];
    if (!value) return;                          /* opted in, nothing saved yet */
    const meta = consent.get(id);
    const state = value.state;
    rooms.push({
      id,
      owner: meta.name,
      avatar: meta.avatar,
      summary: summarize(state),
      favorite: favoriteCard(state && state.favorite),
      haunted: haunted.has(id),
      savedAt: Number(value.savedAt) || 0,
    });
  });

  /* Active first: a park someone still tends is a better visit than one left
     a year ago. Ties fall back to the save id for a stable order. */
  rooms.sort((a, b) => (b.savedAt - a.savedAt) || (a.id < b.id ? -1 : 1));

  return json({
    rooms: rooms.slice(0, GALLERY_MAX),
    total: rooms.length,
    featured,
    haunted: { month: mk, count: haunted.size },
    you: { loggedIn: !!(session && session.user_id) },
  });
}

/**
 * One keeper's public park.
 *
 * Consent is checked BEFORE the save is read, the same order dino-park.js
 * uses: a park that is not open never has its document loaded. A logged-out
 * viewer may look (these are opt-in public rooms the gallery already lists);
 * only a logged-in viewer's visit is tallied for the quest.
 */
async function viewRoom(env, session, idParam, uParam) {
  const userId = await resolveUserId(env, idParam, uParam);
  if (!userId) return json({ error: 'No such room' }, 404);

  const pass = await softRead(env.MARKETPLACE.get(visitKey(userId), 'json'), visitKey(userId));
  if (!pass) return json({ error: 'That park is not open to visitors.' }, 403);

  const record = await softRead(env.MARKETPLACE.get(`${SAVE_PREFIX}${userId}`, 'json'), `${SAVE_PREFIX}${userId}`);
  if (!record || !record.state) return json({ error: 'That park is empty.' }, 404);

  const mk = monthKey();
  const [guestbookRec, haunted] = await Promise.all([
    softRead(env.MARKETPLACE.get(guestbookKey(userId), 'json'), guestbookKey(userId)),
    readHaunted(env, mk),
  ]);

  const viewerId = session && session.user_id ? String(session.user_id) : null;
  /* Tally the visit for C2's "visit N rooms" quest. Best-effort on purpose:
     a failed write must never cost the viewer the page they asked for. */
  if (viewerId && viewerId !== String(userId)) {
    await recordVisit(env, viewerId, userId);
  }

  const projected = projectPark(record.state);
  return json({
    room: {
      id: String(userId),
      owner: String(pass.name || 'A keeper').slice(0, NAME_MAX),
      avatar: String(pass.avatar || ''),
      park: projected,
      favorite: favoriteFull(record.state.favorite),
      haunted: haunted.has(String(userId)),
    },
    guestbook: Array.isArray(guestbookRec && guestbookRec.stamps) ? guestbookRec.stamps : [],
    you: {
      loggedIn: !!viewerId,
      isOwner: viewerId === String(userId),
      canStamp: !!viewerId,
    },
  });
}

/* Bank one owner id into the visitor's weekly set, once. Returns without
   writing when it is already there, so a re-visit does not re-count. */
async function recordVisit(env, viewerId, ownerId) {
  const wk = weekKey();
  try {
    await env.MARKETPLACE.mutate(visitsKey(viewerId, wk), (cur) => {
      const owners = Array.isArray(cur && cur.owners) ? cur.owners.map(String) : [];
      if (owners.includes(String(ownerId))) return undefined;    /* already counted */
      const next = [...owners, String(ownerId)].slice(-VISITS_MAX);
      /* `owners` is the dedupe set; `count` is the plain number quests.js
         (C2) reads to score the "visit N rooms" quest — both kept in step. */
      return { owners: next, count: next.length, weekKey: wk, updatedAt: Date.now() };
    }, { expirationTtl: VISITS_TTL });
  } catch (e) { /* best-effort: the quest tally is never worth a failed view */ }
}

/* ── POST ───────────────────────────────────────────────────────────── */

export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }
  if (!body || typeof body !== 'object') return json({ error: 'Invalid request' }, 400);

  const action = body.action;
  if (action === 'guestbook') return stampGuestbook(env, session, body);
  if (action === 'haunted')   return setHaunted(env, session, body);
  if (action === 'room-of-week') return setRoomOfWeek(env, session, body);
  return json({ error: 'Unknown action' }, 400);
}

/**
 * Leave a stamp in a keeper's guestbook.
 *
 * A login is required, the stamp is from the fixed set, the note is capped,
 * and the visitor's name/avatar come from the SESSION — never the body — so
 * nobody signs under someone else's name. One stamp per visitor: a second
 * stamp replaces the first rather than stacking, and the list is capped so it
 * can never grow without bound. Only a park that is public can be signed.
 */
async function stampGuestbook(env, session, body) {
  if (!session || !session.user_id) return json({ error: 'Log in to leave a stamp.' }, 401);

  const ownerId = await resolveUserId(env, body.ownerId, body.u);
  if (!ownerId) return json({ error: 'No such room' }, 404);

  const pass = await softRead(env.MARKETPLACE.get(visitKey(ownerId), 'json'), visitKey(ownerId));
  if (!pass) return json({ error: 'That park is not open to visitors.' }, 403);

  const stamp = String(body.stamp || '');
  if (!STAMP_IDS.has(stamp)) return json({ error: 'Pick a stamp.' }, 400);
  const note = String(body.note || '').trim().slice(0, NOTE_MAX);

  const visitorId = String(session.user_id);
  const entry = {
    id: visitorId,
    name: String(session.display_name || 'A keeper').slice(0, NAME_MAX),
    avatar: typeof session.profile_image === 'string' ? session.profile_image.slice(0, 300) : '',
    stamp,
    note,
    at: Date.now(),
  };

  let stamps = [];
  await env.MARKETPLACE.mutate(guestbookKey(ownerId), (cur) => {
    const prev = Array.isArray(cur && cur.stamps) ? cur.stamps : [];
    /* Dedupe by visitor, newest wins, bounded. Replace-children, never append
       without a cap — an unbounded guestbook is a storage leak with a bow on it. */
    const kept = prev.filter(s => s && String(s.id) !== visitorId);
    stamps = [...kept, entry].slice(-GUESTBOOK_MAX);
    return { stamps, updatedAt: Date.now() };
  });

  return json({ success: true, stamps });
}

/**
 * Tag (or untag) the CALLER'S OWN room as a haunted-room contest entry for
 * the current month. A login is required and the room must be public — a
 * contest entry has to be a room people can actually come and judge. The id
 * added is always the session's own; you cannot enter someone else's park.
 */
async function setHaunted(env, session, body) {
  if (!session || !session.user_id) return json({ error: 'Log in to enter.' }, 401);
  const me = String(session.user_id);

  const pass = await softRead(env.MARKETPLACE.get(visitKey(me), 'json'), visitKey(me));
  if (!pass) return json({ error: 'Open your park to visitors before entering the contest.' }, 403);

  const mk = monthKey();
  const enter = body.enter !== false;        /* default true; explicit false withdraws */
  let owners = [];
  await env.MARKETPLACE.mutate(hauntedKey(mk), (cur) => {
    const prev = Array.isArray(cur && cur.owners) ? cur.owners.map(String) : [];
    const without = prev.filter(id => id !== me);
    owners = enter ? [...without, me].slice(-HAUNTED_MAX) : without;
    return { owners, month: mk, updatedAt: Date.now() };
  }, { expirationTtl: HAUNTED_TTL });

  return json({ success: true, entered: owners.includes(me), month: mk });
}

/**
 * Set — or clear — the Room of the Week. Broadcaster only: handing the whole
 * site a featured room is not a delegated power. The featured park must be
 * public, and its name/avatar are taken from the consent row, not the body.
 */
async function setRoomOfWeek(env, session, body) {
  if (!isBroadcaster(env, session)) return json({ error: 'Broadcaster only' }, 403);

  if (body.clear) {
    await env.MARKETPLACE.delete(ROTW_KEY);
    return json({ success: true, featured: null });
  }

  const ownerId = await resolveUserId(env, body.ownerId, body.u);
  if (!ownerId) return json({ error: 'No such room' }, 404);

  const pass = await softRead(env.MARKETPLACE.get(visitKey(ownerId), 'json'), visitKey(ownerId));
  if (!pass) return json({ error: 'That park is not open to visitors.' }, 403);

  const record = {
    ownerId: String(ownerId),
    ownerName: String(pass.name || 'A keeper').slice(0, NAME_MAX),
    avatar: String(pass.avatar || ''),
    note: String(body.note || '').trim().slice(0, ROTW_NOTE_MAX),
    weekKey: weekKey(),
    setBy: String(session.user_id),
    setAt: Date.now(),
  };
  await env.MARKETPLACE.put(ROTW_KEY, JSON.stringify(record));
  return json({ success: true, featured: await readFeatured(env) });
}
