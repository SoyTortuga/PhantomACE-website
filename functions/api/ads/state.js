/* ══════════════════════════════════════════════
   AD BREAKS — the one place that knows whether ads are running or coming.

   Library, no handler. Read by the webhook, by the drop guard, and later by
   the overlay, so the rules below are written once.

   TWO SIGNALS, TWO MECHANISMS, AND THEY ARE NOT INTERCHANGEABLE.

     running   channel.ad_break.begin, an EventSub push. Arrives once, when
               the break starts, carrying its length.
     coming    /helix/channels/ads, polled. Twitch has no "ad is about to
               start" event — the countdown other broadcasters show is their
               tooling polling this endpoint and doing the arithmetic.

   THERE IS NO ad_break.end EVENT. This is the trap. A boolean set by the
   webhook has nothing to clear it: the process restarts, the flag is still
   true, and drops stay suppressed for the rest of the stream with nothing
   in the logs. So "running" is never stored as a flag — it is stored as
   `endsAt`, and every reader asks whether now is past it. State that
   expires by arithmetic cannot get stuck.

   THE SCHEDULE IS CACHED AS AN ABSOLUTE TIMESTAMP, never as "minutes left".
   next_ad_at is absolute, so a sixty-second-old cache still yields a
   second-accurate countdown because the subtraction happens at read time.
   Caching the remaining time instead would turn cache age into visible
   drift, and would stop the overlay's one-second poll from ever sitting on
   top of a one-minute refresh.
   ══════════════════════════════════════════════ */

import { getBroadcasterToken } from '../bot/send-chat.js';
import { isChannelLive } from '../stream-info.js';

const KEY = 'ad_state';

/* Long enough that a 1 Hz overlay poll costs one Twitch call a minute;
   short enough that a break scheduled after the last read is seen with
   minutes to spare. The countdown's accuracy does not depend on it. */
export const SCHEDULE_TTL_MS = 60_000;

/* How early the warning is considered live. Matches what viewers are used
   to seeing elsewhere, and is a read-time comparison rather than anything
   scheduled, so changing it needs no migration. */
export const WARNING_LEAD_MS = 5 * 60_000;

/* A break Twitch never closed out. Ad breaks run to 180s at the very most,
   so anything still "running" long past its own endsAt plus this margin is
   a stuck record rather than a long advert — belt and braces on top of the
   endsAt arithmetic, for the case where duration_seconds arrives absent or
   nonsensical. */
const MAX_BREAK_MS = 5 * 60_000;

/** The stored shape, with every field defaulted so a first read is safe. */
function blank() {
  return { break: null, schedule: null, scheduleCheckedAt: 0 };
}

async function read(env) {
  const stored = await env.MARKETPLACE.get(KEY, 'json');
  return stored && typeof stored === 'object' ? { ...blank(), ...stored } : blank();
}

async function write(env, state) {
  await env.MARKETPLACE.put(KEY, JSON.stringify(state));
  return state;
}

/**
 * Record a channel.ad_break.begin notification.
 *
 * `duration_seconds` is what closes the break later, so a missing or absurd
 * value is clamped rather than trusted — an unbounded endsAt is the stuck
 * flag this whole design exists to avoid.
 */
export async function recordBreakBegin(env, event, now = Date.now()) {
  const startedAt = Date.parse(event?.started_at || '') || now;

  const raw = Number(event?.duration_seconds);
  const seconds = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 300) : 90;

  const state = await read(env);
  state.break = {
    startedAt,
    endsAt: startedAt + seconds * 1000,
    durationSeconds: seconds,
    isAutomatic: !!event?.is_automatic,
    requestedBy: event?.requester_user_name || null,
  };

  /* The break that just started is no longer upcoming. Leaving it would
     make the overlay count down to a moment already in the past. */
  state.schedule = null;
  state.scheduleCheckedAt = 0;

  return write(env, state);
}

/** Whether a break is running at `now`, from stored state alone. */
export function breakRunningAt(state, now = Date.now()) {
  const b = state?.break;
  if (!b || !b.endsAt) return false;
  if (now >= b.endsAt) return false;
  /* Guards a record whose endsAt is implausibly far out. */
  if (now > b.startedAt + MAX_BREAK_MS) return false;
  return true;
}

