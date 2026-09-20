/* ══════════════════════════════════════════════
   OVERLAY LAYOUT — where each panel sits, saved once, read by every source.

     GET  /api/overlay/layout        the saved positions (public)
     POST /api/overlay/layout        { action: 'save', panels } | { action: 'reset' }, staff

   The overlay editor drags the real panels around a scaled 16:9 stage and
   saves their top-left corners here as PERCENTAGES of the 1920×1080 canvas.
   The live overlay reads this on boot and pins each panel to its saved
   spot. Percentages, not pixels, so a 1280×720 OBS source lands the panels
   in the same relative places as a 1080p one.

   GET IS PUBLIC on purpose: the overlay URL already carries the OBS key,
   positions are not a secret, and the overlay must read this without a
   session. Saving is staff, gated like every other editor here. Only known
   panel ids are stored and every coordinate is clamped to the canvas, so a
   malformed save can never push a panel off-screen or name a panel that
   does not exist.
   ══════════════════════════════════════════════ */

import { isModerator, isBroadcaster } from '../admin/moderators.js';

const KEY = 'overlay_layout';

/* Must match overlay-samples.js PANELS — the ids the editor drags and the
   live overlay pins. A save naming anything else is dropped, not stored. */
const PANEL_IDS = ['ovStage', 'ovScramble', 'ovMaze', 'ovMtg', 'ovBingo', 'ovMc'];

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
    if (x === null || y === null) continue;            // unpositioned: skip
    panels[id] = { x, y, s: clampScale(pos.s) };
  }
  if (!Object.keys(panels).length) return { error: 'No valid panel positions.' };
  return { panels };
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const rec = await env.MARKETPLACE.get(KEY, 'json');

  /* A staff flag for the editor's cosmetic gate — the POST is the real
     guard. Costs one lookup and only when a session is present. */
  let staff = false;
  const session = getSession(request);
  if (session && session.user_id) {
    staff = isBroadcaster(env, session) || await isModerator(env, session);
  }
  return json({ panels: (rec && rec.panels) || {}, staff });
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

  if (body.action === 'reset') {
    await env.MARKETPLACE.delete(KEY);
    return json({ success: true, panels: {} });
  }

  if (body.action !== 'save') return json({ error: 'Unknown action' }, 400);

  const checked = validatePanels(body.panels);
  if (checked.error) return json({ error: checked.error }, 400);

  await env.MARKETPLACE.put(KEY, JSON.stringify({
    panels: checked.panels,
    updatedAt: Date.now(),
    updatedBy: String(session.display_name || session.user_id).slice(0, 40),
  }));
  return json({ success: true, panels: checked.panels });
}
