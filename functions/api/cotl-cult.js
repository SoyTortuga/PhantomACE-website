/* ══════════════════════════════════════════════
   CULT OF THE LAMB — CHAT NAMES THE FLOCK, AND THE SITE REMEMBERS.

     mod:   POST /api/cotl-cult { action: 'open' }            start a naming round
            POST /api/cotl-cult { action: 'lock' }            the top name wins
            POST /api/cotl-cult { action: 'cancel' }          nothing is named
            POST /api/cotl-cult { action: 'status', id, status }  alive → sacrificed/dead/ascended
     chat:  !name <name>
     all:   GET  /api/cotl-cult                               the live round
            GET  /api/cotl-cult?roster=1                      the permanent cult

   WHY THIS AND NOT A COPY OF THE OFFICIAL EXTENSION. Cult of the Lamb already
   ships a first-party Twitch integration that raffles viewers in as followers
   and feeds a devotion totem from channel points. It has real in-game hooks we
   cannot get, so duplicating it would be strictly worse. What it does NOT do is
   persist: when the stream ends, none of it survives, and none of it touches
   this site's accounts, entries or badges.

   THE NAMING VOTE IS THE DATA ENTRY. That is the whole trick. The game can tell
   us nothing, so a permanent roster would normally mean a moderator typing every
   follower in by hand — friction that does not survive a real stream. If chat
   does the naming, the record writes itself: the site already knows the name and
   who suggested it. Only a status change needs a button afterwards.

   FIRST SUGGESTER OWNS THE NAME. Several people will land on the same good name;
   credit goes to whoever said it first, and the later ones are counted as votes
   for it. Crediting the last, or a random one, would make it worth spamming.

   SILENT IN CHAT, like every chat mode here — the overlay carries the round.
   ══════════════════════════════════════════════ */

const ROUND_KEY = 'cotl_naming';
const FOLLOWER_PREFIX = 'cotl_follower_';

const ROUND_TTL = 14400;
const LOCKED_LINGER_MS = 45000;
const MAX_SUGGESTERS = 2000;
const NAME_MAX = 20;
const SHOWN = 5;

/* Being named is most of the prize; the entries are the part the official
   extension cannot give, so they match the common tier used everywhere else. */
const WIN_ENTRIES = 2;

const STATUSES = ['alive', 'sacrificed', 'dead', 'ascended'];

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

/* A follower name is free text — it is a name for a cartoon sheep, not an
   identifier — so this only bounds it and strips what would break a render.
   Chat is already moderated; this is not a word filter. */
export function cleanName(raw) {
  const s = String(raw == null ? '' : raw)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX);
  return s.length >= 2 ? s : null;
}

/** Case and spacing folded, so "Bleaty" and "bleaty " are one candidate. */
export function nameKey(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, '');
}

/* Name + timestamp alone is not unique: two followers given the SAME name in
   the same millisecond would collide and the second would overwrite the first,
   quietly erasing someone from a memorial. The random tail makes the id
   unique regardless, and it is an id, never shown. */
function slugFor(name, at) {
  const base = nameKey(name).replace(/[^a-z0-9]/g, '').slice(0, 24) || 'follower';
  const tail = Math.random().toString(36).slice(2, 8);
  return `${base}_${at.toString(36)}_${tail}`;
}

async function readRound(env) {
  try { return await env.MARKETPLACE.get(ROUND_KEY, 'json'); } catch { return null; }
}

function liveRound(round, now = Date.now()) {
  if (!round) return null;
  if (round.status === 'locked' && now - (round.lockedAt || 0) > LOCKED_LINGER_MS) return null;
  return round;
}

/**
 * Candidates, most-backed first. Ties break on who suggested it first, so a
 * name that has been up on screen does not get leapfrogged by a newcomer on
 * equal votes.
 */
