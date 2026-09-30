/* ══════════════════════════════════════════════
   CUSTOMIZABLE WHEEL

   The broadcaster configures a wheel (labels, weights, on-palette colours) and
   spins it on the overlay. The spin is a one-shot overlay reveal like the
   giveaway reel: this route weighted-picks the winner and pushes a 'wheel-spin'
   event; overlay.js draws the wheel, lands it on that segment, and self-clears.

   PALETTE IS LOCKED to the gothic identity. Segment fills come from a curated
   on-brand set (oxblood / charcoal / crimson / bone + a sanctioned gold), never
   a free colour picker — a rainbow wheel would break the site's look. The
   "customizable" part is labels, weights, segment count and choosing each
   segment's colour from that set. Labels render #fff on the fill, so every fill
   here is dark enough for white text (the "bone" fill is a DARK aged-bone, not
   the light parchment tone, for exactly that reason).

   Real route: exports onRequestGet/onRequestPost, so no NON_ROUTE_MODULES entry
   is needed. Staff-gated (isModerator) on every action.
   ══════════════════════════════════════════════ */

const CONFIG_KEY = 'wheel_config';
const WINNER_KEY = 'wheel_last_winner';

const MIN_SEGMENTS = 2;
const MAX_SEGMENTS = 12;
const LABEL_MAX = 24;
const WEIGHT_MAX = 1000;

/* Curated, on-palette segment fills. Keys are what the config stores and the
   dashboard offers; values are the hex the overlay fills with. All dark enough
   for #fff labels. `gold` is the sanctioned rarity/gold token. */
export const WHEEL_PALETTE = {
  oxblood:  '#6b0f0f',
  charcoal: '#1a1a1a',
  crimson:  '#b31217',
  bone:     '#4a4133',
  gold:     '#8a6d1a',
};
const DEFAULT_COLOR_ORDER = ['oxblood', 'charcoal', 'crimson', 'bone'];

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

/**
 * Validate a save request WITHOUT touching storage. Every rejection is
 * something the spin would also refuse, said before anything is written.
 * @returns {{error:string} | {segments:{label,weight,color}[]}}
 */
export function validateConfig(body) {
  const raw = Array.isArray(body && body.segments) ? body.segments : null;
  if (!raw) return { error: 'Send a segments array.' };

  const segments = [];
  for (const s of raw) {
    const label = String((s && s.label != null) ? s.label : '').trim();
    if (!label) continue;                         // blank rows dropped, then counted
    if (label.length > LABEL_MAX) return { error: `Each label is at most ${LABEL_MAX} characters.` };

    let weight = 1;
    if (s && s.weight !== undefined && s.weight !== null && s.weight !== '') {
      weight = Number(s.weight);
      if (!Number.isFinite(weight) || weight <= 0) return { error: `Weight must be a positive number ("${label}").` };
      if (weight > WEIGHT_MAX) return { error: `Weight is too large (max ${WEIGHT_MAX}).` };
    }

    let color = String((s && s.color != null) ? s.color : '').trim().toLowerCase();
    if (color && !WHEEL_PALETTE[color]) {
      return { error: `"${color}" is not an allowed colour. Pick one of: ${Object.keys(WHEEL_PALETTE).join(', ')}.` };
    }
    if (!color) color = DEFAULT_COLOR_ORDER[segments.length % DEFAULT_COLOR_ORDER.length];

    segments.push({ label, weight, color });
  }

  if (segments.length < MIN_SEGMENTS) return { error: `A wheel needs at least ${MIN_SEGMENTS} segments.` };
  if (segments.length > MAX_SEGMENTS) return { error: `A wheel allows at most ${MAX_SEGMENTS} segments.` };
  return { segments };
}

/**
 * Weighted pick over the segments — probability ∝ weight, via a cumulative
 * band walk (same method as the giveaway/monthly draw). rng injectable so the
 * weighting can be tested deterministically.
 */
export function pickWeighted(segments, rng = Math.random) {
  const list = Array.isArray(segments) ? segments : [];
  const total = list.reduce((s, x) => s + (Number(x.weight) > 0 ? Number(x.weight) : 1), 0);
  if (!list.length || total <= 0) return -1;
  let ticket = rng() * total;
  for (let i = 0; i < list.length; i++) {
    ticket -= (Number(list[i].weight) > 0 ? Number(list[i].weight) : 1);
    if (ticket < 0) return i;
  }
  return list.length - 1;
}

async function loadConfig(env) {
  const rec = await env.MARKETPLACE.get(CONFIG_KEY, 'json');
  return rec && Array.isArray(rec.segments) ? rec : null;
}

/* ── GET — the saved wheel + palette, for the dashboard ─────────────────── */
export async function onRequestGet(context) {
  const { env, request } = context;
  const session = getSession(request);
  const { isModerator } = await import('./admin/moderators.js');
  if (!(await isModerator(env, session))) {
    return json({ error: 'You need broadcaster or moderator access for this.' }, 403);
  }

  const config = await loadConfig(env);
  const lastWinner = await env.MARKETPLACE.get(WINNER_KEY, 'json');
  return json({
    config: config || { segments: [] },
    palette: WHEEL_PALETTE,
    lastWinner: lastWinner || null,
  });
}

/* ── POST — save / spin ─────────────────────────────────────────────────── */
export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);
  const { isModerator } = await import('./admin/moderators.js');
  if (!(await isModerator(env, session))) {
    return json({ error: 'You need broadcaster or moderator access for this.' }, 403);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  if (body.action === 'save') {
    const result = validateConfig(body);
    if (result.error) return json({ error: result.error }, 400);
    await env.MARKETPLACE.put(CONFIG_KEY, JSON.stringify({ segments: result.segments, updatedAt: Date.now() }));
    return json({ success: true, config: { segments: result.segments } });
  }

  if (body.action === 'spin') {
    const config = await loadConfig(env);
    if (!config || config.segments.length < MIN_SEGMENTS) {
      return json({ error: 'Configure the wheel first — it needs at least 2 segments.' }, 400);
    }

    const winnerIndex = pickWeighted(config.segments);
    if (winnerIndex < 0) return json({ error: 'The wheel has no valid segments to spin.' }, 400);
    const winner = config.segments[winnerIndex];

    /* The event carries each segment's resolved on-palette hex and its weight,
       so the overlay draws arcs ∝ weight (an honest wheel) and lands the
       pointer in the winner's slice. */
    const segments = config.segments.map(s => ({
      label: s.label,
      color: WHEEL_PALETTE[s.color] || WHEEL_PALETTE.oxblood,
      weight: s.weight,
    }));

    const { pushOverlayEvent } = await import('./overlay/events.js');
    await pushOverlayEvent(env, {
      type: 'wheel-spin',
      segments,
      winnerIndex,
      who: winner.label,
    });

    await env.MARKETPLACE.put(WINNER_KEY, JSON.stringify({ label: winner.label, at: Date.now() }));

    return json({ success: true, winner: { label: winner.label, index: winnerIndex } });
  }

  return json({ error: 'Invalid action' }, 400);
}
