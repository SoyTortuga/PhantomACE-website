/* ══════════════════════════════════════════════
   CHAT SCRAMBLE — a game chat plays on the BRB screen.

   Chat is the controller, the overlay is the screen. The bot posts at most
   twice a round: one line when a round opens and one when it closes.

   THE BOT DOES NOT REPLY TO PLAYERS. The bot account is a moderator, which
   Twitch rates at 100 messages per 30 seconds, so the rate limit is no
   longer the reason — but a line per guess would still bury the channel in
   bot output during exactly the minutes people are talking, and a throttled
   message comes back as HTTP 200 with is_sent false, so the failure would
   be invisible if it ever did bite. Everything live — the scramble, the
   clock, how many have guessed, the scoreboard — is state the overlay
   polls, which costs no messages at all.

   THE ANSWER NEVER LEAVES THE SERVER while a round is open. publicState()
   builds what the overlay receives, and the word is not in it. The overlay
   URL is key-protected, but a game whose answer is readable in the page's
   own network tab is not a game.
   ══════════════════════════════════════════════ */

const KEY = 'chat_scramble';
/* Three minutes, or until somebody gets it — a correct answer ends the
   round on the spot, which is most of what makes the clock a backstop
   rather than a pace. Long enough that a hard scramble is a puzzle
   people chew on during a break rather than a reflex test. */
const ROUND_MS = 180000;
/* Longer than it was, to match. At forty-five seconds a round the answer
   flashed past; at three minutes there is no hurry, and people who spent
   the whole round on it deserve to see what it was. */
const REVEAL_MS = 12000;
const WIN_ENTRIES = 2;
const MAX_SCORES = 200;

/* ── The word list ───────────────────────────────────────────────────────
   Lives in chat-game-words.js — sixteen hundred entries is data, and it
   was drowning the two hundred lines of rules in this file. Re-exported
   here because every importer, and the test suite, reads WORDS from this
   module. */
import { WORDS } from './chat-game-words.js';
export { WORDS };

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

/* ══ The rules, as pure functions ═══════════════════════════════════════ */

/**
 * Compare a chat message to the answer.
 *
 * Deliberately forgiving: case, spacing and punctuation are all discarded,
 * so "Mana Clash", "manaclash" and "mana-clash!" all count. Being strict
 * here produces the worst possible experience — a viewer who plainly knew
 * the answer being told nothing happened.
 */
