/* ══════════════════════════════════════════════
   MONTHLY GIVEAWAY — native entry ledger

   Replaces the Gleam dependency. Gleam was never actually configured:
   giveaway.html carried a placeholder embed while the drop messages told
   viewers to paste codes into it, so bonus entries went nowhere.

   HOW ENTRIES ARE EARNED
     - Redeeming a code dropped in chat, at /redeem. Claimable once per
       account by ANYONE, for five minutes from the drop.
     - Redeeming the "Enter Giveaway" channel points reward (1 entry).
     - The FREE alternate method of entry (AMOE): one entry per account per
       month, claimed on the giveaway page with no purchase, sub or watch
       time. Required so the sweepstakes has a no-strings path to enter; see
       claimFreeEntry below.

   All land in the same monthly ledger so the draw has one source of truth.

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
  const match = cookie.match(/(?:^|;\s*)pham_session=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match[1])); } catch { return null; }
}

/* The month boundary lives in the shared season calendar (SEASON_TZ, not UTC)
   so a viewer's entries and their Phamily Time watch minutes always land in the
   same month. Imported for internal use AND re-exported for the many callers
   that import these from this module. */
import { monthKey, prevMonthKey, monthEndsAt } from './season-time.js';
export { monthKey, prevMonthKey, monthEndsAt };

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

/** The free alternate method of entry grants exactly this many entries. */
export const AMOE_ENTRIES = 1;

/**
 * Claim the FREE alternate method of entry for the current month.
 *
 * Sweepstakes need a way in that costs nothing — no purchase, sub, or watch
 * time — and that path must be worth the same as any single earned entry, so
 * this grants one entry, the same unit a maze clear or a channel-points
 * redemption gives.
 *
 * One per account per month. The guarantee is a durable `amoeClaimed` flag on
 * the ledger row, checked and set inside the SAME mutate() that adds the entry,
 * so two taps in the same instant can't both pass. The flag is preferred over
 * reading `history` for the marker because history is trimmed to the last 50
 * entries and a busy month would lose it.
 *
 * @returns {Promise<{ok: true, total: number} | {ok: false, reason: 'already'}>}
 */
export async function claimFreeEntry(env, userId, username) {
  if (!userId) return { ok: false, reason: 'already' };

  const month = monthKey();
  let granted = false;
  let total = 0;

  await env.MARKETPLACE.mutate(ledgerKey(userId, month), (current) => {
    const rec = current && current.month === month
      ? current
      : { userId: String(userId), username: username || '', month, entries: 0, history: [] };

    if (rec.amoeClaimed) { total = Number(rec.entries || 0); return undefined; }

    rec.amoeClaimed = true;
    rec.entries = Number(rec.entries || 0) + AMOE_ENTRIES;
    rec.username = username || rec.username || '';
    rec.history = [...(rec.history || []), { source: 'amoe', entries: AMOE_ENTRIES, at: Date.now() }].slice(-50);

    granted = true;
    total = rec.entries;
    return rec;
  });

  return granted ? { ok: true, total } : { ok: false, reason: 'already', total };
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
  /* overlayAlert:false suppresses only the on-screen "claim the code" card,
     not the chat message or the live-drops feed below. Dino egg drops use this
     — they have their own egg-video alert, so the standard drop card would be a
     duplicate. Every other drop keeps its card (default on). */
  if (entry.overlayAlert !== false) {
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
  }
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
      you = { entries: n, history: (value.history || []).slice(-10).reverse(), amoeClaimed: !!value.amoeClaimed };
    }
  }

  return {
    month,
    endsAt: monthEndsAt(),
    totalEntries,
    participants,
    loggedIn: !!session,
    you: session ? (you || { entries: 0, history: [], amoeClaimed: false }) : null,
    prize: session ? await getPrize(env, session.user_id) : null,
  };
}

/* ══════════════════════════════════════════════
   THE MONTHLY LEDGER DRAW

   The ledger accumulates entries all month (bingo, maze, scramble, check-ins,
   chat drops, Phamily Time). This is the draw that turns it into a winner.

   WEIGHTED, unlike the Big Prize channel-points spin: a viewer who earned 90
   entries this month should win nine times as often as one who earned 10, so
   the pick is probability ∝ entries, not one-slice-each.

   GUESTS NEVER WIN A REAL PRIZE. A guest_ id is a throwaway local identity
   with no account behind it to hand a code to — the same rule leaderboards.js
   and the Big Prize draw apply to their winners.

   The RNG is injectable so the weighting can be tested deterministically
   (server/scripts/test-giveaway-monthly.js), and nothing here mutates the
   ledger — a draw is a read.
   ══════════════════════════════════════════════ */

function isGuestId(id) {
  return String(id).startsWith('guest_');
}

