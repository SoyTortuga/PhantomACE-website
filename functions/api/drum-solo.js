/* ══════════════════════════════════════════════
   DRUM SOLO METER — chat fills a hype meter while PhantomACE plays drums.

   A STREAM-NIGHT MODE, NOT A ROOM. The broadcaster starts it from Bot Control
   (a trigger.js action, moderator-gated) at the top of a drum solo. The bot
   announces it in chat, the overlay shows a hype meter + a countdown + the
   phamDrum emote, and CHAT collectively fills the meter by smashing `!solo`.

   IT IS COLLABORATIVE — THERE IS NO LOSS. Fill the meter before the countdown
   runs out and the overlay throws a phamDrum "FILLED!" celebration and the bot
   shouts chat out. Countdown expires unfilled → the panel just clears quietly.
   No penalty, no "streamer wins". The crowd either got there together or it
   didn't, and either way everyone who turned up earns their credit.

   THE AGGREGATE — "a value and a count, never a log".
     One singleton record holds the live event: the fill goal, the running hit
     count (the meter), a distinct-participant count, and the per-chatter
     rate-limit map `seen` (uid -> last hit time). `seen` is the ONLY per-person
     state and it is CAPPED at MAX_CHATTERS, so a raid of thousands cannot grow
     the record without bound. There is no per-message log of any kind.

   CROWD SIZE IS WHAT MATTERS. Each chatter contributes to the meter on a
   per-user cooldown (SOLO_COOLDOWN_MS), so one person mashing tops out at a few
   hits across the whole solo and can never fill it alone — it takes a chat. The
   first `!solo` from each chatter is both a meter hit AND their one
   participation credit for this event; later hits fill the meter but never
   double-count participation.

   PARTICIPATION EARNS A BADGE, FILL OR NOT. A chatter who showed up should not
   lose credit because the crowd happened to be small, so the achievement join
   is recorded on participation regardless of whether the meter filled. The fill
   only controls the celebration moment. A chat-only viewer with no account
   simply earns nothing (recordAchievement ignores guests) — damage/noise still
   counts toward the meter.

   TIME IS RESOLVED LAZILY, like the rooms and the other chat games: an active
   event past its countdown reads as over (publicDrum flips it to 'none') without
   anyone having to write first — the countdown IS the stop. A filled event
   lingers for FILL_LINGER_MS so every overlay sees the celebration, then reads
   as 'none'. An explicit stop writes a tombstone (not a delete) so a `!solo`
   already holding the lock cannot resurrect it.

   STORAGE. One singleton key `drum_solo`, registered in server/lib/registry.js
   as { table: 'singletons', expiry: 'real' }: every write slides a TTL forward,
   so an abandoned row is reclaimed. The live status is timestamp-driven so the
   panel hides on schedule before the row is even gone.

   This file exports onRequestGet (the overlay's public poll), so it IS a route
   (/api/drum-solo) and needs no NON_ROUTE_MODULES entry. Start/stop are
   trigger.js actions that call startDrumSolo/stopDrumSolo; `!solo` calls
   soloFromChat from bot/commands.js.
   ══════════════════════════════════════════════ */

export const DRUM_KEY = 'drum_solo';

/* ── TUNABLES ───────────────────────────────────────────────────────────────
   Defaulted to be reachable by an active chat in ~30 seconds. A start may
   override each within the clamps below (Bot Control sends the defaults).

     COUNTDOWN  30s — the window chat has to fill the meter.
     GOAL       60 contributing hits — with the cooldown below one chatter can
                land at most ~12 in 30s, so ~5+ people hammering (or a few dozen
                dropping one each) are needed. A single masher cannot fill it.
     COOLDOWN   2500ms per chatter — in the asked-for 2–3s band. */
export const DEFAULT_SECONDS = 30;
const MIN_SECONDS = 10;
const MAX_SECONDS = 120;

export const DEFAULT_GOAL = 60;
const MIN_GOAL = 5;
const MAX_GOAL = 100000;

export const DEFAULT_COOLDOWN_MS = 2500;
const MIN_COOLDOWN_MS = 1000;
const MAX_COOLDOWN_MS = 10000;

/* A filled meter shows its celebration this long, then the panel clears. */
const FILL_LINGER_MS = 8000;

