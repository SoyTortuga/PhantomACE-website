#!/usr/bin/env node
/* ══════════════════════════════════════════════
   CHAT SCRAMBLE — test suite

     node server/scripts/test-chat-game.js

   Three things here would be hard to notice live and embarrassing on
   stream, so they are asserted rather than hoped for:

     - The answer must not be in what the overlay receives while a round is
       open. A game whose answer sits in the page's own network tab is not a
       game, and nobody would ever see that by watching it work.

     - Exactly one winner, when many people type the right answer inside the
       same second. That is what a right answer LOOKS like in chat, not an
       edge case.

     - A wrong guess must cost nothing and say nothing. The bot is capped at
       roughly twenty messages per thirty seconds as a non-moderator, so a
       reply per guess would silence it mid-round.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalise, isCorrect, scramble, publicState, advance,
  offerGuess, controlGame, tickGame, WORDS,
} from '../../functions/api/chat-game.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/* offerGuess returns a LIST of things to announce — a round timing out and
   the next one opening arrive together — or null when there is nothing to
   say, which is the overwhelmingly common case. */
const kinds = (r) => (r || []).map(a => a.kind);
const firstOf = (r, kind) => (r || []).find(a => a.kind === kind) || null;

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

function makeEnv() {
  const store = new Map();
  const chains = new Map();
  return {
    MARKETPLACE: {
      async get(k, t) { if (!store.has(k)) return null; const r = store.get(k); return t === 'json' ? JSON.parse(r) : r; },
      async put(k, v) { store.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
      async delete(k) { store.delete(k); },
      /* SERIALISED PER KEY, because that is what the real one guarantees:
         server/lib/kv.js takes pg_advisory_xact_lock for the duration of the
         read-modify-write. A fake that simply awaits the mutator lets every
         concurrent caller read the same pre-write state, which models an
         UNLOCKED store — and then reports a correct implementation as
         broken. The first version of this file did exactly that and claimed
         twelve winners for one round. */
      async mutate(k, fn) {
        const prev = chains.get(k) || Promise.resolve();
        const run = prev.then(async () => {
          const cur = store.has(k) ? JSON.parse(store.get(k)) : null;
          const next = await fn(cur);
          if (next === undefined) return cur;
          store.set(k, JSON.stringify(next));
          return JSON.parse(store.get(k));
        });
        chains.set(k, run.then(() => {}, () => {}));
        return run;
      },
      async listValues() { return []; },
    },
    _store: store,
  };
}

const read = (env) => JSON.parse(env._store.get('chat_scramble'));
const write = (env, g) => env._store.set('chat_scramble', JSON.stringify(g));

/* ── Answer matching is forgiving ────────────────────────────────────── */
check('exact', isCorrect('mana clash', 'mana clash'), true);
check('case', isCorrect('MANA CLASH', 'mana clash'), true);
check('no spaces', isCorrect('manaclash', 'mana clash'), true);
check('punctuation', isCorrect('mana-clash!', 'mana clash'), true);
check('surrounding space', isCorrect('  mana clash  ', 'mana clash'), true);
check('wrong word', isCorrect('mana burn', 'mana clash'), false);
check('empty guess', isCorrect('', 'mana clash'), false);
check('a lone space is not an answer', isCorrect('   ', 'mana clash'), false);
check('normalise strips everything but letters and digits', normalise('A-b C!1'), 'abc1');

/* ── The word list ───────────────────────────────────────────────────────
   Enforced rather than remembered. Adding a word is the one edit anyone
   will make to this game without reading the rest of it, and a
   seventeen-letter phrase does not fail — it just renders too small to read
   on stream, which is the sort of thing nobody notices until it is live. */
{
  const letters = (w) => w.replace(/ /g, '').length;

  check('nothing exceeds the tile budget',
    WORDS.filter(w => letters(w.word) > 15).map(w => w.word), []);
  check('nothing is too short to scramble',
    WORDS.filter(w => letters(w.word) < 4).map(w => w.word), []);
  check('every word is lower case',
    WORDS.filter(w => w.word !== w.word.toLowerCase()).map(w => w.word), []);
  check('every word has a category',
    WORDS.filter(w => !w.category || !w.category.trim()).map(w => w.word), []);
  /* One word, because it sits beside the scramble on the overlay and
     inside a single chat line. A sentence fits neither. */
  check('every category is a single word',
    WORDS.filter(w => !/^[A-Za-z]+$/.test(w.category || '')).map(w => w.word), []);
  check('no duplicates',
    WORDS.map(w => w.word).filter((w, i, a) => a.indexOf(w) !== i), []);
  check('only letters and single spaces',
    WORDS.filter(w => !/^[a-z]+( [a-z]+)*$/.test(w.word)).map(w => w.word), []);

  /* A category that appears inside its own answer is not a clue. */
  check('no category gives the answer away',
    WORDS.filter(w => normalise(w.word).includes(normalise(w.category))).map(w => w.word), []);

  ok('there are enough words for a long break', WORDS.length >= 60);

  /* A FLOOR, NOT A COUNT. Asserting the exact total would fail every time
     somebody adds a word, which trains people to edit the test instead of
     reading it. The floor is what actually matters: the round picker avoids
     recent answers, so a short list repeats inside one break. */
  ok('the list is deep enough not to repeat in a session', WORDS.length >= 1500);

  /* THE CLUE HAS TO NARROW SOMETHING.
     A category holding two answers is not a hint — it is the answer, and a
     regular learns that after seeing it twice. Doom held two and Platformer
     four before the list was extended.

     Five is the floor rather than ten because two categories are complete
     sets at exactly five: there are five shards and five wedges in Magic,
     and no honest way to add a sixth. Anything else that lands this low is
     a category that wants filling out, so the message names it. */
  {
    const counts = new Map();
    for (const w of WORDS) counts.set(w.category, (counts.get(w.category) || 0) + 1);
    const thin = [...counts].filter(([, n]) => n < 5).map(([c, n]) => `${c}:${n}`).sort();
    check('no category is so small the clue is the answer', thin, []);

    const complete = new Set(['Shard', 'Wedge']);
    const smallButNotComplete = [...counts]
      .filter(([c, n]) => n < 10 && !complete.has(c))
      .map(([c, n]) => `${c}:${n}`).sort();
    check('and only the complete sets sit under ten', smallButNotComplete, ['Rarity:8']);
  }
}

/* ── The list lives in its own module ────────────────────────────────── */
{
  /* Sixteen hundred entries is data. It was split out when it started
     drowning the two hundred lines of rules it shared a file with — but
     every importer and this suite read WORDS from chat-game.js, so the
     re-export is what keeps that true. */
  const src = fs.readFileSync(path.join(REPO, 'functions/api/chat-game.js'), 'utf8');
  ok('chat-game.js still exports WORDS', /export \{ WORDS \}/.test(src));
  ok('and holds no inline list of its own', !/export const WORDS = \[/.test(src));

  const router = fs.readFileSync(path.join(REPO, 'server/router.js'), 'utf8');
  /* A library under functions/ that is not declared fails the boot. */
  ok('the words module is declared a non-route', /'api\/chat-game-words\.js'/.test(router));
}

/* ── The scramble ────────────────────────────────────────────────────── */
{
  /* Same letters, same word breaks, and NOT the original — a scramble that
     shows the answer is the one outcome that wastes the round. */
  let sameAsOriginal = 0;
  let wrongLetters = 0;
  let wrongShape = 0;

  for (const { word } of WORDS) {
    for (let i = 0; i < 40; i++) {
      const out = scramble(word);
      if (out === word) sameAsOriginal++;
      if ([...out.replace(/ /g, '')].sort().join('') !== [...word.replace(/ /g, '')].sort().join('')) wrongLetters++;
      if (out.split(' ').map(p => p.length).join(',') !== word.split(' ').map(p => p.length).join(',')) wrongShape++;
    }
  }
  check('a scramble never comes back as the answer', sameAsOriginal, 0);
  check('it uses exactly the same letters', wrongLetters, 0);
  check('and keeps the word breaks', wrongShape, 0);

  /* A word that cannot be rearranged must come back unchanged rather than
     spin. 'aa' has one arrangement. */
  check('an unshufflable word is returned as-is', scramble('aa'), 'aa');
  check('a single letter is left alone', scramble('a'), 'a');
}

/* ── The answer never leaks while the round is open ──────────────────── */
{
  const env = makeEnv();
  await controlGame(env, 'start', {});
  const game = read(env);

  const shown = publicState(game);
  check('the overlay is told a round is running', shown.status, 'running');
  ok('and gets the scramble', !!shown.display);
  ok('and the category', !!shown.category);
  check('but NOT the answer', shown.word, undefined);
  check('nor the winner field', shown.winner, undefined);

  /* Serialised, as it would be over the wire — a nested copy would leak
     just as effectively as a top-level one. */
  const wire = JSON.stringify(shown).toLowerCase();
  ok('the answer appears nowhere in the payload', !wire.includes(normalise(game.word)));

  /* Once the round is over it is fine, and necessary. */
  game.status = 'reveal';
  game.revealUntil = Date.now() + 5000;
  check('the answer is revealed after the round', publicState(game).word, game.word);
}

/* ── Exactly one winner ──────────────────────────────────────────────── */
{
  const env = makeEnv();
  await controlGame(env, 'start', {});
  const word = read(env).word;

  /* Twelve people type the answer at once, which is what a right answer
     looks like in a busy chat. */
  const results = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      offerGuess(env, { userId: String(100 + i), name: 'p' + i, text: word }))
  );

  const wins = results.filter(r => firstOf(r, 'win'));
  check('exactly one of them wins', wins.length, 1);
  check('and the rest are told nothing', results.filter(r => r === null).length, 11);

  const game = read(env);
  check('the game records one winner', !!game.winner, true);
  check('and awards one point', Object.values(game.scores).reduce((a, s) => a + s.points, 0), 1);
  check('the round closes on the win', game.status, 'reveal');
}

