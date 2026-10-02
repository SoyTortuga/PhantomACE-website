/* ══════════════════════════════════════════════
   CHANNEL POINT PREDICTIONS — EventSub webhook

   Twitch tells us when a prediction begins, gains votes, locks and ends; this
   turns each of those into (1) an overlay event so the on-stream panel updates
   live, and (2) — for begin / lock / end ONLY — an activity-feed record.

   PROGRESS IS HIGH-FREQUENCY. Twitch fires channel.prediction.progress on
   every contribution, so it MUST update the overlay but MUST NOT touch the
   activity feed, or one prediction would bury the feed under hundreds of
   near-identical rows.

   ONE OVERLAY EVENT SHAPE for all four states, so the overlay panel has a
   single thing to render:
     { type:'prediction', state:'begin'|'progress'|'lock'|'end',
       title, status, outcomes:[{id,title,points,users,color}],
       winningOutcomeId, locksAt }

   Follows the shared EventSub pattern (channel-points.js, hype-train.js):
   verifyEventSub fails closed, webhook_callback_verification returns the
   challenge as text/plain, notifications are processed, revocation is a no-op.
   ══════════════════════════════════════════════ */

import { verifyEventSub } from '../../server/lib/eventsub.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

/* Twitch → the overlay's camelCase, tolerant of the fields each state omits
   (begin carries no totals; end carries a winner). */
function normalizeOutcomes(event) {
  const raw = Array.isArray(event && event.outcomes) ? event.outcomes : [];
  return raw.map(o => ({
    id: o.id,
    title: o.title || '',
    points: Number(o.channel_points) || 0,
    users: Number(o.users) || 0,
    color: o.color || null,
  }));
}

/* The Twitch subscription type → our overlay `state`. */
const STATE_BY_TYPE = {
  'channel.prediction.begin': 'begin',
  'channel.prediction.progress': 'progress',
  'channel.prediction.lock': 'lock',
  'channel.prediction.end': 'end',
};

/**
 * Build the single overlay event shape for a subscription type + Twitch event,
 * or null for a type we do not handle. Pure — exported for tests.
 */
export function predictionOverlayEvent(subType, event) {
  const state = STATE_BY_TYPE[subType];
  if (!state || !event) return null;

  let status;
  if (state === 'begin' || state === 'progress') status = 'ACTIVE';
  else if (state === 'lock') status = 'LOCKED';
  else status = String(event.status || '').toUpperCase() || 'RESOLVED';   // 'RESOLVED' | 'CANCELED'

  return {
    type: 'prediction',
    state,
    title: event.title || '',
    status,
    outcomes: normalizeOutcomes(event),
    winningOutcomeId: event.winning_outcome_id || null,
    /* Active states carry locks_at (the countdown target); a locked event
       carries locked_at. Either drives the panel, so surface whichever is set. */
    locksAt: event.locks_at || event.locked_at || null,
  };
}

/**
 * The activity-feed entry for a subscription type, or null when nothing should
 * be recorded — which is EVERY progress event. Pure — exported for tests.
 */
export function predictionActivityEntry(subType, event) {
  const title = (event && event.title) ? String(event.title) : 'a prediction';

  if (subType === 'channel.prediction.begin') {
    return {
      category: 'prediction', type: 'prediction-begin',
      summary: `Prediction opened: "${title}"`,
      payload: event,
    };
  }
  if (subType === 'channel.prediction.lock') {
    return {
      category: 'prediction', type: 'prediction-lock',
      summary: `Prediction locked: "${title}"`,
      payload: event,
    };
  }
  if (subType === 'channel.prediction.end') {
    const status = String(event && event.status || '').toUpperCase();
    let summary;
    if (status === 'CANCELED') {
      summary = `Prediction canceled: "${title}" (points refunded)`;
    } else {
      const outcomes = Array.isArray(event && event.outcomes) ? event.outcomes : [];
      const won = outcomes.find(o => o.id === (event && event.winning_outcome_id));
      summary = won
        ? `Prediction resolved: "${title}" — "${won.title}" won`
        : `Prediction resolved: "${title}"`;
    }
    return { category: 'prediction', type: 'prediction-end', summary, payload: event };
  }

  /* channel.prediction.progress and anything else: no feed record. */
  return null;
}

/* ── POST — Twitch EventSub webhook ─────────── */

export async function onRequestPost(context) {
  const { env, request } = context;

  const bodyText = await request.text();

  /* FAILS CLOSED — a missing TWITCH_EVENTSUB_SECRET is a 500, not skipped
     verification. The shared verifier also checks headers, the replay window
     and the signature in constant time. */
  const check = await verifyEventSub(request, env.TWITCH_EVENTSUB_SECRET, bodyText);
  if (!check.ok) return new Response(check.reason, { status: check.status });
  const messageType = check.messageType;

  let body;
  try { body = JSON.parse(bodyText); } catch { return json({ error: 'Invalid JSON' }, 400); }

  if (messageType === 'webhook_callback_verification') {
    return new Response(body.challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } });
  }

  if (messageType === 'notification') {
    const subType = body.subscription ? body.subscription.type : '';
    const event = body.event;
    if (!event) return json({ ok: true });

    const overlayEvent = predictionOverlayEvent(subType, event);
    if (!overlayEvent) return json({ ok: true });

    /* The overlay panel updates on EVERY state, including progress. But
       progress is a SNAPSHOT, not an alert: each one supersedes the last, so
       it REPLACES any buffered progress instead of appending. Otherwise a busy
       prediction fills the shared 60-slot feed and evicts real sub/raid alerts
       while the overlay is behind. Twitch runs one prediction per channel at a
       time, so "any prediction progress" is "this prediction's progress". */
    try {
      const { pushOverlayEvent } = await import('./overlay/events.js');
      const opts = overlayEvent.state === 'progress'
        ? { replace: (e) => e.type === 'prediction' && e.state === 'progress' }
        : undefined;
      await pushOverlayEvent(env, overlayEvent, opts);
    } catch (err) { console.error('[prediction-events] overlay push failed:', err.message); }

    /* The activity feed records begin / lock / end ONLY — never progress. */
    const entry = predictionActivityEntry(subType, event);
    if (entry) {
      try {
        const { recordActivity } = await import('./activity.js');
        await recordActivity(env, entry);
      } catch (err) { console.error('[prediction-events] activity record failed:', err.message); }
    }

    return json({ ok: true });
  }

  if (messageType === 'revocation') {
    /* Recorded for Bot Control's revoked banner. Cleared there once Create
       Subscriptions re-registers the type. */
    const { recordEventSubRevocation } = await import('./bot/dashboard.js');
    await recordEventSubRevocation(env, body, 'prediction-events');
    return json({ ok: true });
  }

  return json({ ok: true });
}