/* The per-chatter rate-limit map is capped so a raid cannot balloon the doc.
   The same ceiling every other chat-play mode uses. */
const MAX_CHATTERS = 2000;

/* Storage backstop, comfortably longer than any countdown + linger so the
   timestamp rule ends a live event and the TTL only reclaims an abandoned row. */
const SESSION_TTL_SECONDS = 180;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function clampInt(v, lo, hi, dflt) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

/* An event is live (accepting `!solo`) only while active AND inside its
   countdown. The pure read path uses this so an expired event reads as over
   without a write. A 'filled' event is NOT live — the meter is full and further
   hits are no-ops. */
function isLive(s, now) {
  return !!(s && s.status === 'active' && s.endsAt && now < s.endsAt);
}

/* The small shape the overlay reads — never the raw `seen` rate-limit map.
   Resolves the lifecycle so every reader agrees without a background job:
     active past its countdown → gone (unfilled, quiet clear);
     filled → shows for FILL_LINGER_MS, then gone;
     a stop tombstone / anything else → gone. */
export function publicDrum(s, now = Date.now()) {
  if (!s || !s.status) return { status: 'none', serverNow: now };
  let status = s.status;
  if (status === 'active' && s.endsAt && now >= s.endsAt) status = 'none';   // countdown elapsed unfilled
  if (status === 'filled' && s.filledAt && now - s.filledAt > FILL_LINGER_MS) status = 'none';
  if (status !== 'active' && status !== 'filled') return { status: 'none', serverNow: now };

  const goal = Math.max(1, Math.floor(Number(s.goal) || DEFAULT_GOAL));
  const hits = Math.max(0, Math.min(goal, Math.floor(Number(s.hits) || 0)));
  return {
    status,
    serverNow: now,
    goal,
    hits,
    pct: Math.max(0, Math.min(100, (hits / goal) * 100)),
    participants: Math.max(0, Math.floor(Number(s.participants) || 0)),
    startedAt: s.startedAt || 0,
    endsAt: s.endsAt || 0,
    filledAt: s.filledAt || 0,
  };
}

function newEvent(now, { by, seconds, goal, cooldownMs }) {
  return {
    status: 'active',
    startedAt: now,
    endsAt: now + clampInt(seconds, MIN_SECONDS, MAX_SECONDS, DEFAULT_SECONDS) * 1000,
    by: by || null,
    goal: clampInt(goal, MIN_GOAL, MAX_GOAL, DEFAULT_GOAL),
    cooldownMs: clampInt(cooldownMs, MIN_COOLDOWN_MS, MAX_COOLDOWN_MS, DEFAULT_COOLDOWN_MS),
    hits: 0,
    participants: 0,
    filledAt: 0,
    seen: {},
  };
}

/* ══ Start — a moderator's Bot Control button (via trigger.js) ═════════════
   Overwrites any previous event, so a fresh start resets the meter to 0. The
   chat announce is best-effort: a Helix hiccup must never fail the start the
   broadcaster pressed. */
export async function startDrumSolo(env, { by, seconds, goal, cooldownMs } = {}) {
  if (!env || !env.MARKETPLACE) return { ok: false, error: 'No storage.' };
  const now = Date.now();
  const s = newEvent(now, { by, seconds, goal, cooldownMs });
  await env.MARKETPLACE.mutate(DRUM_KEY, () => s, { expirationTtl: SESSION_TTL_SECONDS });

  try {
    const { sendChatMessage } = await import('./bot/send-chat.js');
    await sendChatMessage(env,
      '🥁 DRUM SOLO — smash !solo to fill the hype meter! No account needed, just type !solo and keep it going.');
  } catch (err) {
    console.error('[drum-solo] start announce failed:', err && err.message);
  }

  return { ok: true, success: true, drum: publicDrum(s, now) };
}

/* ══ Stop — a moderator's Bot Control button (via trigger.js) ══════════════
   A tombstone rather than a delete, so a `!solo` already holding the lock
   cannot resurrect the event by writing it back. */
export async function stopDrumSolo(env) {
  if (!env || !env.MARKETPLACE) return { ok: false, error: 'No storage.' };
  await env.MARKETPLACE.mutate(DRUM_KEY, () => ({ status: 'ended', endedAt: Date.now() }),
    { expirationTtl: 60 });
  return { ok: true, success: true };
}