/* ── A wrong guess is free and silent ────────────────────────────────── */
{
  const env = makeEnv();
  await controlGame(env, 'start', {});

  const r = await offerGuess(env, { userId: '1', name: 'a', text: 'not the answer' });
  check('a wrong guess announces nothing', r, null);
  check('and is still counted as a participant', read(env).answered.length, 1);

  const before = env._store.get('chat_scramble');
  await offerGuess(env, { userId: '1', name: 'a', text: 'still wrong' });
  check('a repeat chatter does not rewrite the row', env._store.get('chat_scramble'), before);

  await offerGuess(env, { userId: '2', name: 'b', text: 'wrong too' });
  check('but a new chatter does', read(env).answered.length, 2);
}

/* ── Guessing outside a round does nothing ───────────────────────────── */
{
  const env = makeEnv();
  const r = await offerGuess(env, { userId: '1', name: 'a', text: 'mana clash' });
  check('no game running means no announcement', r, null);

  await controlGame(env, 'start', {});
  const word = read(env).word;
  await offerGuess(env, { userId: '1', name: 'a', text: word });

  /* The round is now revealing. A late correct answer must not win again. */
  const late = await offerGuess(env, { userId: '2', name: 'b', text: word });
  check('an answer during the reveal wins nothing', late, null);
  check('and the first winner stands', read(env).winner.userId, '1');
}

