/* ══════════════════════════════════════════════
   AD BREAKS
   POST — Twitch EventSub webhook for channel.ad_break.begin
   GET  — the current ad state, for the overlay and the drop guard

   Twitch pushes exactly one ad event and it is this one: the break has
   STARTED. There is no matching end, and no event at all for a break that
   is merely approaching. The "ads in 2 minutes" countdown other channels
   show is their tooling polling /helix/channels/ads; ads/state.js does the
   same, and the GET below is what serves the result.

   Requires channel:read:ads, granted by the broadcaster. Without it the
   subscription cannot be created and the schedule fetch answers 401 — the
   symptom being that nothing ever appears, which is why ads/state.js logs
   that status rather than swallowing it.
   ══════════════════════════════════════════════ */

import { verifyEventSub } from '../../server/lib/eventsub.js';
import { recordBreakBegin, refreshSchedule, readAdState, viewOf } from './ads/state.js';

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

  const bodyText = await request.text();

  /* FAILS CLOSED, and verifies before parsing. The signature covers the raw
     body, so anything that reads the payload first is trusting bytes it has
     not authenticated yet. */
  const check = await verifyEventSub(request, env.TWITCH_EVENTSUB_SECRET, bodyText);
  if (!check.ok) return new Response(check.reason, { status: check.status });

  let body;
  try { body = JSON.parse(bodyText); } catch { return json({ error: 'Invalid JSON' }, 400); }

  if (check.messageType === 'webhook_callback_verification') {
    return new Response(body.challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } });
  }

  if (check.messageType === 'revocation') {
    /* Twitch revokes when the broadcaster removes the scope or the token
       dies. Logged loudly: the endpoint keeps answering 200 either way, so
       without this the only symptom is breaks quietly never registering. */
    console.warn('[ad-break] subscription revoked:',
                 body.subscription?.status || 'unknown reason');
    return json({ ok: true });
  }

  if (check.messageType === 'notification' && body.event) {
    await recordBreakBegin(env, body.event);
  }

  return json({ ok: true });
}

export async function onRequestGet(context) {
  const { env, request } = context;

  /* Refreshing here rather than on a timer keeps this off the process
     lifetime, the same way the room games resolve their own state when
     someone asks. ads/state.js rate-limits it, so a caller polling every
     second still costs one Twitch request a minute. */
  const state = await refreshSchedule(env).catch(() => readAdState(env));

  /* Snooze count and pre-roll free time describe the channel's
     monetisation. The overlay reads this endpoint and its URL lives in an
     OBS source, so those two need a real session — holding the overlay key
     is not an authorisation. */
  const session = getSession(request);
  const full = !!(session && String(session.user_id) === String(env.TWITCH_BROADCASTER_ID));

  return json(viewOf(state, Date.now(), { full }));
}
