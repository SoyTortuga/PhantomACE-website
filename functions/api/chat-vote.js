/* ══════════════════════════════════════════════
   CHAT VOTE — one panel, any game, any question.

     mod:   POST /api/chat-vote { action:'open', question, options? }
            POST /api/chat-vote { action:'lock' }     the leader wins
            POST /api/chat-vote { action:'cancel' }   nothing wins
     chat:  !vote <number | option | anything>
     OBS:   GET  /api/chat-vote

   WHY GENERIC. Most of what he streams has no integration at all and never
   will — there is no API to read, and building a bespoke chat layer per game
   does not scale past the two or three worth the effort. What every game does
   have is moments where he is choosing between things on screen. This turns
   any of them into a vote in about five seconds.

   It started as a Cult of the Lamb follower-naming round, which turned out to
   duplicate that game's own Twitch extension (it already raffles viewers in as
   named followers and ships a follower gallery). The machinery was most of the
   way to something that is not redundant anywhere, so it became this.

   TWO MODES, decided by whether options were supplied:
   - FIXED: he lists the choices he is looking at. Chat votes by number or by
     name, and anything else is dropped. The tally cannot be derailed.
   - OPEN: no options. Chat suggests anything and identical answers merge. Good
     for naming things; bad anywhere a troll pile-on would be a problem, which
     is why fixed is the default shape of the control.

   REWARDS DIFFER BY MODE, on purpose. Open mode credits the FIRST person to
   suggest the winning answer — it is a contest, and someone won it. Fixed mode
   credits nobody: picking the popular option out of four is a group decision,
   not an achievement, and paying everyone who clicked the winner would mint
   hundreds of entries a stream.

   SILENT IN CHAT. The overlay carries the question and the tally.
   ══════════════════════════════════════════════ */

const KEY = 'chat_vote';

const TTL = 14400;
const LOCKED_LINGER_MS = 45000;
const MAX_VOTERS = 5000;
const QUESTION_MAX = 70;
const ANSWER_MAX = 28;
const MAX_OPTIONS = 6;
const SHOWN = 6;

/* Matches the common tier used everywhere else on the site. */
const WIN_ENTRIES = 2;

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

/* Bounded and stripped of what would break a render. Chat is already
   moderated; this is not a word filter. */
export function clean(raw, max) {
  const s = String(raw == null ? '' : raw)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
  return s.length ? s : null;
}

/** Case and spacing folded, so one answer is one candidate. */
export function answerKey(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, '');
}

async function read(env) {
  try { return await env.MARKETPLACE.get(KEY, 'json'); } catch { return null; }
}

function live(vote, now = Date.now()) {
  if (!vote) return null;
  if (vote.status === 'locked' && now - (vote.lockedAt || 0) > LOCKED_LINGER_MS) return null;
  return vote;
}

/**
 * Resolve what someone typed to a candidate.
 * FIXED: a 1-based number, an exact name, or a unique prefix. An ambiguous
 * prefix resolves to nothing — a vote must never land on an option the voter
 * did not choose.
 * OPEN: anything, cleaned.
 */
export function resolveAnswer(vote, typed) {
  const raw = clean(typed, ANSWER_MAX);
  if (!raw) return null;

  if (vote.mode === 'open') return raw;

  const opts = vote.options || [];
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 1 && n <= opts.length) return opts[n - 1];

  const q = answerKey(raw);
  let prefix = null, count = 0;
  for (const o of opts) {
    const k = answerKey(o);
    if (k === q) return o;
    if (k.startsWith(q)) { prefix = o; count++; }
  }
  return count === 1 ? prefix : null;
}

/**
 * Candidates, most-backed first. Ties break on who got there first, so a
 * candidate already on screen is not leapfrogged on equal votes.
 */
export function tallyOf(vote) {
  const byKey = new Map();
  for (const [userId, v] of Object.entries(vote.votes || {})) {
    const k = answerKey(v.answer);
    const cur = byKey.get(k);
    if (!cur) {
      byKey.set(k, { answer: v.answer, votes: 1, firstBy: userId, firstName: v.display, at: v.at });
    } else {
      cur.votes++;
      if (v.at < cur.at) { cur.at = v.at; cur.firstBy = userId; cur.firstName = v.display; cur.answer = v.answer; }
    }
  }
  const out = [...byKey.values()].sort((a, b) => (b.votes - a.votes) || (a.at - b.at));

  /* Fixed mode shows every option, including the ones nobody picked — a bar
     chart that hides the losers makes a 5-0 look the same as a 5-4. */
  if (vote.mode === 'fixed') {
    const seen = new Set(out.map(o => answerKey(o.answer)));
    for (const o of vote.options || []) {
      if (!seen.has(answerKey(o))) out.push({ answer: o, votes: 0, firstBy: null, firstName: null, at: Infinity });
    }
  }
  return out;
}

/* ── Chat ────────────────────────────────────────────────────────────────── */

/** One vote per chatter, changeable while open — nothing here is hidden. */
export async function voteFromChat(env, { userId, name, text }) {
  if (!userId) return { ok: false, reason: 'empty' };

  const vote = live(await read(env));
  if (!vote || vote.status !== 'open') return { ok: false, reason: 'closed' };

  const answer = resolveAnswer(vote, text);
  if (!answer) return { ok: false, reason: 'no-match' };

  const id = String(userId);
  let outcome = { ok: false, reason: 'closed' };
  await env.MARKETPLACE.mutate(KEY, (cur) => {
    if (!cur || cur.status !== 'open') return undefined;
    const had = !!cur.votes[id];
    if (!had && Object.keys(cur.votes).length >= MAX_VOTERS) {
      outcome = { ok: false, reason: 'full' };
      return undefined;
    }
    if (had && answerKey(cur.votes[id].answer) === answerKey(answer)) {
      outcome = { ok: false, reason: 'same' };
      return undefined;
    }
    cur.votes[id] = {
      answer,
      display: String(name || 'Someone').slice(0, 30),
      /* Kept across an edit so "who said it first" survives someone else
         changing their mind later. */
      at: had ? cur.votes[id].at : Date.now(),
    };
    outcome = { ok: true, answer, changed: had };
    return cur;
  }, { expirationTtl: TTL });

  return outcome;
}

