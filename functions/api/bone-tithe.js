/* ══════════════════════════════════════════════
   SKULL CLICKER — the BONE TITHE (a shared stream-night offering goal).

   One community goal at a time: the broadcaster/moderators set a target
   number of skulls, and every Skull Clicker player offers a portion of theirs
   toward it. A single progress bar on the overlay fills as the whole site
   tithes together — a co-op stream goal, not a competitive board.

   SERVER-AUTHORITATIVE, by the same shape the raid boss uses.
     • One singleton record (`bone_tithe`) holds the goal, the aggregate
       progress, and a BOUNDED contributor map (id -> {name, amt}). Progress is
       a running counter and the map never grows past a ceiling — there is NO
       per-offering log.
     • Every offering lands inside mutate() (the per-key lock), so concurrent
       tithes accumulate without racing.
     • An offer is NEVER trusted at face value: the credited amount is clamped
       to what the player's own save supports — a logged-in player can tithe at
       most their LIFETIME skulls (monotonic, read from their sc_save_ record),
       so a forged client amount cannot push the bar past what they have earned.
     • Offering is LOGGED-IN ONLY — a guest has no stable save to validate
       against (their id lives in the same localStorage a wipe clears), exactly
       the reasoning that makes save-state login-only in skull-clicker.js.
       Guests still SEE the goal and its progress; they just log in to tithe.

   The record is never deleted on a read: a met goal lingers as 'complete' for
   COMPLETE_LINGER_MS so every overlay/client sees the celebration, then reads
   as 'none'; a timed-out unmet goal and a manual stop both read as 'none'. A
   fresh `start` overwrites whatever is there.
   ══════════════════════════════════════════════ */

const TITHE_KEY = 'bone_tithe';

const DEFAULT_GOAL = 1_000_000;
const MIN_GOAL = 100;
const MAX_GOAL = 1e15;
const MAX_MINUTES = 24 * 60;         /* an optional deadline, capped at a day */
const OFFER_CAP = 1e18;              /* absurd-value guard; the real bound is lifetime */
const COMPLETE_LINGER_MS = 30000;    /* a met goal shows this long, then clears */
const MAX_CONTRIBUTORS = 500;        /* contributor-map ceiling — the record never grows past this */
const NAME_MAX = 25;
const FRENZY_MS = 5 * 60 * 1000;     /* the community reward when the goal is met */

/* ── CHAT'S SHARE ───────────────────────────────────────────────────────
   A tithe costs site players real skulls they earned. Chat types a word. If
   the two were worth the same the tithe would stop meaning anything to the
   people actually paying for it, so chat is capped at a QUARTER of the goal
   and can never finish one alone.

   One contribution per chatter per goal, not a rate limit: chat's total then
   measures how many PEOPLE turned up rather than how fast somebody can type,
   which is the thing worth showing on stream. It takes CHAT_FULL_AT distinct
   chatters to reach the cap, so the share scales with any goal.

   They land as ONE aggregate contributor rather than a row each — a top-five
   list flooded with chatters would bury the players who spent something, and
   the contributor map stays bounded however big chat gets. */
const CHAT_ID = 'chat';
const CHAT_SHARE = 0.25;
const CHAT_FULL_AT = 200;
const MAX_CHAT_TITHERS = 5000;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

function getSession(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)pham_session=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match[1])); } catch { return null; }
}

/* Names reach the stream overlay — strip anything that is not plain visible
   text (control, zero-width, bidi-override and other format characters),
   collapse whitespace and cap the length. Mirrors skull-raid.js. */
function cleanName(raw, fallback) {
  const s = String(raw == null ? '' : raw)
    .replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(s).slice(0, NAME_MAX).join('') || fallback;
}

/* The lifetime-skull ceiling an account may tithe, as a Number. Lifetime is a
   big-number string that can overflow Number(), so a value beyond the
   exact-integer range (or a scientific-notation big number) is treated as
   UNBOUNDED — a player who has genuinely earned 1e15+ skulls is never clipped by
   any realistic goal, and the common in-range case stays EXACT (no log
   round-trip, which would turn 500 into 499.999…). A player with no save yet (or
   a corrupt one) gets 0 and cannot tithe until they sync. The larger of lifetime
   and this-run total is used so a legacy save missing one field still counts. */
const CEILING_UNBOUNDED_AT = 1e15;
function lifetimeCeiling(save) {
  let best = 0;
  for (const v of [save && save.lifetimeSkulls, save && save.totalSkulls]) {
    if (v == null) continue;
    const n = Number(v);
    if (Number.isFinite(n)) { if (n > best) best = n; continue; }
    /* A big-number string past Number()'s range (e.g. "1.23e500") → unbounded. */
    if (/^\d+(?:\.\d+)?[eE]\+?\d+$/.test(String(v))) return Infinity;
  }
  if (!(best > 0)) return 0;
  return best >= CEILING_UNBOUNDED_AT ? Infinity : best;
}