/* ── The clock ───────────────────────────────────────────────────────── */
{
  const env = makeEnv();
  await controlGame(env, 'start', {});

  const game = read(env);
  game.endsAt = Date.now() - 1;
  write(env, game);

  const r = await offerGuess(env, { userId: '9', name: 'late', text: 'anything' });
  check('a round that ran out announces the answer', kinds(r), ['timeout']);
  check('and says what it was', firstOf(r, 'timeout').word, game.word);
  check('the game moves to reveal', read(env).status, 'reveal');

  /* The reveal elapsing starts the next round, on whatever request lands. */
  const g2 = read(env);
  g2.revealUntil = Date.now() - 1;
  write(env, g2);
  const opened = await offerGuess(env, { userId: '9', name: 'late', text: 'anything' });
  /* THE GAP THIS CLOSES. An auto-advanced round used to announce nothing, so
     only round one ever reached chat. With an overlay that was a missing
     nudge; without one — and the overlay is optional, since the bot posts
     every scramble — the game simply stopped after the first round. */
  check('the new round is announced to chat', kinds(opened), ['start']);
  ok('with the scramble in it', !!firstOf(opened, 'start').display);
  ok('and the category', !!firstOf(opened, 'start').category);
  const g3 = read(env);
  check('the next round starts by itself', g3.status, 'running');
  check('and it is a new round', g3.round, 2);
  ok('with a different word', g3.word !== game.word);
}