export function normalise(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

export function isCorrect(guess, word) {
  const g = normalise(guess);
  return g.length > 0 && g === normalise(word);
}

/**
 * Scramble each word of the phrase, keeping the word breaks.
 *
 * Breaks are kept because they carry the shape of the answer — "mana clash"
 * scrambled into one run of nine letters is a different, much harder game
 * than two runs of four and five, and the hint is calibrated for the easier
 * one.
 *
 * A letter arrangement identical to the original is re-rolled: a "scramble"
 * that shows the answer is the one outcome that makes the round pointless.
 * Short words can be unshufflable (a single letter, or a repeated pair), so
 * the attempt count is bounded and the caller must tolerate a word coming
 * back as itself rather than looping forever.
 */
export function scramble(phrase, rng = Math.random) {
  return String(phrase).split(' ').map((part) => {
    if (part.length < 2) return part;
    for (let attempt = 0; attempt < 12; attempt++) {
      const letters = part.split('');
      for (let i = letters.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [letters[i], letters[j]] = [letters[j], letters[i]];
      }
      const out = letters.join('');
      if (out !== part) return out;
    }
    return part;
  }).join(' ');
}

/** Everything the overlay is allowed to know. The answer is not in it. */
export function publicState(game, now = Date.now()) {
  if (!game || game.status === 'idle') {
    return { status: 'idle', round: 0, scores: [] };
  }

  const scores = Object.entries(game.scores || {})
    .map(([id, s]) => ({ id, name: s.name, points: s.points }))
    .sort((a, b) => b.points - a.points || a.name.localeCompare(b.name))
    .slice(0, 5);

  const base = {
    status: game.status,
    round: game.round,
    category: game.category,
    display: game.display,
    answered: (game.answered || []).length,
    scores,
    serverNow: now,
  };

  if (game.status === 'running') {
    return { ...base, msLeft: Math.max(0, game.endsAt - now) };
  }

  /* Only once the round is over does the answer go out. */
  return {
    ...base,
    word: game.word,
    winner: game.winner,
    msLeft: Math.max(0, game.revealUntil - now),
  };
}

/* ══ Lifecycle ══════════════════════════════════════════════════════════ */

function pickWord(recent) {
  const avoid = new Set(recent || []);
  const pool = WORDS.filter(w => !avoid.has(w.word));
  const from = pool.length ? pool : WORDS;
  return from[Math.floor(Math.random() * from.length)];
}

function startRound(game, now) {
  const picked = pickWord(game.recent);
  game.status = 'running';
  game.round = (game.round || 0) + 1;
  game.word = picked.word;
  game.category = picked.category;
  game.display = scramble(picked.word).toUpperCase();
  game.startedAt = now;
  game.endsAt = now + ROUND_MS;
  game.revealUntil = null;
  game.answered = [];
  game.winner = null;
  /* Enough history that a word does not come round twice in a break. */
  game.recent = [picked.word, ...(game.recent || [])].slice(0, 10);
  return game;
}

function endRound(game, now) {
  game.status = 'reveal';
  game.revealUntil = now + REVEAL_MS;
  return game;
}

/**
 * Apply whatever the clock owes — a round that has run out, a reveal that
 * has finished. Lazy, on whatever request arrives next, exactly as the
 * rooms in Mana Clash do: a scheduler would tie game state to the lifetime
 * of the process.
 *
 * Returns { changed, closed, opened }. `closed` is a round that ran out of
 * time; `opened` is a round that started on its own.
 *
 * `opened` exists because the overlay is OPTIONAL. The bot posts each
 * scramble to chat, so the game is playable with no overlay at all — but a
 * round that auto-advanced used to announce nothing, so only round one ever
 * reached chat and every round after it opened in silence. With an overlay
 * that merely meant no nudge; without one the game simply stopped after the
 * first round.
 *
 * The transition happens inside the caller's lock, so exactly one caller
 * ever sees `opened` for a given round and it cannot be announced twice.
 */
export function advance(game, now = Date.now()) {
  let changed = false;
  let closed = null;
  let opened = null;

  if (game.status === 'running' && now >= game.endsAt) {
    endRound(game, now);
    closed = { word: game.word, round: game.round };
    changed = true;
  }

  if (game.status === 'reveal' && now >= game.revealUntil) {
    if (game.autoContinue) {
      startRound(game, now);
      opened = { category: game.category, display: game.display, round: game.round };
    } else {
      game.status = 'idle';
    }
    changed = true;
  }

  return { changed, closed, opened };
}

function freshGame() {
  return {
    status: 'idle', round: 0, word: null, category: null, display: null,
    startedAt: null, endsAt: null, revealUntil: null,
    answered: [], winner: null, scores: {}, recent: [], autoContinue: true,
  };
}

/* ── The chat scramble ───────────────────────────────────────────────────
   Announcements only, never a reply to a guess. Not a rate-limit rule any
   more — the bot is a moderator, rated at 100 messages per 30 seconds — but
   a line per guess would bury the channel in bot output during the minutes
   people are actually talking. Live state goes on the overlay instead,
   which costs no messages. */
export async function announceGame(env, announce) {
  if (!announce) return;
  const { sendChatMessage } = await import('./bot/send-chat.js');

  if (announce.kind === 'start') {
    /* The category goes in the chat line too, not only on the overlay —
       the overlay is optional, and without the clue a chat-only round is
       a wall of letters with no way in. */
    await sendChatMessage(env, `[${announce.category}] Unscramble: ${announce.display} — type your answer in chat!`);
  } else if (announce.kind === 'win') {
    await sendChatMessage(env, `@${announce.name} got it — ${announce.word.toUpperCase()}! +2 giveaway entries.`);
  } else if (announce.kind === 'timeout') {
    await sendChatMessage(env, `Time! It was ${announce.word.toUpperCase()}. Next one coming up.`);
  } else if (announce.kind === 'skip') {
    await sendChatMessage(env, `Skipped — it was ${announce.word.toUpperCase()}.`);
  } else if (announce.kind === 'stop') {
    const top = Object.values(announce.scores || {})
      .sort((a, b) => b.points - a.points).slice(0, 3)
      .map((s, i) => `${i + 1}. ${s.name} (${s.points})`).join('  ');
    await sendChatMessage(env, top ? `Scramble over! ${top}` : 'Scramble over!');
  }
}

/* ══ Called from the chat webhook ═══════════════════════════════════════ */

/**
 * Offer a chat message to the running round.
 *
 * Returns what the caller should announce, or null for the overwhelmingly
 * common case of a message that is not the answer. The bot says nothing for
 * a wrong guess — that is the rate limit rule, and also the right feel: a
 * wrong guess should cost nothing and go unremarked.
 */
export async function offerGuess(env, { userId, name, text }) {
  if (!userId) return null;

  const announce = [];
  let credited = null;

  await env.MARKETPLACE.mutate(KEY, (current) => {
    const game = current && current.status ? current : freshGame();
    const now = Date.now();
    const { changed, closed, opened } = advance(game, now);
    if (closed) announce.push({ kind: 'timeout', word: closed.word });
    if (opened) announce.push({ kind: 'start', category: opened.category, display: opened.display });

    if (game.status !== 'running') return changed ? game : undefined;

    const id = String(userId);
    const known = game.answered.includes(id);
    if (!known) game.answered.push(id);

    if (!isCorrect(text, game.word)) {
      /* A wrong guess writes only if it told us something — a chatter we had
         not counted yet, or a clock that moved. Otherwise every message in a
         busy chat would take the row's lock to store what it already said,
         and chat during a break is exactly when volume is highest. */
      return (!known || changed) ? game : undefined;
    }

    /* The claim happens INSIDE the lock. Many people type the answer within
       the same second — that is what a right answer looks like — and
       checking "is there a winner yet" outside the lock would credit
       several of them. */
    if (game.winner) return game;

    game.winner = { userId: id, name, at: now };
    const prev = game.scores[id] || { name, points: 0 };
    game.scores[id] = { name, points: prev.points + 1 };

    /* Keep the scoreboard from growing without bound over a long break. */
    const entries = Object.entries(game.scores);
    if (entries.length > MAX_SCORES) {
      entries.sort((a, b) => b[1].points - a[1].points);
      game.scores = Object.fromEntries(entries.slice(0, MAX_SCORES));
    }

    endRound(game, now);
    announce.push({ kind: 'win', word: game.word, name, points: game.scores[id].points });
    credited = { id, name };
    return game;
  });

  /* Entries are credited outside the lock — it is another key, and holding
     one row's lock while writing another invites a deadlock the moment a
     second feature does the same thing in the other order. */
  if (credited) {
    try {
      const { addEntries } = await import('./giveaway-entries.js');
      await addEntries(env, credited.id, credited.name, WIN_ENTRIES, 'chat-scramble');
    } catch (err) {
      /* The win still stands. Losing the entries is worth a log, not a
         reversal of something already announced in chat. */
      console.error('[chat-scramble] entry credit failed:', err.message);
    }
  }

  return announce.length ? announce : null;
}

/**
 * Move the clock without a guess, and report anything chat should be told.
 *
 * Called from the state poll, so the game keeps running while nobody is
 * typing — which is most of a round. Without it the clock would only ever
 * advance when somebody spoke, and a round with no chatter would hang until
 * one did.
 */
export async function tickGame(env) {
  const announce = [];
  let game = null;

  await env.MARKETPLACE.mutate(KEY, (current) => {
    game = current && current.status ? current : freshGame();
    const { changed, closed, opened } = advance(game, Date.now());
    if (closed) announce.push({ kind: 'timeout', word: closed.word });
    if (opened) announce.push({ kind: 'start', category: opened.category, display: opened.display });
    return changed ? game : undefined;
  });

  return { game, announce };
}

/* ══ Routes ═════════════════════════════════════════════════════════════ */

export async function onRequestGet(context) {
  const { env } = context;

  /* The poll is what moves the clock. The overlay polls once a second while
     a game runs, so rounds close on time without anything scheduled. */
  const { game, announce } = await tickGame(env);

  /* The poll is also what tells chat a new round has opened, because the
     overlay is optional and the bot's message is the only prompt a
     chat-only game gets. Exactly one caller sees each transition — it
     happens under the row's lock — so this cannot double-post. */
  if (announce.length) {
    try {
      for (const a of announce) await announceGame(env, a);
    } catch (err) {
      console.error('[chat-scramble] announce failed:', err.message);
    }
  }

  return json(publicState(game));
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);

  const { isModerator } = await import('./admin/moderators.js');
  if (!(await isModerator(env, session))) {
    return json({ error: 'Only the broadcaster and moderators can run the chat game.' }, 403);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  const result = await controlGame(env, body.action, body);
  if (result.error) return json({ error: result.error }, 400);
  return json(result);
}

/** Shared by the route and the !scramble chat command. */
export async function controlGame(env, action, opts = {}) {
  let announce = null;
  let state = null;

  await env.MARKETPLACE.mutate(KEY, (current) => {
    const game = current && current.status ? current : freshGame();
    const now = Date.now();

    if (action === 'start') {
      /* Starting fresh resets the scoreboard: a break is a session, and
         carrying scores across two separate BRBs hours apart reads as a bug
         rather than continuity. */
      const restart = opts.keepScores ? game.scores : {};
      Object.assign(game, freshGame(), { scores: restart, recent: game.recent || [] });
      game.autoContinue = opts.autoContinue !== false;
      startRound(game, now);
      announce = { kind: 'start', category: game.category, display: game.display };
    } else if (action === 'skip') {
      if (game.status === 'idle') return undefined;
      announce = { kind: 'skip', word: game.word };
      startRound(game, now);
    } else if (action === 'stop') {
      if (game.status === 'idle') return undefined;
      announce = { kind: 'stop', scores: game.scores };
      Object.assign(game, freshGame(), { recent: game.recent, scores: game.scores });
    } else {
      return undefined;
    }

    state = game;
    return game;
  });

  if (!state) return { error: 'Nothing to do — no game is running.' };
  return { success: true, announce, state: publicState(state) };
}
