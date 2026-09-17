/* ══════════════════════════════════════════════
   MONTHLY GIVEAWAY — native entry ledger

   Replaces the Gleam dependency. Gleam was never actually configured:
   giveaway.html carried a placeholder embed while the drop messages told
   viewers to paste codes into it, so bonus entries went nowhere.

   HOW ENTRIES ARE EARNED
     - Redeeming a code dropped in chat, at /redeem. Claimable once per
       account by ANYONE, for five minutes from the drop.
     - Redeeming the "Enter Giveaway" channel points reward (1 entry).

   Both land in the same monthly ledger so the draw has one source of truth.

   REQUIRES the self-hosted server — mutate() and listValues() do not exist
   on a Cloudflare KV binding.
   ══════════════════════════════════════════════ */

const COOKIE_NAME = 'pham_session';
const LEDGER_PREFIX = 'gwe_';
const DROP_PREFIX = 'gwc_';

/** Codes are claimable for five minutes from the drop. */
export const DROP_WINDOW_SECONDS = 300;

/* A GIVEAWAY PRIZE IS NOT A DROP, AND ITS WINDOW SAYS SO.
   A dropped code is a race — five minutes, first come. A prize code belongs
   to exactly one person who has already won it, so there is nobody to race
   and no reason for it to expire while they are asleep. Seven days is long
   enough to survive a weekend away and short enough that the row does not
   live for ever. */
export const PRIZE_WINDOW_SECONDS = 7 * 86400;

const PRIZE_PREFIX = 'gwp_';

export function prizeKey(userId) {
  return `${PRIZE_PREFIX}${userId}`;
}

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

/* UTC, matching leaderboards.js and phamily-time.js. Using local time here
   would put a viewer's entry in a different month from their watch time on
   the last day of a month. */
export function monthKey(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Millisecond timestamp of the instant the current month's giveaway closes. */
export function monthEndsAt(d = new Date()) {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0, 0);
}

export function ledgerKey(userId, month) {
  return `${LEDGER_PREFIX}${userId}_${month}`;
}

export function dropKey(code) {
  return `${DROP_PREFIX}${String(code).trim().toUpperCase()}`;
}

/**
 * Add entries to a user's ledger for the current month.
 *
 * Under mutate() because this is genuinely contended: when a code drops,
 * dozens of viewers submit it within the same few seconds. An unlocked
 * read-modify-write would lose entries constantly rather than theoretically.
 *
 * @returns {Promise<number>} the user's new total for the month
 */
export async function addEntries(env, userId, username, count, source) {
  const n = Math.floor(Number(count) || 0);
  if (!userId || n <= 0) return 0;

  const month = monthKey();
  let total = 0;

  await env.MARKETPLACE.mutate(ledgerKey(userId, month), (current) => {
    const rec = current && current.month === month
      ? current
      : { userId: String(userId), username: username || '', month, entries: 0, history: [] };

    rec.entries = Number(rec.entries || 0) + n;
    rec.username = username || rec.username || '';
    /* Trimmed to the most recent 50. The history is for showing a viewer
       where their entries came from, not an audit log, and an unbounded
       array in a hot row grows every single drop. */
    rec.history = [...(rec.history || []), { source, entries: n, at: Date.now() }].slice(-50);

    total = rec.entries;
    return rec;
  });

  return total;
}

/**
 * Register a code that has just been dropped in chat, making it claimable
 * for DROP_WINDOW_SECONDS.
 *
 * The five-minute limit is enforced by the row's own expiry, not by a
 * comparison in a handler: kv.js filters expired rows out of every read, so
 * a late claim finds nothing rather than relying on someone remembering to
 * check a timestamp.
 */
export async function registerDropCode(env, code, tier, entries, opts = {}) {
  if (!code) return null;

  /* `lockedTo` turns a public code into one person's property. It is the
     whole of what "user locked" means: the code is still an ordinary row in
     the same family, claimed through the same endpoint, but redeemDropCode
     refuses everyone else — so a winner reading their code out on stream, or
     pasting it into the wrong window, loses nothing.

     A locked code never reaches the live-drop feed, which would otherwise
     publish a code nobody but the winner may use. */
  const lockedTo = opts.lockedTo ? String(opts.lockedTo) : null;
  const ttl = Math.max(60, Math.floor(Number(opts.ttlSeconds) || DROP_WINDOW_SECONDS));

  const record = {
    code: String(code).trim().toUpperCase(),
    tier: tier || 'common',
    entries: Math.floor(Number(entries) || 0),
    droppedAt: Date.now(),
    expiresAt: Date.now() + ttl * 1000,
    lockedTo,
    redeemedBy: [],
  };
  await env.MARKETPLACE.put(dropKey(record.code), JSON.stringify(record), {
    expirationTtl: ttl,
  });

  /* Every entry-code drop flows through here, so this is the one place that
     sees all of them — hype train, panel button and !drop alike. */
  if (opts.announce !== false && !lockedTo) {
    await recordLiveDrop(env, {
      kind: 'entries',
      code: record.code,
      rarity: record.tier,
      entries: record.entries,
      source: opts.source || 'manual',
      level: opts.level || null,
      expiresAt: record.expiresAt,
      redeemPath: '/giveaway',
    });
  }

  return record;
}