/** Current month's real (non-guest) entry totals, without drawing anyone. */
export async function monthlyLedgerTotals(env, month = monthKey()) {
  const rows = await env.MARKETPLACE.listValues({ prefix: LEDGER_PREFIX });
  let totalEntries = 0;
  let totalPeople = 0;
  for (const { value } of rows) {
    if (!value || value.month !== month) continue;
    const n = Math.floor(Number(value.entries || 0));
    if (n <= 0 || isGuestId(value.userId)) continue;
    totalEntries += n;
    totalPeople += 1;
  }
  return { month, totalEntries, totalPeople };
}

/**
 * Draw ONE winner from a month's ledger, weighted by entry count.
 *
 * @param {object} env
 * @param {object} [opts]
 * @param {string} [opts.month]  YYYY-MM; defaults to the current UTC month.
 * @param {function} [opts.rng]  0..1 source, injectable for deterministic tests.
 * @returns {Promise<{winner: {userId,username,entries}|null,
 *                    entrants: Array<{userId,username,entries}>,
 *                    totalEntries: number, totalPeople: number, month: string}>}
 *          winner is null when the month has no non-guest entrants — a clean
 *          "nobody has entered" the caller turns into an error, not a throw.
 */
export async function drawMonthlyWinner(env, opts = {}) {
  const month = opts.month || monthKey();
  const rng = typeof opts.rng === 'function' ? opts.rng : Math.random;

  const rows = await env.MARKETPLACE.listValues({ prefix: LEDGER_PREFIX });
  const entrants = [];
  let totalEntries = 0;
  for (const { value } of rows) {
    if (!value || value.month !== month) continue;
    const n = Math.floor(Number(value.entries || 0));
    if (n <= 0 || isGuestId(value.userId)) continue;
    entrants.push({ userId: String(value.userId), username: value.username || '', entries: n });
    totalEntries += n;
  }

  if (!entrants.length || totalEntries <= 0) {
    return { winner: null, entrants: [], totalEntries: 0, totalPeople: 0, month };
  }

  /* Stable order (most entries first, then userId) so an injected RNG maps to
     a deterministic winner — the whole point of making rng injectable. */
  entrants.sort((a, b) => (b.entries - a.entries) || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));

  /* One ticket in [0, totalEntries); walk the cumulative weights. Each
     entrant owns a band the width of their entries, so the chance of landing
     in it is exactly entries / totalEntries. */
  let ticket = rng() * totalEntries;
  let winner = entrants[entrants.length - 1];
  for (let i = 0; i < entrants.length; i++) {
    ticket -= entrants[i].entries;
    if (ticket < 0) { winner = entrants[i]; break; }
  }

  return { winner, entrants, totalEntries, totalPeople: entrants.length, month };
}

/* How many names the cosmetic reel shows. Bounded so a month with two
   thousand entrants still spins a fixed-size strip. */
const REEL_POOL_CAP = 48;

/**
 * A BOUNDED, WEIGHTED display pool for the on-stream reel.
 *
 * The reel is cosmetic — the server's weighted pick above is authoritative —
 * but it should LOOK weighted: a viewer with more entries flicks past more
 * often. Sampling with replacement in proportion to entries gives that, and
 * caps the strip length regardless of how many people entered. The winner is
 * then forced into one known slot so PhamReel.strip lands the reel on the name
 * the server actually drew.
 *
 * @returns {{pool: Array<{username:string}>, winnerIndex: number}}
 */
export function buildWeightedReelPool(entrants, winner, opts = {}) {
  const rng = typeof opts.rng === 'function' ? opts.rng : Math.random;
  const cap = Math.max(1, Math.floor(opts.cap || REEL_POOL_CAP));
  const list = (Array.isArray(entrants) ? entrants : [])
    .filter(e => e && e.username != null && Math.floor(Number(e.entries) || 0) > 0);

  if (!winner) return { pool: [], winnerIndex: 0 };
  if (!list.length) return { pool: [{ username: winner.username }], winnerIndex: 0 };

  const total = list.reduce((s, e) => s + Math.floor(Number(e.entries) || 0), 0);
  const pool = [];
  for (let i = 0; i < cap; i++) {
    let ticket = rng() * total;
    let pick = list[list.length - 1];
    for (let j = 0; j < list.length; j++) {
      ticket -= Math.floor(Number(list[j].entries) || 0);
      if (ticket < 0) { pick = list[j]; break; }
    }
    pool.push({ username: pick.username });
  }

  /* Guarantee the drawn winner is on the strip, at a slot we return, so the
     reel's landing row is always the real winner however the sampling fell. */
  const idx = Math.min(cap - 1, Math.floor(rng() * cap));
  pool[idx] = { username: winner.username };
  return { pool, winnerIndex: idx };
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
