/* ══════════════════════════════════════════════
   OVERLAY LAYOUT — named presets, one live at a time.

     GET  /api/overlay/layout          the ACTIVE preset's positions (public)
     GET  /api/overlay/layout?full=1   every preset (staff only, for the editor)
     POST /api/overlay/layout          save | activate | delete | reset (staff)

   The broadcaster keeps several layouts — "Just Chatting", "Gaming",
   "Bingo night" — and swaps which is live as the stream's needs change. The
   live overlay always reads the ACTIVE preset, so a swap plus a reload puts
   the new arrangement on air with no OBS edits.

   Stored as { active, presets: { name: { panels } } }. A pre-preset save
   (a bare { panels }) is migrated on read into a single "Default" preset, so
   nothing that was already arranged is lost.

   Positions are top-left corners as PERCENTAGES of the 1920×1080 canvas, so
   a layout holds whether the OBS source is 1080p or 720p. GET is public (the
   overlay has no session); saving is staff, and only known panel ids and
   clamped coordinates are ever stored.
   ══════════════════════════════════════════════ */

import { isModerator, isBroadcaster } from '../admin/moderators.js';

const KEY = 'overlay_layout';
const MAX_PRESETS = 12;
const NAME_MAX = 40;

/* Must match overlay-samples.js PANELS — the ids the editor drags and the
   live overlay pins. A save naming anything else is dropped, not stored. */
const PANEL_IDS = [
  'ovStage', 'ovHatch', 'ovScramble', 'ovMaze', 'ovMtg', 'ovRaid', 'ovBingo',
  'ovMc', 'ovCheckin', 'ovPrediction',
  /* Twitch-driven, so they arrive mid-anything and are the likeliest to
     collide with another panel. */
  'ovHype', 'ovAdBreak', 'ovAdWarning',
  // stream night modes
  'ovTithe', 'ovVsc', 'ovWind', 'ovSafari', 'ovBracket', 'ovDrum',
  'ovMtgGuess', 'ovR6Draft', 'ovVote', 'ovBingoChat', 'ovMemChat',
];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function getSession(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)pham_session=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match[1])); } catch { return null; }
}

function clampPct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  /* 0–96 rather than 0–100: a panel pinned at 100% would sit one pixel
     on-screen. The cap keeps a dragged corner inside the canvas. */
  return Math.max(0, Math.min(96, Math.round(n * 100) / 100));
}

/* Scale is a multiplier on the panel's natural size. Bounded 0.3–3: small
   enough to tuck a panel into a corner, large enough to feature one, never
   so extreme a fat-fingered drag makes it unrecoverable or off-screen.
   Absent means 1 — the layout is scale-optional per panel. */
function clampScale(v) {
  if (v === undefined || v === null) return 1;
  const n = Number(v);
  if (!Number.isFinite(n)) return 1;
  return Math.max(0.3, Math.min(3, Math.round(n * 1000) / 1000));
}

/** Validate a submitted panel map down to what may be stored, or explain. */
export function validatePanels(raw) {
  if (!raw || typeof raw !== 'object') return { error: 'No panels given.' };
  const panels = {};
  for (const [id, pos] of Object.entries(raw)) {
    if (!PANEL_IDS.includes(id)) continue;             // unknown id: dropped
    if (!pos || typeof pos !== 'object') continue;
    const x = clampPct(pos.x), y = clampPct(pos.y);
    /* A hidden panel is removed from this preset — the live overlay forces it
       off regardless of whether its game is running. It keeps its position so
       un-hiding restores where it sat. A hidden panel needs no position. */
    if (pos.hidden) {
      panels[id] = (x !== null && y !== null) ? { x, y, s: clampScale(pos.s), hidden: true } : { hidden: true };
      continue;
    }
    if (x === null || y === null) continue;            // unpositioned, not hidden: skip
    panels[id] = { x, y, s: clampScale(pos.s) };
  }
  if (!Object.keys(panels).length) return { error: 'No valid panel positions.' };
  return { panels };
}

