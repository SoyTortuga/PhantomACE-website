/* ══════════════════════════════════════════════
   CHANNEL POINT PREDICTIONS
   Mods run these from the bot control panel, but the Twitch API has no
   moderator path for predictions — they are broadcaster-only. So the mod
   gate (isModerator) decides WHO may press the buttons, and the stored
   BROADCASTER token is what actually talks to Helix.

   INERT UNTIL AUTHORIZED. Predictions need channel:manage:predictions,
   which the broadcaster grants in Step 2 of /api/admin/bot-setup. Until then
   there is no broadcaster token (400, "complete Step 2") and, if the scope
   was never granted, Twitch answers 401/403 — both surfaced as "not
   authorized yet" rather than an error, so the feature reads as switched off,
   exactly like the ad-break feature does today. Nothing here throws a 500 for
   the missing-scope case.

   STATELESS. No new KV keys: the prediction id needed to lock/resolve/cancel
   comes from the panel, which read it from 'status' or 'create'. The only
   write is the shared bot action log.
   ══════════════════════════════════════════════ */

import { getBroadcasterToken, logBotAction } from './send-chat.js';

const TITLE_MAX = 45;
const OUTCOME_MAX = 25;
const OUTCOME_MIN_COUNT = 2;
const OUTCOME_MAX_COUNT = 10;
const WINDOW_MIN = 30;
const WINDOW_MAX = 1800;
const WINDOW_DEFAULT = 120;

const HELIX = 'https://api.twitch.tv/helix/predictions';

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

/* The panel only needs a subset of Helix's prediction shape, in camelCase,
   with the live totals per outcome. */
function viewPrediction(p) {
  if (!p) return null;
  return {
    id: p.id,
    title: p.title,
    status: p.status,
    createdAt: p.created_at || null,
    locksAt: p.locked_at || null,
    endedAt: p.ended_at || null,
    predictionWindow: p.prediction_window || null,
    winningOutcomeId: p.winning_outcome_id || null,
    outcomes: (Array.isArray(p.outcomes) ? p.outcomes : []).map(o => ({
      id: o.id,
      title: o.title,
      users: o.users || 0,
      channelPoints: o.channel_points || 0,
      color: o.color || null,
    })),
  };
}

/**
 * Validate a create request WITHOUT touching Twitch — every rejection here is
 * something Twitch would reject too, said before a request is spent.
 * @returns {{error:string}|{title:string, outcomes:{title:string}[], window:number}}
 */
function validateCreate(body) {
  const title = String(body && body.title != null ? body.title : '').trim();
  if (!title) return { error: 'Give the prediction a title.' };
  if (title.length > TITLE_MAX) return { error: `Title is too long (max ${TITLE_MAX} characters).` };

  const raw = Array.isArray(body && body.outcomes) ? body.outcomes : [];
  const outcomes = [];
  for (const o of raw) {
    const t = String((o && typeof o === 'object') ? (o.title != null ? o.title : '') : o).trim();
    if (!t) continue;                     // blank rows are dropped, then counted
    if (t.length > OUTCOME_MAX) return { error: `Each outcome is at most ${OUTCOME_MAX} characters ("${t.slice(0, OUTCOME_MAX)}…" is too long).` };
    outcomes.push({ title: t });
  }
  if (outcomes.length < OUTCOME_MIN_COUNT) {
    return { error: `A prediction needs at least ${OUTCOME_MIN_COUNT} outcomes.` };
  }
  if (outcomes.length > OUTCOME_MAX_COUNT) {
    return { error: `A prediction allows at most ${OUTCOME_MAX_COUNT} outcomes.` };
  }

  let window = WINDOW_DEFAULT;
  if (body && body.window !== undefined && body.window !== null && body.window !== '') {
    const w = Number(body.window);
    if (!Number.isInteger(w) || w < WINDOW_MIN || w > WINDOW_MAX) {
      return { error: `Prediction window must be a whole number of seconds between ${WINDOW_MIN} and ${WINDOW_MAX}.` };
    }
    window = w;
  }

  return { title, outcomes, window };
}

/* Turns a non-OK Helix response into a clean panel error. A missing scope
   (401/403) is reported as "not authorized yet", not as a failure, so the
   card degrades to inert instead of looking broken. Everything else — most
   usefully "there is already an ACTIVE Prediction" — is passed through in
   Twitch's own words. */
async function twitchError(res) {
  const data = await res.json().catch(() => ({}));
  const message = data && data.message ? String(data.message) : '';
  if (res.status === 401 || res.status === 403) {
    return json({
      error: 'Predictions are not authorized yet — the broadcaster needs to complete Step 2 in /api/admin/bot-setup to grant channel:manage:predictions.',
      authorized: false,
    }, 400);
  }
  return json({ error: message || `Twitch would not complete that (HTTP ${res.status}).` }, 400);
}

