/* ══════════════════════════════════════════════
   STREAMER vs CHAT — Mana Clash as a stream-night event.

   A SEPARATE SESSION FROM THE ROOMS. Normal Mana Clash is room-based
   (mc_room_), simultaneous versus/co-op play. This is none of that: one
   singleton the broadcaster/mods start from a control button, where CHAT
   collectively rolls against the STREAMER's hand, resolved SERVER-SIDE with
   the exact same Farkle scoring the rooms pay from (mana-clash-scoring.js —
   reused, never re-implemented). It touches no mc_room_ key.

   THE FLOW
     • A mod POSTs `start`. The streamer's six dice are rolled HERE (fair,
       server-side) and frozen — that is the streamer's whole move.
     • For COLLECT_MS, every `!clash` in Twitch chat rolls ONE fair die into
       chat's shared pool (see clashFromChat, called from bot/commands.js).
     • When the window closes, the round resolves: chat's best six dice are
       drawn from the pool and both hands are scored with bestSelection() —
       the same best-keep the game uses — and the higher score wins.

   CHAT'S AGGREGATE RULE — "pooled roll, best six".
     Each chatter's first `!clash` rolls one fair die; the face is tallied
     into six counters (chatCounts), never a per-message log, so the record is
     bounded however big chat is. At resolution bestChatHand() picks the
     six-die multiset drawable from those counts that SCORES highest, and that
     is chat's hand. The rule is:
       - FAIR: both sides get a six-die Farkle hand scored by the identical
         engine. Chat's only edge is numbers — more `!clash`es means more dice
         in the pool and a better chance at a strong best-six. That asymmetry
         (one streamer vs the whole chat) is the point of the mode.
       - DETERMINISTIC given the inputs: bestChatHand(counts) is a pure
         function of the counts, so the same pool always resolves the same way.
       - BOUNDED: six integer counters plus a capped dedupe map (MAX_CHATTERS).

   RATE LIMIT: one die per chatter per clash. The first `!clash` from a
   Twitch id counts; any repeat in the same session is a quiet no-op. That is
   both the anti-spam limit and the fairness rule (one vote/die per person),
   and it needs no extra KV cooldown key — the per-session `seen` map is the
   limiter, reset by the next `start`.

   TIME IS RESOLVED LAZILY, like the rooms and the chat scramble: the collect
   window closing and the reveal ending are both "this deadline has passed",
   applied on whatever request arrives next (the overlay poll, or a chat
   strike). No scheduler.

   STORAGE. One singleton key `mana_clash_vs_chat`, registered in
   server/lib/registry.js as { table: 'singletons', expiry: 'real' }: every
   write slides a TTL forward, so a clash nobody ever ends still clears itself
   off the overlay rather than lingering for the room TTL. The live status is
   also timestamp-driven (collectUntil / revealUntil) so publicClash reads as
   'none' the moment the reveal is over, before the row is even gone.
   ══════════════════════════════════════════════ */

import {
  rollDice, bestSelection, FACES, DICE_COUNT,
} from './mana-clash-scoring.js';

export const CLASH_KEY = 'mana_clash_vs_chat';

/* 30s of chat rolls, then a 15s reveal — matches the rooms' 30s round feel,
   and the whole event (45s) sits well inside the sliding TTL below, so one
   refresh at start keeps stream_now alive for the duration. */
export const CLASH_COLLECT_MS = 30000;
export const CLASH_REVEAL_MS = 15000;

/* Sliding backstop. Each write (start, a chat die, a lazy resolve) sets it;
   a clash left unended lapses within this window and the overlay clears. */
const CLASH_TTL_SECONDS = 600;

/* The dedupe map is capped so a raid of thousands cannot grow the record
   without bound — past the cap new chatters are turned away, which only ever
   happens on a chat far larger than any real roll needs. */
const MAX_CHATTERS = 2000;

/* This mode uses the unified "what's on stream" pointer under this game id.
   stream-now.js must list 'mana-clash' in its GAMES whitelist or the refresh
   is a silent no-op. */
const STREAM_NOW_GAME = 'mana-clash';

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

function freshCounts() {
  const c = {};
  for (const f of FACES) c[f] = 0;
  return c;
}

function sumCounts(counts) {
  let n = 0;
  for (const f of FACES) n += Math.max(0, Math.floor((counts && counts[f]) || 0));
  return n;
}

/* ══ The aggregate rule, as pure functions ════════════════════════════════ */

/**
 * Chat's best six dice, drawn from what chat rolled.
 *
 * `counts` is chat's pool as six face counters. Returns the up-to-six-die
 * multiset (as face letters) that scores highest under bestSelection — the
 * same best-keep the game uses — together with that score. Pure and
 * deterministic: the same counts always give the same hand.
 *
 * The search is over multisets of size min(6, pool) across six faces, which
 * is tiny and exhaustive, so it is obviously the chat's best possible hand
 * rather than a heuristic that could feel arbitrary.
 */