{
  /* autoContinue false stops after one round rather than running until
     someone remembers to stop it. */
  const env = makeEnv();
  await controlGame(env, 'start', { autoContinue: false });
  const g = read(env);
  g.endsAt = Date.now() - 1;
  advance(g, Date.now());
  g.revealUntil = Date.now() - 1;
  advance(g, Date.now());
  check('a single-round game goes idle', g.status, 'idle');
}

/* ── Control ─────────────────────────────────────────────────────────── */
{
  const env = makeEnv();
  const stopped = await controlGame(env, 'stop', {});
  ok('stopping nothing is refused politely', !!stopped.error);

  await controlGame(env, 'start', {});
  const first = read(env).word;

  const skipped = await controlGame(env, 'skip', {});
  check('skip announces the word it abandoned', skipped.announce.word, first);
  ok('and moves on', read(env).word !== first);

  await offerGuess(env, { userId: '5', name: 'winner', text: read(env).word });
  const stop = await controlGame(env, 'stop', {});
  check('stopping reports the scoreboard', Object.keys(stop.announce.scores).length, 1);
  check('and the game goes idle', read(env).status, 'idle');
  check('an idle game shows the overlay nothing', publicState(read(env)).status, 'idle');
}

{
  /* A fresh start clears the scoreboard: two separate breaks hours apart
     sharing a leaderboard reads as a bug, not as continuity. */
  const env = makeEnv();
  await controlGame(env, 'start', {});
  await offerGuess(env, { userId: '5', name: 'winner', text: read(env).word });
  check('a point was scored', Object.keys(read(env).scores).length, 1);

  await controlGame(env, 'start', {});
  check('a new game starts from zero', Object.keys(read(env).scores).length, 0);

  await offerGuess(env, { userId: '5', name: 'winner', text: read(env).word });
  await controlGame(env, 'start', { keepScores: true });
  check('unless scores are kept deliberately', Object.keys(read(env).scores).length, 1);
}

/* ── Words don't repeat within a break ───────────────────────────────── */
{
  const env = makeEnv();
  await controlGame(env, 'start', {});
  const seen = [read(env).word];
  for (let i = 0; i < 9; i++) {
    await controlGame(env, 'skip', {});
    seen.push(read(env).word);
  }
  check('ten rounds give ten different words', new Set(seen).size, 10);
}