export function tallyOf(round) {
  const byKey = new Map();
  for (const [userId, s] of Object.entries(round.suggestions || {})) {
    const k = nameKey(s.name);
    const cur = byKey.get(k);
    if (!cur) {
      byKey.set(k, { name: s.name, votes: 1, firstBy: userId, firstName: s.display, at: s.at });
    } else {
      cur.votes++;
      if (s.at < cur.at) { cur.at = s.at; cur.firstBy = userId; cur.firstName = s.display; cur.name = s.name; }
    }
  }
  return [...byKey.values()].sort((a, b) => (b.votes - a.votes) || (a.at - b.at));
}

/* ── Chat ────────────────────────────────────────────────────────────────── */

/**
 * One chatter's suggestion. A later one replaces their earlier one — nothing
 * here is hidden, so moving behind a name that is winning is the point.
 */
export async function nameFromChat(env, { userId, name, text }) {
  if (!userId) return { ok: false, reason: 'empty' };
  const clean = cleanName(text);
  if (!clean) return { ok: false, reason: 'bad-name' };

  const round = liveRound(await readRound(env));
  if (!round || round.status !== 'open') return { ok: false, reason: 'closed' };

  const id = String(userId);
  let outcome = { ok: false, reason: 'closed' };
  await env.MARKETPLACE.mutate(ROUND_KEY, (cur) => {
    if (!cur || cur.status !== 'open') return undefined;
    const had = !!cur.suggestions[id];
    if (!had && Object.keys(cur.suggestions).length >= MAX_SUGGESTERS) {
      outcome = { ok: false, reason: 'full' };
      return undefined;
    }
    if (had && nameKey(cur.suggestions[id].name) === nameKey(clean)) {
      outcome = { ok: false, reason: 'same' };
      return undefined;
    }
    cur.suggestions[id] = {
      name: clean,
      display: String(name || 'Someone').slice(0, 30),
      /* Kept so "who said it first" survives a later edit by someone else. */
      at: had ? cur.suggestions[id].at : Date.now(),
    };
    outcome = { ok: true, name: clean, changed: had };
    return cur;
  }, { expirationTtl: ROUND_TTL });

  return outcome;
}

/* ── Mod actions ─────────────────────────────────────────────────────────── */

export async function openRound(env) {
  await env.MARKETPLACE.put(ROUND_KEY, JSON.stringify({
    status: 'open',
    openedAt: Date.now(),
    lockedAt: 0,
    suggestions: {},
    winner: null,
  }), { expirationTtl: ROUND_TTL });
  return { ok: true };
}

/**
 * The top name wins, the follower is written to the permanent roster, and the
 * first person to suggest it is credited.
 *
 * The roster write and the entry credit both happen AFTER the round's lock is
 * released — they touch other keys, and holding this one open across them would
 * block the next !name.
 */
export async function lockRound(env) {
  let winner = null;
  await env.MARKETPLACE.mutate(ROUND_KEY, (cur) => {
    if (!cur || cur.status !== 'open') return undefined;
    const tally = tallyOf(cur);
    if (!tally.length) return undefined;
    const top = tally[0];
    winner = top;
    cur.status = 'locked';
    cur.lockedAt = Date.now();
    cur.winner = {
      name: top.name,
      votes: top.votes,
      namedBy: top.firstName,
      total: Object.keys(cur.suggestions).length,
    };
    return cur;
  }, { expirationTtl: ROUND_TTL });

  if (!winner) return { ok: false, error: 'Nobody has suggested a name yet.' };

  const at = Date.now();
  const id = slugFor(winner.name, at);
  const follower = {
    id,
    name: winner.name,
    namedBy: { userId: String(winner.firstBy), displayName: winner.firstName },
    votes: winner.votes,
    joinedAt: at,
    status: 'alive',
    statusAt: at,
  };
  try {
    await env.MARKETPLACE.put(FOLLOWER_PREFIX + id, JSON.stringify(follower));
  } catch (err) {
    console.error('[cotl-cult] could not record the follower:', err.message);
  }

  /* Entries only for an account that exists — profile_<id> is written on every
     login, and crediting a Twitch id that has never signed in would seed the
     monthly draw with an entrant it cannot pay. Same rule as MTGBBB's guesses. */
  let paid = false;
  try {
    const profile = await env.MARKETPLACE.get(`profile_${winner.firstBy}`, 'json');
    if (profile) {
      const { addEntries } = await import('./giveaway-entries.js');
      await addEntries(env, String(winner.firstBy), winner.firstName, WIN_ENTRIES, `cotl-name:${id}`);
      paid = true;
    }
  } catch (err) {
    console.error('[cotl-cult] could not credit the namer:', err.message);
  }

  if (paid) {
    await env.MARKETPLACE.mutate(ROUND_KEY, (cur) => {
      if (!cur || !cur.winner) return undefined;
      cur.winner.paid = true;
      return cur;
    }, { expirationTtl: ROUND_TTL });
  }

  return { ok: true, follower, paid };
}