/* ══ Chat participation — called from bot/commands.js on `!solo` ═══════════
   One contributing hit per chatter per cooldown, each hit fills the meter by
   one. The FIRST hit from a chatter also counts them as a participant and earns
   their one achievement join for this event; later hits never re-count it.
   No live event → a quiet no-op. Silent by design: the overlay meter is the
   feedback, and a reply per chatter would bury the channel during exactly the
   busy half-minute the solo is open. */
export async function soloFromChat(env, { userId, name } = {}) {
  if (!env || !env.MARKETPLACE || !userId) return { ok: false, status: 'none' };
  void name;   // chat-only players put nothing on the overlay; the meter is anonymous
  const uid = String(userId);

  let landed = false;
  let newParticipant = false;
  let justFilled = false;
  let after = null;

  await env.MARKETPLACE.mutate(DRUM_KEY, (s) => {
    const now = Date.now();
    after = s;
    if (!isLive(s, now)) return undefined;   // no live solo — nothing to fill

    s.seen = (s.seen && typeof s.seen === 'object') ? s.seen : {};
    const known = Object.prototype.hasOwnProperty.call(s.seen, uid);
    const last = known ? Number(s.seen[uid]) : 0;
    const cd = Math.max(MIN_COOLDOWN_MS, Math.floor(Number(s.cooldownMs) || DEFAULT_COOLDOWN_MS));

    /* Rate limit: this chatter hit within the cooldown. Quiet no-op. */
    if (known && last != null && now - last < cd) return undefined;

    /* The bound: once the map is full, new chatters are turned away while the
       ones already in keep drumming. Only ever reached by a chat far larger
       than any real solo needs. */
    if (!known && Object.keys(s.seen).length >= MAX_CHATTERS) return undefined;

    s.seen[uid] = now;
    s.hits = (Number(s.hits) || 0) + 1;
    if (!known) { s.participants = (Number(s.participants) || 0) + 1; newParticipant = true; }
    landed = true;

    const goal = Math.max(1, Math.floor(Number(s.goal) || DEFAULT_GOAL));
    if (s.hits >= goal) {
      s.hits = goal;
      s.status = 'filled';
      s.filledAt = now;
      justFilled = true;
    }
    after = s;
    return s;
  }, { expirationTtl: SESSION_TTL_SECONDS });

  /* Participation credit, granted on the chatter's FIRST hit regardless of
     whether the meter filled. Best-effort, dynamic import, its own try/catch —
     a cosmetic grant must never be able to break the event. Guests (no account)
     are ignored inside recordAchievement, so a chat-only viewer earns nothing. */
  if (newParticipant) {
    try {
      const { recordAchievement } = await import('./achievements.js');
      await recordAchievement(env, 'drum-solo', uid, { type: 'join' });
    } catch (err) {
      console.error('[drum-solo] achievement join failed:', err && err.message);
    }
  }

  /* The filling blow gets a chat shoutout — the ONE place this mode talks, and
     only once per event (the meter is already full, so no further !solo lands).
     Best-effort, like the start announce. */
  if (justFilled) {
    try {
      const { sendChatMessage } = await import('./bot/send-chat.js');
      const n = after ? Math.max(0, Math.floor(Number(after.participants) || 0)) : 0;
      await sendChatMessage(env,
        `🥁🔥 METER FILLED! ${n} drummer${n === 1 ? '' : 's'} brought the house down — PhantomACE, take it away!`);
    } catch (err) {
      console.error('[drum-solo] fill shoutout failed:', err && err.message);
    }
  }

  return { ok: landed, status: publicDrum(after).status, filled: justFilled, newParticipant };
}

/* ══ GET — the overlay (OBS browser source) ════════════════════════════════
   Public and lock-free, like the Bone Tithe panel: the lifecycle is derived
   purely from stored timestamps, so every poller resolves the same status
   without a write, and a fresh start overwrites a lingering record. */
export async function onRequestGet(context) {
  const { env } = context;
  const s = await env.MARKETPLACE.get(DRUM_KEY, 'json');
  return json(publicDrum(s));
}