function buildTithe({ goal, minutes, title }) {
  const now = Date.now();
  return {
    status: 'active',
    goal,
    progress: 0,
    title: String(title || 'Bone Tithe').slice(0, 60) || 'Bone Tithe',
    startedAt: now,
    endsAt: minutes > 0 ? now + minutes * 60000 : 0,
    completedAt: 0,
    contributors: {},
  };
}

/* Fold the stored record into the small public shape the game and overlay read.
   Resolves the lifecycle so every reader agrees without a background job:
   a met goal shows for COMPLETE_LINGER_MS then reads 'none'; an unmet goal past
   its deadline, a manual stop, and anything else all read 'none'. Never exposes
   the raw contributor map — only a count and a bounded top list. */
function publicState(t) {
  if (!t || !t.status) return { status: 'none' };
  const now = Date.now();
  let status = t.status;
  if (status === 'active' && t.endsAt && now > t.endsAt && (Number(t.progress) || 0) < (Number(t.goal) || 0)) status = 'none';
  if (status === 'complete' && t.completedAt && now - t.completedAt > COMPLETE_LINGER_MS) status = 'none';
  if (status !== 'active' && status !== 'complete') return { status: 'none' };

  const goal = Math.max(1, Math.floor(Number(t.goal) || 0));
  const progress = Math.max(0, Math.min(goal, Math.floor(Number(t.progress) || 0)));
  const contributors = (t.contributors && typeof t.contributors === 'object') ? t.contributors : {};
  const ids = Object.keys(contributors);
  const top = ids
    .map(id => ({ name: cleanName(contributors[id] && contributors[id].name, 'Reaper'), amt: Math.max(0, Math.floor((contributors[id] && contributors[id].amt) || 0)) }))
    .sort((a, b) => b.amt - a.amt)
    .slice(0, 5);
  return {
    status,
    title: t.title || 'Bone Tithe',
    goal,
    progress,
    pct: Math.max(0, Math.min(100, (progress / goal) * 100)),
    startedAt: t.startedAt || 0,
    endsAt: t.endsAt || 0,
    completedAt: t.completedAt || 0,
    contributors: ids.length,
    top,
  };
}

/* Room for a new contributor. All contributors are accounts (offering is
   login-only), so the map is simply capped — a 501st distinct tither to one
   goal is refused rather than evicting anyone, and the record never grows. */
function admit(contributors, id) {
  if (Object.prototype.hasOwnProperty.call(contributors, id)) return true;
  return Object.keys(contributors).length < MAX_CONTRIBUTORS;
}

/* An offering toward the live goal. The lifetime ceiling is read from the
   player's save OUTSIDE the lock (a plain read), then the credit is computed and
   committed INSIDE mutate() so two offerings landing together cannot both spend
   the same remaining capacity. Credited = min(requested, lifetime-remaining,
   goal-remaining); a forged `amount` can never exceed the smaller of what the
   player has earned and what the goal still needs. */
async function offer(env, session, body) {
  const userId = String(session.user_id);
  const id = 'u_' + userId.slice(0, 40);
  const name = cleanName(session.display_name, 'Reaper');
  const requested = Math.min(OFFER_CAP, Math.max(0, Math.floor(Number(body && body.amount) || 0)));

  const save = await env.MARKETPLACE.get('sc_save_' + userId, 'json');
  const lifeCeil = lifetimeCeiling(save);

  let credited = 0, justCompleted = false, after = null;
  await env.MARKETPLACE.mutate(TITHE_KEY, (t) => {
    after = t;
    if (publicState(t).status !== 'active') return undefined;   /* no live goal → no-op */
    t.contributors = (t.contributors && typeof t.contributors === 'object') ? t.contributors : {};
    if (!admit(t.contributors, id)) return undefined;

    const known = Object.prototype.hasOwnProperty.call(t.contributors, id);
    const alreadyOffered = known ? Math.max(0, Number(t.contributors[id].amt) || 0) : 0;
    const lifeRemaining = Math.max(0, lifeCeil - alreadyOffered);
    const goalRemaining = Math.max(0, (Number(t.goal) || 0) - (Number(t.progress) || 0));
    credited = Math.max(0, Math.min(requested, lifeRemaining, goalRemaining));

    if (credited <= 0) {
      if (!known) return undefined;                 /* nothing credited to a newcomer → don't add a row */
      t.contributors[id].name = name;               /* a known tither just refreshes their name */
      after = t;
      return t;
    }

    t.contributors[id] = { name, amt: alreadyOffered + credited };
    t.progress = (Number(t.progress) || 0) + credited;
    if (t.progress >= t.goal) {
      t.progress = t.goal;
      t.status = 'complete';
      t.completedAt = Date.now();
      justCompleted = true;
    }
    after = t;
    return t;
  });

  if (justCompleted) {
    try {
      const { setSkullEvent } = await import('./skull-clicker.js');
      await setSkullEvent(env, 'frenzy', FRENZY_MS);
    } catch (err) { console.error('[bone-tithe] completion frenzy failed:', err.message); }
  }

  return json({ ...publicState(after), credited });
}