/* ── The clock runs without anyone typing ────────────────────────────────
   Most of a round has nobody speaking. If only a guess could move the
   clock, a round with no chatter would hang until someone said something. */
{
  const env = makeEnv();
  await controlGame(env, 'start', {});
  const first = read(env).word;

  let g = read(env);
  g.endsAt = Date.now() - 1;
  write(env, g);

  const t1 = await tickGame(env);
  check('a poll closes a round that ran out', kinds(t1.announce), ['timeout']);
  check('and says what it was', firstOf(t1.announce, 'timeout').word, first);

  g = read(env);
  g.revealUntil = Date.now() - 1;
  write(env, g);

  const t2 = await tickGame(env);
  check('and a poll opens the next one', kinds(t2.announce), ['start']);
  check('the game is running again', read(env).status, 'running');

  /* Polled again immediately, nothing has changed and nothing is said —
     the overlay polls once a second and must not re-announce each time. */
  const t3 = await tickGame(env);
  check('a poll with nothing to do says nothing', t3.announce, []);
}

{
  /* A LATE poll must not skip the reveal. If the overlay was closed, or the
     server was busy, a round can run out long before anything notices —
     and closing it always grants the full reveal window rather than racing
     straight into the next scramble. Everyone still gets to see the answer
     they spent forty-five seconds on. */
  const env = makeEnv();
  await controlGame(env, 'start', {});
  const first = read(env).word;

  const g = read(env);
  g.endsAt = Date.now() - 20000;        // ran out twenty seconds ago
  g.revealUntil = Date.now() - 1;       // a stale value from before
  write(env, g);

  const t = await tickGame(env);
  check('a very late poll still announces the answer', kinds(t.announce), ['timeout']);
  check('and only the answer', firstOf(t.announce, 'timeout').word, first);
  check('the reveal is still showing', read(env).status, 'reveal');
  ok('with its full window ahead of it', read(env).revealUntil > Date.now() + 5000);
}

/* ── Round length ────────────────────────────────────────────────────────
   Three minutes, or until somebody gets it. The clock is a backstop, not a
   pace — a correct answer must still end the round on the spot, or a long
   timer turns every solved round into a wait. */
{
  const env = makeEnv();
  await controlGame(env, 'start', {});
  const g = read(env);
  const minutes = (g.endsAt - g.startedAt) / 60000;
  ok('a round runs three minutes', Math.abs(minutes - 3) < 0.01);

  /* Solved after a few seconds: the round ends immediately, not in three
     minutes' time. */
  const before = Date.now();
  await offerGuess(env, { userId: '7', name: 'quick', text: read(env).word });
  const after = read(env);
  check('a correct answer closes it at once', after.status, 'reveal');
  ok('without waiting out the clock', after.revealUntil - before < 60000);
}

/* ── The game survives silence ───────────────────────────────────────────
   THE BUG THIS GUARDS. Rounds used to advance only on a chat message or an
   overlay poll, so a lull with no overlay open froze the game — and the
   freeze was self-reinforcing, because a frozen game announces nothing and
   a chat with nothing to answer stays quiet. It ran a few rounds and
   stopped. The server now ticks it; these assert that tickGame alone,
   with no guesses at all, carries a game through round after round. */
{
  const env = makeEnv();
  await controlGame(env, 'start', {});

  const words = [read(env).word];
  const announced = [];

  /* Ten rounds, nobody ever guessing. Each round is wound past its
     deadline rather than waited out. */
  for (let i = 0; i < 10; i++) {
    let g = read(env);
    g.endsAt = Date.now() - 1;
    write(env, g);
    announced.push(...kinds((await tickGame(env)).announce));

    g = read(env);
    g.revealUntil = Date.now() - 1;
    write(env, g);
    announced.push(...kinds((await tickGame(env)).announce));

    words.push(read(env).word);
  }

  check('ten silent rounds still run', read(env).status, 'running');
  check('and reach round eleven', read(env).round, 11);
  check('every round announced its answer', announced.filter(k => k === 'timeout').length, 10);
  check('and every new round announced itself', announced.filter(k => k === 'start').length, 10);
  check('with no round left behind', new Set(words).size, 11);
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[chat-game] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[chat-game] ${passed} assertions passed.`);
console.log('');
