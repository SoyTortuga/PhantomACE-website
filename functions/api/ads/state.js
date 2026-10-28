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

/* How early the warning is considered live. The overlay fires the "Ads
   Incoming!" card when a break first falls inside this window, so it is the
   warning's lead time: 2 minutes. A read-time comparison, not anything
   scheduled, so changing it needs no migration. */
export const WARNING_LEAD_MS = 2 * 60_000;

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
 * Parse Twitch's next_ad_at. The docs say RFC3339, but the live Get Ad
 * Schedule endpoint has been observed returning a UNIX epoch (seconds) — and
 * Date.parse() of an integer yields NaN, which silently blanks the whole
 * schedule and kills the "Ads Incoming" warning while the during-break ring
 * (fed by the ISO webhook) keeps working. Accept string ISO, numeric string,
 * and number (seconds or ms). Empty / 0 → NaN (no scheduled ad).
 */
export function parseAdTime(v) {
  if (v === null || v === undefined || v === '') return NaN;
  if (typeof v === 'number') return v > 0 ? (v < 1e12 ? v * 1000 : v) : NaN;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) { const n = Number(s); return n > 0 ? (n < 1e12 ? n * 1000 : n) : NaN; }
  return Date.parse(s);
}

/**
 * Broadcaster-only diagnostic: force a raw /helix/channels/ads fetch and
 * report exactly what Twitch returns, so "the warning never fires" can be
 * pinned to its cause (missing scope → 401; manual ads → empty next_ad_at;
 * a format flip → raw present but unparsed). No caching, never throws.
 */
export async function debugSchedule(env) {
  const out = { channelLive: null, httpStatus: null, rawNextAdAt: null, rawRow: null, parsedNextAdAt: null, note: null };
  try { out.channelLive = await isChannelLive(env); } catch { out.channelLive = 'check-failed'; }
  const token = await getBroadcasterToken(env);
  if (!token) { out.note = 'no broadcaster token (re-authorise in bot setup)'; return out; }
  if (!env.TWITCH_BROADCASTER_ID) { out.note = 'TWITCH_BROADCASTER_ID not set'; return out; }
  try {
    const res = await fetch(`https://api.twitch.tv/helix/channels/ads?broadcaster_id=${env.TWITCH_BROADCASTER_ID}`,
      { headers: { Authorization: `Bearer ${token}`, 'Client-Id': env.TWITCH_CLIENT_ID } });
    out.httpStatus = res.status;
    if (res.ok) {
      const data = await res.json();
      out.rawRow = (data && data.data && data.data[0]) || null;
      out.rawNextAdAt = out.rawRow ? (out.rawRow.next_ad_at ?? null) : null;
      out.parsedNextAdAt = out.rawRow ? parseAdTime(out.rawRow.next_ad_at) : null;
      if (out.httpStatus === 200 && (out.rawNextAdAt === null || out.rawNextAdAt === '' || out.rawNextAdAt === 0)) {
        out.note = 'next_ad_at is empty — no scheduled/automatic ad (manual ads give no advance warning)';
      }
    } else if (res.status === 401) {
      out.note = '401 — channel:read:ads not granted or token expired; re-authorise in bot setup';
    } else {
      out.note = 'helix ' + res.status;
    }
  } catch (e) { out.note = 'fetch failed: ' + (e && e.message); }
  return out;
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
  const nextAt = parseAdTime(row.next_ad_at);

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