export function bestChatHand(counts) {
  const avail = FACES.map(f => Math.max(0, Math.floor((counts && counts[f]) || 0)));
  const total = avail.reduce((a, b) => a + b, 0);
  const target = Math.min(DICE_COUNT, total);
  if (target === 0) return { faces: [], points: 0 };

  let best = { faces: [], points: -1 };
  const chosen = [];

  const rec = (i, remaining) => {
    if (i === FACES.length) {
      if (remaining !== 0) return;
      const sel = bestSelection(chosen);
      const pts = sel ? sel.points : 0;
      /* Higher score wins; among equal scores prefer the smaller hand, so a
         tie never pads chat's shown dice with filler that does not score. */
      if (pts > best.points || (pts === best.points && chosen.length < best.faces.length)) {
        best = { faces: chosen.slice(), points: pts };
      }
      return;
    }
    const max = Math.min(avail[i], remaining);
    for (let k = 0; k <= max; k++) {
      for (let j = 0; j < k; j++) chosen.push(FACES[i]);
      rec(i + 1, remaining - k);
      for (let j = 0; j < k; j++) chosen.pop();
    }
  };
  rec(0, target);

  if (best.points < 0) best = { faces: [], points: 0 };
  return best;
}

/** Best-keep score of a hand, and the kept dice, via the shared engine. */
function scoreHand(faces) {
  const sel = bestSelection(faces || []);
  return {
    score: sel ? sel.points : 0,
    kept: sel ? sel.indices.map(i => faces[i]) : [],
  };
}

/**
 * Resolve the round: streamer's frozen roll vs chat's best six from the pool,
 * both scored with the same best-keep, and the winner. Pure — given a
 * session's streamer roll and chat counts, the outcome is fixed.
 */
export function resolveClash(session) {
  const roll = (session && session.streamer && Array.isArray(session.streamer.roll))
    ? session.streamer.roll.slice() : [];
  const s = scoreHand(roll);
  const chatBest = bestChatHand(session && session.chatCounts);
  const c = scoreHand(chatBest.faces);
  const winner = s.score === c.score ? 'draw' : (s.score > c.score ? 'streamer' : 'chat');
  return {
    streamerScore: s.score,
    streamerKept: s.kept,
    chatHand: chatBest.faces,
    chatScore: c.score,
    chatKept: c.kept,
    winner,
  };
}

/* ══ Lifecycle ════════════════════════════════════════════════════════════ */

function newSession(now, by) {
  return {
    status: 'collecting',
    startedAt: now,
    collectUntil: now + CLASH_COLLECT_MS,
    revealUntil: null,
    by: by || null,
    streamer: { roll: rollDice(DICE_COUNT) },
    chatCounts: freshCounts(),
    chatters: 0,
    seen: {},
    result: null,
  };
}

/** Whether a read has timed work to persist (a window that has closed). */
function clashDue(s, now) {
  if (!s || !s.status) return false;
  if (s.status === 'collecting') return now >= s.collectUntil;
  if (s.status === 'resolved') return !!s.revealUntil && now >= s.revealUntil;
  return false;
}

/**
 * Apply whatever the clock owes, in place: the collect window closing
 * (resolve the round), then the reveal ending (the session is over). Returns
 * true if anything changed, so a read writes only when it must.
 */
export function advanceClash(s, now) {
  let changed = false;
  if (s && s.status === 'collecting' && now >= s.collectUntil) {
    s.result = resolveClash(s);
    s.status = 'resolved';
    s.revealUntil = now + CLASH_REVEAL_MS;
    changed = true;
  }
  if (s && s.status === 'resolved' && s.revealUntil && now >= s.revealUntil) {
    s.status = 'ended';
    s.endedAt = now;
    changed = true;
  }
  return changed;
}

/**
 * The small shape the overlay reads — never the raw `seen` dedupe map. A
 * session that is over (or absent) reads as 'none' so the panel hides itself,
 * before the row's TTL has even lapsed.
 */
export function publicClash(s, now = Date.now()) {
  if (!s || !s.status || s.status === 'ended') return { status: 'none', serverNow: now };

  const rolls = sumCounts(s.chatCounts);

  if (s.status === 'collecting') {
    const sc = scoreHand((s.streamer && s.streamer.roll) || []);
    return {
      status: 'collecting',
      serverNow: now,
      by: s.by || null,
      msLeft: Math.max(0, s.collectUntil - now),
      streamer: { roll: (s.streamer && s.streamer.roll || []).slice(), score: sc.score, kept: sc.kept },
      chat: { chatters: s.chatters || 0, rolls },
      winner: null,
    };
  }

  /* resolved */
  const r = s.result || resolveClash(s);
  return {
    status: 'resolved',
    serverNow: now,
    by: s.by || null,
    msLeft: Math.max(0, (s.revealUntil || now) - now),
    streamer: {
      roll: (s.streamer && s.streamer.roll || []).slice(),
      score: r.streamerScore,
      kept: r.streamerKept,
    },
    chat: {
      hand: r.chatHand,
      score: r.chatScore,
      kept: r.chatKept,
      chatters: s.chatters || 0,
      rolls,
    },
    winner: r.winner,
  };
}

/* Best-effort pointer upkeep — never lets a stream_now hiccup take down the
   control action or chat strike that triggered it. */