/* ── Mod actions ─────────────────────────────────────────────────────────── */

export async function openVote(env, { question, options }) {
  const q = clean(question, QUESTION_MAX);
  if (!q) return { ok: false, error: 'Give the vote a question.' };

  const opts = (Array.isArray(options) ? options : [])
    .map(o => clean(o, ANSWER_MAX))
    .filter(Boolean)
    .slice(0, MAX_OPTIONS);

  /* One option is not a vote, and duplicates would split their own tally. */
  const unique = [];
  const seen = new Set();
  for (const o of opts) {
    const k = answerKey(o);
    if (!seen.has(k)) { seen.add(k); unique.push(o); }
  }
  if (opts.length && unique.length < 2) {
    return { ok: false, error: 'A fixed vote needs at least two different options.' };
  }

  await env.MARKETPLACE.put(KEY, JSON.stringify({
    question: q,
    mode: unique.length ? 'fixed' : 'open',
    options: unique,
    status: 'open',
    openedAt: Date.now(),
    lockedAt: 0,
    votes: {},
    winner: null,
  }), { expirationTtl: TTL });
  return { ok: true, mode: unique.length ? 'fixed' : 'open' };
}

/**
 * Freeze it and name the winner. Computed ONCE and stored — recomputing it on
 * every overlay poll would let a vote that slipped in under the lock change
 * what is already on screen.
 */
export async function lockVote(env) {
  let winner = null;
  let mode = 'fixed';
  await env.MARKETPLACE.mutate(KEY, (cur) => {
    if (!cur || cur.status !== 'open') return undefined;
    const tally = tallyOf(cur).filter(t => t.votes > 0);
    if (!tally.length) return undefined;
    winner = tally[0];
    mode = cur.mode;
    cur.status = 'locked';
    cur.lockedAt = Date.now();
    cur.winner = {
      answer: winner.answer,
      votes: winner.votes,
      total: Object.keys(cur.votes).length,
      by: cur.mode === 'open' ? winner.firstName : null,
    };
    return cur;
  }, { expirationTtl: TTL });

  if (!winner) return { ok: false, error: 'Nobody has voted yet.' };

  /* Only open mode has someone to credit. Entries land only for an account
     that exists — profile_<id> is written on every login, and crediting a
     Twitch id that never signed in would seed the monthly draw with an
     entrant it cannot pay. */
  let paid = false;
  if (mode === 'open' && winner.firstBy) {
    try {
      const profile = await env.MARKETPLACE.get(`profile_${winner.firstBy}`, 'json');
      if (profile) {
        const { addEntries } = await import('./giveaway-entries.js');
        await addEntries(env, String(winner.firstBy), winner.firstName, WIN_ENTRIES, 'chat-vote');
        paid = true;
      }
    } catch (err) {
      console.error('[chat-vote] could not credit the winner:', err.message);
    }
    if (paid) {
      await env.MARKETPLACE.mutate(KEY, (cur) => {
        if (!cur || !cur.winner) return undefined;
        cur.winner.paid = true;
        return cur;
      }, { expirationTtl: TTL });
    }
  }

  return { ok: true, winner: winner.answer, paid };
}

export async function cancelVote(env) {
  try { await env.MARKETPLACE.delete(KEY); } catch { /* best effort */ }
  return { ok: true };
}

/* ── Routes ──────────────────────────────────────────────────────────────── */

export async function onRequestGet(context) {
  const vote = live(await read(context.env));
  if (!vote) return json({ status: 'none' });

  if (vote.status === 'locked') {
    return json({ status: 'locked', question: vote.question, mode: vote.mode, winner: vote.winner });
  }

  const tally = tallyOf(vote);
  return json({
    status: 'open',
    question: vote.question,
    mode: vote.mode,
    total: Object.keys(vote.votes || {}).length,
    tally: tally.slice(0, SHOWN).map((t, i) => ({
      answer: t.answer,
      votes: t.votes,
      /* The number chat types, shown beside each option in fixed mode. */
      n: vote.mode === 'fixed' ? (vote.options || []).indexOf(t.answer) + 1 : 0,
      by: vote.mode === 'open' ? t.firstName : null,
    })),
    entries: vote.mode === 'open' ? WIN_ENTRIES : 0,
  });
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);

  const { isModerator } = await import('./admin/moderators.js');
  if (!(await isModerator(env, session))) {
    return json({ error: 'Only the broadcaster and moderators can run a vote.' }, 403);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }
  const action = String(body.action || '');

  if (action === 'open') {
    const r = await openVote(env, { question: body.question, options: body.options });
    return r.ok ? json({ success: true, mode: r.mode }) : json({ error: r.error }, 400);
  }
  if (action === 'lock') {
    const r = await lockVote(env);
    return r.ok ? json({ success: true, winner: r.winner, paid: r.paid }) : json({ error: r.error }, 400);
  }
  if (action === 'cancel') { await cancelVote(env); return json({ success: true }); }
  return json({ error: 'Unknown action' }, 400);
}