export async function onRequestGet(context) {
  const { env } = context;
  const t = await env.MARKETPLACE.get(TITHE_KEY, 'json');
  /* Lock-free: the lifecycle is derived purely from stored timestamps, so every
     poller resolves the same status without a write. A fresh start overwrites a
     lingering record. */
  return json(publicState(t));
}

/**
 * A chatter's tithe. Silent on every rejection — no live goal, already
 * tithed and chat's share being full all look identical from chat.
 *
 * Everything is decided INSIDE the lock, like offer(): two chatters landing
 * together must not both spend the last of chat's share, and the goal must
 * not be completed twice.
 */
export async function titheFromChat(env, { userId, name }) {
  if (!userId) return { ok: false, reason: 'empty' };
  const id = String(userId);

  let credited = 0, justCompleted = false, tithers = 0;
  await env.MARKETPLACE.mutate(TITHE_KEY, (t) => {
    if (!t || publicState(t).status !== 'active') return undefined;

    t.chatTithers = (t.chatTithers && typeof t.chatTithers === 'object') ? t.chatTithers : {};
    if (Object.prototype.hasOwnProperty.call(t.chatTithers, id)) return undefined;   /* once each */
    const count = Object.keys(t.chatTithers).length;
    if (count >= MAX_CHAT_TITHERS) return undefined;

    t.contributors = (t.contributors && typeof t.contributors === 'object') ? t.contributors : {};
    const goal = Math.max(1, Math.floor(Number(t.goal) || 0));
    const already = Math.max(0, Math.floor((t.contributors[CHAT_ID] && t.contributors[CHAT_ID].amt) || 0));

    const perChatter = Math.max(1, Math.floor((goal * CHAT_SHARE) / CHAT_FULL_AT));
    const chatRemaining = Math.max(0, Math.floor(goal * CHAT_SHARE) - already);
    const goalRemaining = Math.max(0, goal - (Number(t.progress) || 0));
    credited = Math.min(perChatter, chatRemaining, goalRemaining);
    if (credited <= 0) return undefined;            /* share spent: nothing to record */

    t.chatTithers[id] = 1;
    tithers = count + 1;
    /* The name carries the headcount, so the overlay's contributor list shows
       how many people are behind it without a second field. */
    t.contributors[CHAT_ID] = { name: `Chat (${tithers})`, amt: already + credited };
    t.progress = (Number(t.progress) || 0) + credited;
    if (t.progress >= goal) {
      t.progress = goal;
      t.status = 'complete';
      t.completedAt = Date.now();
      justCompleted = true;
    }
    return t;
  });

  /* Fired outside the lock, exactly as offer() does — the frenzy is a second
     key and must not be written while this one is held. */
  if (justCompleted) {
    try {
      const { setSkullEvent } = await import('./skull-clicker.js');
      await setSkullEvent(env, 'frenzy', FRENZY_MS);
    } catch (err) { console.error('[bone-tithe] completion frenzy failed:', err.message); }
  }

  return { ok: credited > 0, credited, tithers, completed: justCompleted };
}

export async function onRequestPost(context) {
  const { env, request } = context;
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  /* ── Start a tithe — broadcaster/moderators only ── */
  if (body.action === 'start') {
    const session = getSession(request);
    const { isModerator } = await import('./admin/moderators.js');
    if (!(await isModerator(env, session))) {
      return json({ error: 'Only the broadcaster and moderators can start a Bone Tithe.' }, 403);
    }
    const goal = Math.min(MAX_GOAL, Math.max(MIN_GOAL, Math.floor(Number(body.goal) || DEFAULT_GOAL)));
    const minutes = Math.min(MAX_MINUTES, Math.max(0, Math.floor(Number(body.minutes) || 0)));
    const t = buildTithe({ goal, minutes, title: body.title });
    /* Under the lock, so an offering mid-commit on the old goal cannot write
       its record back over the new one. */
    await env.MARKETPLACE.mutate(TITHE_KEY, () => t);
    return json({ success: true, tithe: publicState(t) });
  }

  /* ── Stop a tithe — broadcaster/moderators only. An 'ended' marker (written
     under the lock, not deleted) so it reads as 'none' at once and a straggling
     offering cannot resurrect it. ── */
  if (body.action === 'stop') {
    const session = getSession(request);
    const { isModerator } = await import('./admin/moderators.js');
    if (!(await isModerator(env, session))) return json({ error: 'Moderators only.' }, 403);
    await env.MARKETPLACE.mutate(TITHE_KEY, () => ({ status: 'ended', endedAt: Date.now() }));
    return json({ success: true });
  }

  /* ── Offer toward the tithe — logged-in players only ── */
  if (body.action === 'offer') {
    const session = getSession(request);
    if (!session || !session.user_id) return json({ error: 'Log in to offer to the Bone Tithe.' }, 401);
    return offer(env, session, body);
  }

  return json({ error: 'Invalid action' }, 400);
}