function cleanName(n) {
  const s = String(n == null ? '' : n).trim().slice(0, NAME_MAX);
  return s;
}

/* Normalise storage to { active, presets } — migrating a pre-preset
   { panels } record into a single "Default" preset so nothing is lost. */
function normalizeDoc(rec) {
  if (rec && rec.presets && typeof rec.presets === 'object') {
    const active = rec.active && rec.presets[rec.active] ? rec.active : (Object.keys(rec.presets)[0] || '');
    /* A fallback naming a deleted preset is dropped rather than kept dangling. */
    const fallback = rec.fallback && rec.presets[rec.fallback] ? rec.fallback : '';
    return { active, presets: rec.presets, fallback, updatedAt: Number(rec.updatedAt) || 0 };
  }
  if (rec && rec.panels && typeof rec.panels === 'object' && Object.keys(rec.panels).length) {
    return { active: 'Default', fallback: '', updatedAt: Number(rec.updatedAt) || 0,
      presets: { Default: { panels: rec.panels, updatedAt: rec.updatedAt, updatedBy: rec.updatedBy } } };
  }
  return { active: '', presets: {}, fallback: '', updatedAt: 0 };
}

function activePanels(doc) {
  const p = doc.presets[doc.active];
  return (p && p.panels) || {};
}

async function saveDoc(env, doc) {
  /* updatedAt doubles as the layout VERSION. Every change bumps it -- a
     preset edit AND a plain activate -- so the live overlay can watch one
     number on its poll and re-apply only when something actually moved. */
  const updatedAt = Math.max(Date.now(), (Number(doc.updatedAt) || 0) + 1);
  await env.MARKETPLACE.put(KEY, JSON.stringify({
    active: doc.active, presets: doc.presets, fallback: doc.fallback || '', updatedAt,
  }));
  doc.updatedAt = updatedAt;
  return updatedAt;
}

/** The layout version, for the events poll. Cheap: one read, no Twitch call. */
export async function layoutVersion(env) {
  const doc = normalizeDoc(await env.MARKETPLACE.get(KEY, 'json'));
  return { ver: doc.updatedAt || 0, active: doc.active || '' };
}

/**
 * Make the preset BOUND to a Twitch category live. Called by the
 * channel.update webhook when the category moves.
 *
 * Matching is case- and whitespace-insensitive, so "music" binds "Music".
 * With no binding for the new category the FALLBACK preset takes over (if one
 * is set), which is what stops a game overlay outstaying its game; with no
 * fallback either, whatever is live is left alone rather than blanked.
 */