async function helix(env, token, method, body) {
  return fetch(HELIX, {
    method,
    headers: {
      'Authorization': 'Bearer ' + token,
      'Client-Id': env.TWITCH_CLIENT_ID,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

/* The latest prediction on the channel, or null when there are none. */
async function fetchLatest(env, token) {
  const res = await fetch(`${HELIX}?broadcaster_id=${env.TWITCH_BROADCASTER_ID}&first=1`, {
    headers: { 'Authorization': 'Bearer ' + token, 'Client-Id': env.TWITCH_CLIENT_ID },
  });
  if (!res.ok) return { errorResponse: await twitchError(res) };
  const data = await res.json().catch(() => ({}));
  const p = data && Array.isArray(data.data) ? data.data[0] : null;
  return { prediction: p ? viewPrediction(p) : null };
}

/* ── Shared handler for GET (status) and POST (everything) ─────────────── */

async function handle(env, session, action, body) {
  const { isModerator } = await import('../admin/moderators.js');
  if (!(await isModerator(env, session))) {
    return json({ error: 'You need broadcaster or moderator access for this.' }, 403);
  }

  /* Input validation runs BEFORE the token is fetched, so a malformed create
     is rejected the same whether or not the feature is authorized — and never
     spends a Twitch request. */
  let create = null;
  if (action === 'create') {
    create = validateCreate(body);
    if (create.error) return json({ error: create.error }, 400);
  }

  if (action === 'lock' || action === 'resolve' || action === 'cancel') {
    if (!body || !body.id) return json({ error: 'Missing the prediction id.' }, 400);
  }
  if (action === 'resolve' && !(body && body.winningOutcomeId)) {
    return json({ error: 'Pick the winning outcome.' }, 400);
  }

  const token = await getBroadcasterToken(env);
  if (!token) {
    return json({
      error: 'Broadcaster prediction authorization missing — complete Step 2 in /api/admin/bot-setup.',
      authorized: false,
    }, 400);
  }

  const actor = (session && session.display_name) || 'broadcaster';

  if (action === 'status') {
    const r = await fetchLatest(env, token);
    if (r.errorResponse) return r.errorResponse;
    return json({ prediction: r.prediction });
  }

  if (action === 'create') {
    const res = await helix(env, token, 'POST', {
      broadcaster_id: env.TWITCH_BROADCASTER_ID,
      title: create.title,
      outcomes: create.outcomes,
      prediction_window: create.window,
    });
    if (!res.ok) return await twitchError(res);
    const data = await res.json().catch(() => ({}));
    const p = data && Array.isArray(data.data) ? data.data[0] : null;
    await logBotAction(env, {
      type: 'prediction-create',
      actor,
      message: `opened prediction "${create.title}"`,
      title: create.title,
      outcomes: create.outcomes.map(o => o.title),
    });
    return json({ success: true, prediction: viewPrediction(p) });
  }

  if (action === 'lock') {
    const res = await helix(env, token, 'PATCH', {
      broadcaster_id: env.TWITCH_BROADCASTER_ID,
      id: body.id,
      status: 'LOCKED',
    });
    if (!res.ok) return await twitchError(res);
    const data = await res.json().catch(() => ({}));
    const p = data && Array.isArray(data.data) ? data.data[0] : null;
    return json({ success: true, prediction: viewPrediction(p) });
  }

  if (action === 'resolve') {
    const res = await helix(env, token, 'PATCH', {
      broadcaster_id: env.TWITCH_BROADCASTER_ID,
      id: body.id,
      status: 'RESOLVED',
      winning_outcome_id: body.winningOutcomeId,
    });
    if (!res.ok) return await twitchError(res);
    const data = await res.json().catch(() => ({}));
    const p = data && Array.isArray(data.data) ? data.data[0] : null;
    await logBotAction(env, {
      type: 'prediction-resolve',
      actor,
      message: `resolved a prediction`,
      predictionId: body.id,
      winningOutcomeId: body.winningOutcomeId,
    });
    return json({ success: true, prediction: viewPrediction(p) });
  }

  if (action === 'cancel') {
    const res = await helix(env, token, 'PATCH', {
      broadcaster_id: env.TWITCH_BROADCASTER_ID,
      id: body.id,
      status: 'CANCELED',
    });
    if (!res.ok) return await twitchError(res);
    const data = await res.json().catch(() => ({}));
    const p = data && Array.isArray(data.data) ? data.data[0] : null;
    await logBotAction(env, {
      type: 'prediction-cancel',
      actor,
      message: `canceled a prediction (points refunded)`,
      predictionId: body.id,
    });
    return json({ success: true, prediction: viewPrediction(p) });
  }

  return json({ error: 'Invalid action' }, 400);
}

/* ── GET — the panel polls this for live totals ───────────────────────── */
export async function onRequestGet(context) {
  const { env, request } = context;
  const session = getSession(request);
  return handle(env, session, 'status', null);
}

/* ── POST — create / lock / resolve / cancel (and status, for symmetry) ── */
export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  return handle(env, session, body && body.action, body);
}