/**
 * Hand a won prize code to one viewer.
 *
 * Two rows, deliberately. The drop row is keyed by the CODE and is what
 * redeemDropCode checks; this one is keyed by the WINNER, so the giveaway
 * page can show someone their prize without them having to know the code
 * first. A whisper that never arrives — Twitch drops whispers from accounts
 * a viewer has never messaged — then costs nothing.
 */
export async function recordPrize(env, userId, prize) {
  if (!userId) return null;
  const rec = {
    userId: String(userId),
    code: String(prize.code || '').trim().toUpperCase(),
    tier: prize.tier || 'common',
    entries: Math.floor(Number(prize.entries) || 0),
    wonAt: Date.now(),
    expiresAt: Date.now() + PRIZE_WINDOW_SECONDS * 1000,
  };
  await env.MARKETPLACE.put(prizeKey(rec.userId), JSON.stringify(rec), {
    expirationTtl: PRIZE_WINDOW_SECONDS,
  });
  return rec;
}

/** The winner's prize, with whether it has been claimed yet. */
export async function getPrize(env, userId) {
  if (!userId) return null;
  const rec = await env.MARKETPLACE.get(prizeKey(userId), 'json');
  if (!rec || !rec.code) return null;

  /* Claimed-ness lives on the DROP row, not here, so a claim made by typing
     the code into the box shows up on this card too — one fact, one place.
     A missing drop row means the code has outlived its window, which reads
     the same way to the viewer as claimed: there is nothing left to do. */
  const drop = await env.MARKETPLACE.get(dropKey(rec.code), 'json');
  const claimed = !drop || (drop.redeemedBy || []).includes(String(userId));
  return { ...rec, claimed };
}

/* ══════════════════════════════════════════════
   THE LIVE DROP FEED

   One list of every code currently claimable, whatever dropped it.

   Before this, the site read hype_train_drops — written ONLY by
   hype-train.js. A code dropped from the panel or by !drop was registered as
   claimable and posted to chat, and appeared nowhere on the site at all:
   anyone who had tabbed away, scrolled past, or was reading the giveaway
   page in another window never saw it existed.

   Worse, hype-train.js DELETED that key when a train ended, so a code
   dropped at level 20 stayed claimable for its full five minutes while
   vanishing from the page the instant the train finished. The claim window
   and the display window disagreed.

   Entries here carry their own expiresAt and are pruned on write, so
   nothing else's lifecycle can clear a code that is still good.
   ══════════════════════════════════════════════ */

const LIVE_DROPS_KEY = 'live_drops';
const LIVE_DROPS_MAX = 40;

export async function recordLiveDrop(env, entry) {
  if (!entry || !entry.code) return;
  const now = Date.now();

  /* The overlay alert is raised here rather than at each call site, for the
     same reason the feed itself is: this is the single point every drop
     passes through, so nothing can be added later that reaches chat without
     reaching the screen. */
  const { pushOverlayEvent } = await import('./overlay/events.js');
  await pushOverlayEvent(env, {
    type: 'drop',
    kind: entry.kind,
    code: entry.code,
    rarity: entry.rarity,
    entries: entry.entries || null,
    itemName: entry.itemName || null,
    source: entry.source,
    level: entry.level || null,
    redeemPath: entry.redeemPath,
    expiresAt: entry.expiresAt,
  });
  await env.MARKETPLACE.mutate(LIVE_DROPS_KEY, (current) => {
    const list = current && Array.isArray(current.drops) ? current.drops : [];
    /* Prune by each entry's OWN expiry, never by an external event. */
    const live = list.filter(d => d && d.expiresAt > now && d.code !== entry.code);
    live.push({ ...entry, at: now });
    return { drops: live.slice(-LIVE_DROPS_MAX) };
  });
}