export async function activateForCategory(env, categoryName) {
  const want = String(categoryName == null ? '' : categoryName).trim().toLowerCase();
  const doc = normalizeDoc(await env.MARKETPLACE.get(KEY, 'json'));

  let target = '';
  if (want) {
    for (const [name, preset] of Object.entries(doc.presets)) {
      const bound = String((preset && preset.category) || '').trim().toLowerCase();
      if (bound && bound === want) { target = name; break; }
    }
  }
  const matched = !!target;
  if (!target && doc.fallback && doc.presets[doc.fallback]) target = doc.fallback;

  if (!target || target === doc.active) return { changed: false, active: doc.active, matched };
  doc.active = target;
  await saveDoc(env, doc);
  return { changed: true, active: target, matched };
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const doc = normalizeDoc(await env.MARKETPLACE.get(KEY, 'json'));

  /* A staff flag for the editor's cosmetic gate — the POST is the real
     guard. Costs one lookup and only when a session is present. */
  let staff = false;
  const session = getSession(request);
  if (session && session.user_id) staff = isBroadcaster(env, session) || await isModerator(env, session);

  /* The editor asks for every preset; everyone else (the live overlay) gets
     only the active one's panels, in the shape apply-layout already reads. */
  if (staff && new URL(request.url).searchParams.get('full')) {
    return json({ full: true, active: doc.active, presets: doc.presets, fallback: doc.fallback || '', staff: true });
  }
  return json({
    panels: activePanels(doc),
    active: doc.active,
    presets: Object.keys(doc.presets),
    ver: doc.updatedAt || 0,
    staff,
  });
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);
  if (!session || !session.user_id) return json({ error: 'Log in first.' }, 401);

  if (!isBroadcaster(env, session) && !(await isModerator(env, session))) {
    return json({ error: 'The overlay layout is for the broadcaster and moderators.' }, 403);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  const doc = normalizeDoc(await env.MARKETPLACE.get(KEY, 'json'));
  const by = String(session.display_name || session.user_id).slice(0, 40);
  const ok = (extra) => json(Object.assign({ success: true, active: doc.active, presets: Object.keys(doc.presets) }, extra || {}));

  /* ── Make a named preset live ── */
  if (body.action === 'activate') {
    const name = cleanName(body.name);
    if (!doc.presets[name]) return json({ error: 'No such preset.' }, 404);
    doc.active = name;
    await saveDoc(env, doc);
    return ok();
  }

  /* ── Bind a preset to a Twitch category (empty string unbinds) ── */
  if (body.action === 'bind') {
    const name = cleanName(body.name);
    if (!doc.presets[name]) return json({ error: 'No such preset.' }, 404);
    const category = String(body.category == null ? '' : body.category).trim().slice(0, 80);
    /* One category binds one preset, or a switch would be a coin toss. */
    if (category) {
      const low = category.toLowerCase();
      for (const [other, p] of Object.entries(doc.presets)) {
        if (other !== name && String((p && p.category) || '').trim().toLowerCase() === low) {
          return json({ error: `"${category}" is already bound to the "${other}" preset.` }, 400);
        }
      }
    }
    doc.presets[name].category = category;
    await saveDoc(env, doc);
    return ok({ bound: { name, category } });
  }

  /* ── Set the preset used when no binding matches (empty clears it) ── */
  if (body.action === 'fallback') {
    const name = cleanName(body.name);
    if (name && !doc.presets[name]) return json({ error: 'No such preset.' }, 404);
    doc.fallback = name;
    await saveDoc(env, doc);
    return ok({ fallback: doc.fallback });
  }

  /* ── Delete a preset (active falls back to another) ── */
  if (body.action === 'delete') {
    const name = cleanName(body.name);
    if (!doc.presets[name]) return json({ error: 'No such preset.' }, 404);
    delete doc.presets[name];
    if (doc.active === name) doc.active = Object.keys(doc.presets)[0] || '';
    if (doc.fallback === name) doc.fallback = '';
    await saveDoc(env, doc);
    return ok();
  }

  /* ── Reset one preset's panels to the defaults (kept, just cleared) ── */
  if (body.action === 'reset') {
    const name = cleanName(body.name) || doc.active;
    if (name && doc.presets[name]) {
      const keepCat = doc.presets[name].category || '';
      doc.presets[name] = { panels: {}, category: keepCat, updatedAt: Date.now(), updatedBy: by };
    }
    await saveDoc(env, doc);
    return ok({ panels: {} });
  }

  /* ── Save (create or overwrite) a preset ── */
  if (body.action === 'save') {
    const name = cleanName(body.name) || doc.active || 'Default';
    if (!name) return json({ error: 'Name the preset.' }, 400);
    const isNew = !doc.presets[name];
    if (isNew && Object.keys(doc.presets).length >= MAX_PRESETS) {
      return json({ error: `That is the most presets allowed (${MAX_PRESETS}). Delete one first.` }, 400);
    }
    const checked = validatePanels(body.panels);
    if (checked.error) return json({ error: checked.error }, 400);
    /* Keep the category binding: a save rewrites the preset wholesale and
       would otherwise silently unbind it. */
    const keepCat = (doc.presets[name] && doc.presets[name].category) || '';
    doc.presets[name] = { panels: checked.panels, category: keepCat, updatedAt: Date.now(), updatedBy: by };
    if (!doc.active) doc.active = name;   /* first preset becomes live */
    await saveDoc(env, doc);
    return ok({ panels: checked.panels, saved: name });
  }

  return json({ error: 'Unknown action' }, 400);
}
