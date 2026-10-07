/* ══════════════════════════════════════════════
   MTGBBB — GUESS THE RARE, from chat.

   Chat watches a box get cracked and, until now, could only play along by
   opening the site. This is the surface for everyone who will not: when the
   host clicks the pack counter forward, a short window opens and anyone can
   name the rare they think is coming.

     !guess <card name>          one per chatter per pack, first one counts

   ENTIRELY SILENT IN CHAT. A box is thirty packs; a bot line per guess, or
   even per resolution, would be thirty to several hundred messages in an hour.
   The overlay panel is the whole feedback loop — it shows the window closing,
   how many are in, and who called it. Same rule as !hit / !clash / !wind /
   !catch.

   THE FIRST GUESS LOCKS. A later one from the same chatter is ignored rather
   than replacing it: the pulls stream in while the window is open, so letting
   people re-guess would let them wait for information and then "call" it.

   MATCHING IS FORGIVING, because people type into a chat box at speed — case,
   punctuation and spacing are discarded, and a unique prefix is enough
   ("!guess sheoldred" finds Sheoldred, the Apocalypse). An ambiguous or
   unknown name is dropped silently; there is nowhere to report it to that is
   not chat spam.

   WINNING PAYS ONLY AN ACCOUNT THAT EXISTS. Entries land for a chatter who has
   logged in at least once (`profile_<id>`, written on every login). A chat-only
   winner is still named on the overlay and the panel tells them what logging in
   would have been worth — crediting a Twitch id that has never logged in would
   put un-payable entrants into the monthly draw.
   ══════════════════════════════════════════════ */

const KEY = 'mtgbbb_guess';

/* The window is a pack, not a clock — it closes when the rare is marked. The
   timer is the backstop for a pack the host never finishes marking, and the
   TTL is the backstop for a stream that ends mid-pack. */
const WINDOW_MS = 120000;
const RESULT_LINGER_MS = 12000;
const KEY_TTL = 3600;

/* The ceiling every chat mode on this site carries. A box crack in a big
   stream is the one time this could plausibly be approached. */
const MAX_GUESSERS = 2000;

/* What a correct call is worth, matching the common tier everywhere else
   (TIER_INFO in bot/send-chat.js). */
const WIN_ENTRIES = 2;
const WINNERS_SHOWN = 6;

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extraHeaders },
  });
}