async function refreshPointer(env, by) {
  try {
    const { refreshStreamNow } = await import('./stream-now.js');
    await refreshStreamNow(env, { game: STREAM_NOW_GAME, label: 'Streamer vs Chat', level: by || null });
  } catch (err) {
    console.error('[mana-clash-chat] could not refresh stream_now:', err.message);
  }
}

async function clearPointer(env) {
  try {
    const { clearStreamNow } = await import('./stream-now.js');
    await clearStreamNow(env, STREAM_NOW_GAME);
  } catch (err) {
    console.error('[mana-clash-chat] could not clear stream_now:', err.message);
  }
}

/* ══ Chat participation — called from bot/commands.js on `!clash` ══════════
   One fair die into chat's pool, one die per chatter per clash. No active
   clash → a quiet no-op. Silent by design: the overlay is the feedback, and a
   reply per chatter would bury the channel exactly like !hit would. */
export async function clashFromChat(env, { userId, name } = {}) {
  if (!env || !env.MARKETPLACE || !userId) return { ok: false, status: 'none' };
  const uid = String(userId);

  let landed = false;
  let becameEnded = false;
  let after = null;

  await env.MARKETPLACE.mutate(CLASH_KEY, (s) => {
    const now = Date.now();
    const advanced = s ? advanceClash(s, now) : false;
    if (advanced && s.status === 'ended') becameEnded = true;
    after = s;

    if (!s || s.status !== 'collecting') {
      /* Nothing to add, but a window that just closed under this message must
         still be persisted. */
      return advanced ? s : undefined;
    }

    s.seen = (s.seen && typeof s.seen === 'object') ? s.seen : {};
    /* Already rolled this clash, or the dedupe map is full: the rate limit
       and the bound. Either way, write only if the clock moved. */
    if (s.seen[uid]) return advanced ? s : undefined;
    if (Object.keys(s.seen).length >= MAX_CHATTERS) return advanced ? s : undefined;

    const face = rollDice(1)[0];
    s.chatCounts = (s.chatCounts && typeof s.chatCounts === 'object') ? s.chatCounts : freshCounts();
    s.chatCounts[face] = (s.chatCounts[face] || 0) + 1;
    s.seen[uid] = 1;
    s.chatters = (s.chatters || 0) + 1;
    landed = true;
    return s;
  }, { expirationTtl: CLASH_TTL_SECONDS });

  /* A landed die is activity — slide the pointer forward. A window that ended
     under this message clears it. */
  if (becameEnded) await clearPointer(env);
  else if (landed) await refreshPointer(env, after && after.by);

  const status = publicClash(after).status;
  return { ok: landed, status, chatters: after ? (after.chatters || 0) : 0 };
}

/* ══ GET — the overlay (OBS browser source) ═══════════════════════════════
   Key in the URL, exactly like the room panel and the event feed: a browser
   source is a URL and nothing else. Resolves the clock on read so an idle
   overlay still sees the window close and the reveal end on schedule; it only
   takes the lock when timed work is actually due, so it can never overwrite a
   chat strike that landed in between. */
export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);

  const { getOverlayKey } = await import('./overlay/events.js');
  const key = await getOverlayKey(env);
  if (url.searchParams.get('key') !== key) {
    return json({ error: 'Bad or missing key' }, 403);
  }

  let s = await env.MARKETPLACE.get(CLASH_KEY, 'json');
  const now = Date.now();
  if (clashDue(s, now)) {
    let becameEnded = false;
    await env.MARKETPLACE.mutate(CLASH_KEY, (cur) => {
      const changed = cur ? advanceClash(cur, now) : false;
      s = cur;
      if (changed && cur.status === 'ended') becameEnded = true;
      return changed ? cur : undefined;
    }, { expirationTtl: CLASH_TTL_SECONDS });
    if (becameEnded) await clearPointer(env);
  }

  return json(publicClash(s, now));
}

/* ══ POST — the control button (broadcaster / moderators) ═════════════════ */
export async function onRequestPost(context) {
  const { env, request } = context;

  const { isModerator } = await import('./admin/moderators.js');
  const session = getSession(request);
  if (!(await isModerator(env, session))) {
    return json({ error: 'Only the broadcaster and moderators can start a clash.' }, 403);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  if (body.action === 'start') {
    const now = Date.now();
    const s = newSession(now, session.display_name || null);
    /* Written under the lock, overwriting any previous clash — a mod starting
       a fresh one resets the pool rather than adding to an old hand. */
    await env.MARKETPLACE.mutate(CLASH_KEY, () => s, { expirationTtl: CLASH_TTL_SECONDS });
    await refreshPointer(env, s.by);
    return json({ success: true, clash: publicClash(s, now) });
  }

  if (body.action === 'end') {
    /* A tombstone rather than a delete, so a chat strike already holding the
       lock cannot resurrect the clash by writing it back. */
    await env.MARKETPLACE.mutate(CLASH_KEY, () => ({ status: 'ended', endedAt: Date.now() }),
      { expirationTtl: 60 });
    await clearPointer(env);
    return json({ success: true });
  }

  return json({ error: 'Invalid action' }, 400);
}