/** Everything still inside its claim window, newest first. */
export async function getLiveDrops(env) {
  const rec = await env.MARKETPLACE.get(LIVE_DROPS_KEY, 'json');
  const now = Date.now();
  return (rec && Array.isArray(rec.drops) ? rec.drops : [])
    .filter(d => d && d.expiresAt > now)
    .sort((a, b) => b.at - a.at);
}

/**
 * Claim a dropped code for one user.
 *
 * @returns {Promise<{ok: true, entries: number, total: number, tier: string}
 *                 | {ok: false, reason: 'unknown'|'already'|'locked'}>}
 */
export async function redeemDropCode(env, userId, username, code) {
  const key = dropKey(code);

  /* An expired code is filtered out by the read, so 'unknown' covers both
     "never existed" and "the five minutes are up". Deliberately the same
     answer for both: distinguishing them tells someone probing which codes
     were real. */
  const existing = await env.MARKETPLACE.get(key, 'json');
  if (!existing) return { ok: false, reason: 'unknown' };
  if ((existing.redeemedBy || []).includes(String(userId))) {
    return { ok: false, reason: 'already' };
  }
  /* A prize code belongs to the person who won it. Answered distinctly from
     'unknown' on purpose: this code IS real and its owner can see it on
     their own page, so pretending it does not exist would be a lie they
     could disprove in one click. */
  if (existing.lockedTo && String(existing.lockedTo) !== String(userId)) {
    return { ok: false, reason: 'locked' };
  }

  let claimed = false;
  let tier = existing.tier;
  let entries = existing.entries;

  await env.MARKETPLACE.mutate(key, (current) => {
    if (!current) return undefined;
    const list = current.redeemedBy || [];
    if (list.includes(String(userId))) return undefined;   // lost the race
    if (current.lockedTo && String(current.lockedTo) !== String(userId)) return undefined;
    claimed = true;
    tier = current.tier;
    entries = current.entries;
    return { ...current, redeemedBy: [...list, String(userId)] };
  });

  if (!claimed) return { ok: false, reason: 'already' };

  const total = await addEntries(env, userId, username, entries, `drop:${tier}`);
  return { ok: true, entries, total, tier };
}

/**
 * Everything the giveaway page shows. Works without a session — the
 * month-wide figures are public; only `you` needs a login.
 */
export async function getGiveawaySummary(env, session) {
  const month = monthKey();
  const rows = await env.MARKETPLACE.listValues({ prefix: LEDGER_PREFIX });

  let totalEntries = 0;
  let participants = 0;
  let you = null;

  for (const { value } of rows) {
    if (!value || value.month !== month) continue;
    const n = Number(value.entries || 0);
    if (n <= 0) continue;
    totalEntries += n;
    participants += 1;
    if (session && String(value.userId) === String(session.user_id)) {
      you = { entries: n, history: (value.history || []).slice(-10).reverse() };
    }
  }

  return {
    month,
    endsAt: monthEndsAt(),
    totalEntries,
    participants,
    loggedIn: !!session,
    you: session ? (you || { entries: 0, history: [] }) : null,
    prize: session ? await getPrize(env, session.user_id) : null,
  };
}

/* ── GET — the giveaway page's data ──────────── */

export async function onRequestGet(context) {
  const { env, request } = context;
  return json(await getGiveawaySummary(env, getSession(request)));
}

/* ── POST — redeem a dropped code ─────────────── */

export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);

  /* Login is required, by design: an entry has to belong to an account for
     the ledger to mean anything. The page gates on this too, but the check
     lives here so it cannot be bypassed by calling the API directly. */
  if (!session || !session.user_id) {
    return json({ error: 'Log in with Twitch to claim giveaway entries.' }, 401);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  const code = (body && body.code ? String(body.code) : '').trim().toUpperCase();
  if (!code) return json({ error: 'No code provided' }, 400);

  const result = await redeemDropCode(env, session.user_id, session.display_name, code);

  if (!result.ok) {
    if (result.reason === 'already') {
      return json({ error: 'You have already claimed this code.' }, 409);
    }
    if (result.reason === 'locked') {
      return json({ error: 'That code was won in a giveaway and only its winner can claim it.' }, 403);
    }
    return json({ error: 'That code is not valid, or the 5 minutes are up.' }, 404);
  }

  return json({
    success: true,
    entries: result.entries,
    tier: result.tier,
    total: result.total,
    month: monthKey(),
  });
}