/**
 * Ask Twitch for the ad schedule, at most once per SCHEDULE_TTL_MS.
 *
 * Returns the state either way. A failed call leaves the previous schedule
 * in place and does NOT stamp scheduleCheckedAt, so the next caller retries
 * instead of waiting out a TTL on an answer that never arrived.
 */
export async function refreshSchedule(env, now = Date.now(), { force = false } = {}) {
  const state = await read(env);
  if (!force && now - state.scheduleCheckedAt < SCHEDULE_TTL_MS) return state;

  /* next_ad_at is empty when the channel is offline, so calling while dark
     spends a token refresh and a request to learn nothing. */
  if (!(await isChannelLive(env))) {
    state.schedule = null;
    state.scheduleCheckedAt = now;
    return write(env, state);
  }

  const token = await getBroadcasterToken(env);
  if (!token || !env.TWITCH_BROADCASTER_ID) return state;

  let data;
  try {
    const res = await fetch(
      `https://api.twitch.tv/helix/channels/ads?broadcaster_id=${env.TWITCH_BROADCASTER_ID}`,
      { headers: { Authorization: `Bearer ${token}`, 'Client-Id': env.TWITCH_CLIENT_ID } });
    if (!res.ok) {
      /* 401 means the scope was never granted or was revoked. Worth a log
         line, because the symptom otherwise is a countdown that silently
         never appears. */
      console.warn(`[ad-state] schedule fetch HTTP ${res.status}`);
      return state;
    }
    data = await res.json();
  } catch (err) {
    console.warn('[ad-state] schedule fetch failed:', err.message);
    return state;
  }

  const row = (data?.data || [])[0] || {};
  const nextAt = Date.parse(row.next_ad_at || '');

  state.schedule = Number.isNaN(nextAt) ? null : {
    nextAdAt: nextAt,
    durationSeconds: Number(row.duration) || 0,
    snoozeCount: Number(row.snooze_count) || 0,
    prerollFreeTime: Number(row.preroll_free_time) || 0,
  };
  state.scheduleCheckedAt = now;
  return write(env, state);
}

/**
 * What a caller should act on.
 *
 * `full` decides whether the broadcaster-only numbers come back. Snooze
 * count and pre-roll free time describe the channel's monetisation, not the
 * viewer's experience, and the overlay URL lives in OBS where anyone who
 * sees the screen could read it — so they are gated on a real session
 * rather than on holding the overlay key.
 */
export function viewOf(state, now = Date.now(), { full = false } = {}) {
  const running = breakRunningAt(state, now);
  const s = state?.schedule;

  const view = {
    running,
    endsAt: running ? state.break.endsAt : null,
    secondsRemaining: running ? Math.ceil((state.break.endsAt - now) / 1000) : null,
    isAutomatic: running ? !!state.break.isAutomatic : null,

    nextAdAt: s?.nextAdAt ?? null,
    /* Null rather than a negative number once the moment has passed: a
       countdown reading -12 is a bug on screen, and the begin event is what
       replaces this anyway. */
    secondsUntilNext: s?.nextAdAt && s.nextAdAt > now
      ? Math.ceil((s.nextAdAt - now) / 1000) : null,
    nextDurationSeconds: s?.durationSeconds ?? null,
  };
  view.warning = !running && view.secondsUntilNext !== null
    && s.nextAdAt - now <= WARNING_LEAD_MS;

  if (full) {
    view.snoozeCount = s?.snoozeCount ?? null;
    view.prerollFreeTime = s?.prerollFreeTime ?? null;
  }
  return view;
}

/**
 * Whether a break is running, for any caller that wants to behave
 * differently during one.
 *
 * DELIBERATELY UNUSED. A drop guard — suppressing item drops and giveaway
 * calls while ads play — was scoped and then declined: drops carry on
 * unchanged through a break, by decision, not by oversight. So if you have
 * arrived here planning to wire this into the drop path, that is the thing
 * that was already considered and rejected. Ask before changing it.
 *
 * Kept because it is the correct way to ask the question and it is tested:
 * stored state only, no Twitch call, because a drop must not wait on a
 * network round trip and the begin event has already been pushed by the
 * time a break is running.
 */
export async function adsRunning(env, now = Date.now()) {
  return breakRunningAt(await read(env), now);
}

/** Exported for the webhook and the tests; nothing else should need it. */
export { read as readAdState, write as writeAdState, KEY as AD_STATE_KEY };