export async function cancelRound(env) {
  try { await env.MARKETPLACE.delete(ROUND_KEY); } catch { /* best effort */ }
  return { ok: true };
}

/** Mark what became of someone. The memorial is the point; nothing is deleted. */
export async function setStatus(env, id, status) {
  if (!STATUSES.includes(status)) return { ok: false, error: 'Unknown status.' };
  let found = false;
  await env.MARKETPLACE.mutate(FOLLOWER_PREFIX + String(id), (cur) => {
    if (!cur) return undefined;
    found = true;
    cur.status = status;
    cur.statusAt = Date.now();
    return cur;
  });
  return found ? { ok: true } : { ok: false, error: 'No such follower.' };
}

/** The whole cult, newest first. */
export async function readRoster(env) {
  let rows = [];
  try { rows = await env.MARKETPLACE.listValues({ prefix: FOLLOWER_PREFIX }); } catch { return []; }
  return rows
    .map(r => r.value)
    .filter(f => f && f.id && f.name)
    /* Ties broken on the id so the order never changes between two reads —
       a memorial that reshuffles itself on refresh reads as broken. */
    .sort((a, b) => ((b.joinedAt || 0) - (a.joinedAt || 0)) || (a.id < b.id ? 1 : -1));
}

/* ── Routes ──────────────────────────────────────────────────────────────── */

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);

  if (url.searchParams.get('roster')) {
    const all = await readRoster(env);
    const counts = { alive: 0, sacrificed: 0, dead: 0, ascended: 0 };
    for (const f of all) if (counts[f.status] !== undefined) counts[f.status]++;
    /* No user ids in the public answer — a name and who named them is the
       whole record anyone needs, and ids are not ours to publish. */
    return json({
      total: all.length,
      counts,
      followers: all.map(f => ({
        id: f.id, name: f.name, namedBy: f.namedBy ? f.namedBy.displayName : null,
        joinedAt: f.joinedAt, status: f.status, statusAt: f.statusAt,
      })),
    });
  }

  const round = liveRound(await readRound(env));
  if (!round) return json({ status: 'none' });
  if (round.status === 'locked') return json({ status: 'locked', winner: round.winner });

  const tally = tallyOf(round);
  return json({
    status: 'open',
    total: Object.keys(round.suggestions || {}).length,
    tally: tally.slice(0, SHOWN).map(t => ({ name: t.name, votes: t.votes, by: t.firstName })),
    entries: WIN_ENTRIES,
  });
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);

  const { isModerator } = await import('./admin/moderators.js');
  if (!(await isModerator(env, session))) {
    return json({ error: 'Only the broadcaster and moderators can run the cult.' }, 403);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }
  const action = String(body.action || '');

  if (action === 'open') { await openRound(env); return json({ success: true }); }
  if (action === 'lock') {
    const r = await lockRound(env);
    return r.ok ? json({ success: true, follower: r.follower, paid: r.paid }) : json({ error: r.error }, 400);
  }
  if (action === 'cancel') { await cancelRound(env); return json({ success: true }); }
  if (action === 'status') {
    const r = await setStatus(env, body.id, String(body.status || ''));
    return r.ok ? json({ success: true }) : json({ error: r.error }, 400);
  }
  return json({ error: 'Unknown action' }, 400);
}