/** Case, spacing and punctuation all discarded — people type fast in chat. */
function normalise(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Resolve what someone typed against the room's frozen pool.
 * Exact normalised hit wins outright; otherwise a prefix match, but only when
 * exactly one card matches — "!guess the" must not silently pick a card.
 * Returns the pool's canonical name, or null.
 */
export function matchCard(pool, typed) {
  const q = normalise(typed);
  if (q.length < 3) return null;                 // too short to mean anything
  let prefix = null, prefixCount = 0;
  for (const name of pool) {
    const n = normalise(name);
    if (n === q) return name;
    if (n.startsWith(q)) { prefix = name; prefixCount++; }
  }
  return prefixCount === 1 ? prefix : null;
}

async function readRound(env) {
  try { return await env.MARKETPLACE.get(KEY, 'json'); } catch { return null; }
}

/** The live round, with an expired window already reported as closed. */
function liveView(round, now = Date.now()) {
  if (!round) return null;
  if (round.status === 'resolved') {
    return (now - (round.resolvedAt || 0) > RESULT_LINGER_MS) ? null : round;
  }
  if (now > (round.closesAt || 0)) return null;
  return round;
}

/**
 * Open a window on this pack. Called when the host clicks the pack counter
 * forward — that click is the only moment in the flow that means "new pack".
 * An unresolved previous round is simply replaced; a pack nobody guessed on is
 * not worth carrying.
 */
export async function openGuessRound(env, { code, pack }) {
  const now = Date.now();
  await env.MARKETPLACE.put(KEY, JSON.stringify({
    code: String(code || '').toUpperCase(),
    pack: Number(pack) || 0,
    status: 'open',
    openedAt: now,
    closesAt: now + WINDOW_MS,
    guesses: {},
    count: 0,
    result: null,
    resolvedAt: 0,
  }), { expirationTtl: KEY_TTL });
}

/**
 * One chatter's call. Silent on every rejection — a closed window, an unknown
 * card and a second guess all look identical from chat, on purpose.
 */
export async function guessFromChat(env, { userId, name, text }) {
  if (!userId || !text) return { ok: false, reason: 'empty' };

  const round = liveView(await readRound(env));
  if (!round || round.status !== 'open') return { ok: false, reason: 'closed' };

  /* The pool comes from the room, so a guess can only ever be a card that is
     actually in this set — the same list the host marks from. */
  let pool = [];
  try {
    const room = await env.MARKETPLACE.get(`mtgbbb_${round.code}`, 'json');
    if (!room || room.status === 'ended') return { ok: false, reason: 'no-room' };
    pool = (room.pool || []).map(c => c.name);
  } catch { return { ok: false, reason: 'no-room' }; }

  const card = matchCard(pool, text);
  if (!card) return { ok: false, reason: 'no-match' };

  const id = String(userId);
  let outcome = { ok: false, reason: 'closed' };
  await env.MARKETPLACE.mutate(KEY, (cur) => {
    if (!cur || cur.status !== 'open' || Date.now() > (cur.closesAt || 0)) return undefined;
    if (cur.guesses[id]) { outcome = { ok: false, reason: 'already' }; return undefined; }
    if ((cur.count || 0) >= MAX_GUESSERS) { outcome = { ok: false, reason: 'full' }; return undefined; }
    cur.guesses[id] = { name: String(name || 'Someone').slice(0, 30), card };
    cur.count = Object.keys(cur.guesses).length;
    outcome = { ok: true, card };
    return cur;
  }, { expirationTtl: KEY_TTL });

  return outcome;
}

/**
 * The rare landed. Everyone who named it wins.
 *
 * Called after mark.js has written the pull, never inside its lock: paying
 * entries is a second store and a slow one, and the room's lock must not be
 * held open across it.
 */
export async function resolveGuessRound(env, { code, card }) {
  const now = Date.now();
  let winners = [];
  let pack = 0;

  await env.MARKETPLACE.mutate(KEY, (cur) => {
    if (!cur || cur.status !== 'open') return undefined;
    if (cur.code !== String(code || '').toUpperCase()) return undefined;

    pack = cur.pack || 0;
    winners = Object.entries(cur.guesses || {})
      .filter(([, g]) => g.card === card)
      .map(([id, g]) => ({ userId: id, name: g.name }));

    cur.status = 'resolved';
    cur.resolvedAt = now;
    cur.result = {
      card,
      /* Trimmed for the panel. `total` keeps the real number, so "+4 more"
         is honest when a popular card lands. */
      winners: winners.slice(0, WINNERS_SHOWN).map(w => ({ name: w.name, paid: false })),
      total: winners.length,
      guessed: cur.count || 0,
    };
    return cur;
  }, { expirationTtl: KEY_TTL });

  if (!winners.length) return { winners: 0, paid: 0 };

  /* Entries only for an account that exists. profile_<id> is written on every
     login, so its absence means this person has never signed in and crediting
     them would seed the monthly draw with an entrant it cannot pay. */
  let paid = 0;
  const paidNames = new Set();
  for (const w of winners) {
    try {
      const profile = await env.MARKETPLACE.get(`profile_${w.userId}`, 'json');
      if (!profile) continue;
      const { addEntries } = await import('./giveaway-entries.js');
      await addEntries(env, w.userId, w.name, WIN_ENTRIES, `mtgbbb-guess:pack${pack}`);
      paid++;
      paidNames.add(w.name);
    } catch (err) {
      console.error('[mtgbbb-chat] could not credit a winner:', err.message);
    }
  }

  /* Mark who actually got paid, so the panel can show the rest what signing in
     would have been worth instead of implying they were shorted. */
  if (paidNames.size) {
    await env.MARKETPLACE.mutate(KEY, (cur) => {
      if (!cur || !cur.result) return undefined;
      cur.result.winners = cur.result.winners.map(w => ({ ...w, paid: paidNames.has(w.name) }));
      cur.result.paid = paid;
      return cur;
    }, { expirationTtl: KEY_TTL });
  }

  return { winners: winners.length, paid };
}

/** Take the panel down — the host ended the box, or the round is stale. */
export async function clearGuessRound(env) {
  try { await env.MARKETPLACE.delete(KEY); } catch { /* best effort */ }
}

/* ── The overlay's read ──────────────────────────────────────────────────── */
export async function onRequestGet(context) {
  const round = liveView(await readRound(context.env));
  if (!round) return json({ status: 'none' });

  if (round.status === 'resolved') {
    return json({
      status: 'resolved',
      pack: round.pack,
      result: round.result,
      entries: WIN_ENTRIES,
    });
  }

  return json({
    status: 'open',
    pack: round.pack,
    /* Seconds, computed server-side: an OBS source whose clock has drifted
       would otherwise count down against the wrong zero. */
    secondsLeft: Math.max(0, Math.round((round.closesAt - Date.now()) / 1000)),
    count: round.count || 0,
    entries: WIN_ENTRIES,
  });
}
