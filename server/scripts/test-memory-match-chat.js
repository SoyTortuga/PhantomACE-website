#!/usr/bin/env node
/* ══════════════════════════════════════════════
   MEMORY MATCH — TWITCH PLAYS

     node server/scripts/test-memory-match-chat.js

   RUNS OFFLINE.

   WHAT THIS IS GUARDING:

     - THE OVERLAY MUST NOT LEAK THE BOARD. It is a public URL; sending faces
       for face-down cards would let anyone read the answers off it and tell
       chat exactly what to vote. Every face-down card carries null.
     - The clock is LAZY — nothing schedules a flip, every read works out what
       should have happened. So the advance has to be correct from any
       starting point, including several windows late.
     - A non-match stays face up for a beat, then turns back. That pause is
       the whole mechanic; without it there is no memory game.
     - A vote for a matched or already-face-up card is refused — it would be a
       vote that visibly did nothing.
     - A window nobody votes in runs back rather than stalling. A board that
       stops moving reads as broken.
     - It NEVER writes the real Memory Match leaderboard: those carry a
       monthly prize and a collective score is not comparable to a solo one.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as mmc from '../../functions/api/memory-match-chat.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

function makeEnv({ profiles = [] } = {}) {
  const store = new Map();
  const chains = new Map();
  for (const id of profiles) store.set(`profile_${id}`, JSON.stringify({ userId: String(id) }));
  return {
    MARKETPLACE: {
      async get(k, t) { if (!store.has(k)) return null; const r = store.get(k); return t === 'json' ? JSON.parse(r) : r; },
      async put(k, v) { store.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
      async delete(k) { store.delete(k); },
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

const board = (env) => JSON.parse(env._store.get('mm_chat'));
const save = (env, g) => env._store.set('mm_chat', JSON.stringify(g));
async function view(env) { return await (await mmc.onRequestGet({ env })).json(); }
const vote = (env, id, n, name) => mmc.flipFromChat(env, { userId: id, name: name || ('u' + id), text: String(n) });
const entries = (env, id) => {
  for (const [k, v] of env._store) if (k.startsWith(`gwe_${id}_`)) return JSON.parse(v).entries;
  return 0;
};
/** Wind the clock back so the current window has already closed. */
function expire(env) {
  const g = board(env);
  g.voteUntil = Date.now() - 1;
  g.revealUntil = Date.now() - 1;
  save(env, g);
}
/* Close the window AND pump the lazy clock. Nothing advances on its own, so
   a test that only expires has not actually moved the board. */
async function step(env) { expire(env); return await mmc.tick(env); }
/** Play one full move: vote a, flip it, vote b, resolve, clear the beat. */
async function playMove(env, a, b, id = '1', name = 'Alice') {
  await vote(env, id, a, name); await step(env);
  await vote(env, id, b, name); await step(env);
  await step(env);
}
/** A board with a known layout: pair p sits at 2p and 2p+1. */
function rigged(env, pairs) {
  const g = board(env);
  g.deck = [];
  for (let p = 0; p < pairs; p++) g.deck.push(p, p);
  save(env, g);
  return g.deck;
}

/* ── Starting ────────────────────────────────────────────────────────────── */
{
  const env = makeEnv();
  await mmc.startGame(env, 10);
  const g = board(env);
  check('a full deck is dealt', g.deck.length, 20);
  check('every pair twice', g.deck.filter(f => f === 0).length, 2);
  check('nothing matched', g.matched.filter(Boolean).length, 0);
  check('voting from the off', g.phase, 'vote');

  const v = await view(env);
  check('the overlay shows it', v.status, 'live');
  check('with every card', v.cards.length, 20);
  check('no moves yet', v.moves, 0);

  await mmc.startGame(env, 999);
  check('a silly board size falls back', board(env).pairs, 10);
}

/* ── THE BOARD IS NOT IN THE PAYLOAD ─────────────────────────────────────
   The overlay URL is public. A face on a face-down card is the answer key. */
{
  const env = makeEnv();
  await mmc.startGame(env, 10);
  const v = await view(env);
  check('every card is face down', v.cards.filter(c => c.face !== null).length, 0);
  ok('and none claims to be up', v.cards.every(c => !c.up && !c.matched));
}

/* ── Voting ──────────────────────────────────────────────────────────────── */
{
  const env = makeEnv();
  await mmc.startGame(env, 10);

  check('a vote lands', (await vote(env, '1', 3)).ok, true);
  check('stored 0-based from a 1-based message', board(env).votes['1'].index, 2);
  check('out of range is refused', (await vote(env, '2', 99)).reason, 'no-match');
  check('zero too', (await vote(env, '2', 0)).reason, 'no-match');
  check('nonsense too', (await vote(env, '2', 'x')).reason, 'no-match');
  check('a chatter may change their vote', (await vote(env, '1', 4)).ok, true);
  check('counted once', Object.keys(board(env).votes).length, 1);
  check('the same vote twice is a no-op', (await vote(env, '1', 4)).reason, 'same');
}

/* ── A move is two windows, and a MATCH sticks ──────────────────────────── */
{
  const env = makeEnv();
  await mmc.startGame(env, 10);
  rigged(env, 10);                       // pair p at 2p, 2p+1

  await vote(env, '1', 1);               // card index 0
  await step(env);
  let v = await view(env);
  check('the first card turns over', v.cards[0].up, true);
  check('and shows its face', v.cards[0].face, 0);
  check('no move counted yet', v.moves, 0);
  check('back to voting', v.phase, 'vote');

  await vote(env, '1', 2);               // index 1 — its pair
  await step(env);
  v = await view(env);
  check('the move counts', v.moves, 1);
  check('a match is announced', v.lastMatch, true);
  check('and both are matched', [v.cards[0].matched, v.cards[1].matched], [true, true]);
  check('one pair down', v.pairsFound, 1);
}

/* ── A NON-MATCH STAYS UP FOR A BEAT, THEN TURNS BACK ────────────────────
   The pause is the mechanic. Without it chat never sees what was there. */
{
  const env = makeEnv();
  await mmc.startGame(env, 10);
  rigged(env, 10);

  await vote(env, '1', 1);               // index 0, face 0
  await step(env);
  await vote(env, '1', 3);               // index 2, face 1 — no match
  await step(env);

  let v = await view(env);
  check('the panel is in the reveal beat', v.phase, 'reveal');
  check('reported as a miss', v.lastMatch, false);
  check('both faces are visible', [v.cards[0].face, v.cards[2].face], [0, 1]);
  check('neither is matched', [v.cards[0].matched, v.cards[2].matched], [false, false]);
  check('and the move still counted', v.moves, 1);

  await step(env);
  v = await view(env);
  check('then they turn back over', v.phase, 'vote');
  check('hiding both faces again', [v.cards[0].face, v.cards[2].face], [null, null]);
}

/* ── A matched or face-up card cannot be voted for ───────────────────────── */
{
  const env = makeEnv();
  await mmc.startGame(env, 10);
  rigged(env, 10);
  await playMove(env, 1, 2);             // pair 0 matched

  check('a matched card is refused', (await vote(env, '2', 1)).reason, 'no-match');
  await vote(env, '2', 3); await step(env);   // index 2 now face up
  check('and so is the card already face up', (await vote(env, '3', 3)).reason, 'no-match');
}

/* ── A silent window runs back rather than stalling ──────────────────────── */
{
  const env = makeEnv();
  await mmc.startGame(env, 10);
  expire(env);
  const v = await view(env);
  check('the board is still voting', v.phase, 'vote');
  check('nothing flipped', v.cards.filter(c => c.up).length, 0);
  ok('and the window was reopened', v.secondsLeft > 0);
}

/* ── THE LAZY CLOCK IS CORRECT FROM ANY DISTANCE ────────────────────────
   Nothing schedules a flip. A read minutes later must land somewhere sane,
   not replay every window it slept through. */
{
  const env = makeEnv();
  await mmc.startGame(env, 10);
  rigged(env, 10);
  await vote(env, '1', 1);
  const g = board(env);
  g.voteUntil = Date.now() - 10 * 60 * 1000;    // ten minutes late
  save(env, g);

  const v = await view(env);
  check('exactly one flip is applied', v.cards.filter(c => c.up).length, 1);
  check('the voted one', v.cards[0].up, true);
  check('and it is voting again', v.phase, 'vote');
}

/* ── Clearing the board ──────────────────────────────────────────────────── */
{
  const env = makeEnv({ profiles: ['1'] });
  await mmc.startGame(env, 10);
  rigged(env, 10);

  for (let p = 0; p < 10; p++) await playMove(env, 2 * p + 1, 2 * p + 2);

  const v = await view(env);
  check('the board is done', v.status, 'done');
  check('all pairs found', v.pairsFound, 10);
  check('in a perfect ten moves', v.moves, 10);
  check('and chat has a best for that size', v.best, 10);
  check('the finisher is paid', entries(env, '1'), 1);
  check('and named', v.result.by, 'Alice');
  check('flagged as a new best', v.result.improved, true);

  /* Reading again must not pay twice. */
  await view(env);
  check('a second read pays nothing more', entries(env, '1'), 1);
}

/* ── A chat-only finisher is named but not paid ──────────────────────────── */
{
  const env = makeEnv();                       // nobody has logged in
  await mmc.startGame(env, 10);
  rigged(env, 10);
  for (let p = 0; p < 10; p++) await playMove(env, 2 * p + 1, 2 * p + 2, '9', 'Lurker');
  const v = await view(env);
  check('the board still clears', v.status, 'done');
  check('they are still named', v.result.by, 'Lurker');
  check('but nothing is paid', v.result.paid, false);
  check('and no ledger row is invented', entries(env, '9'), 0);
}

/* ── IT NEVER TOUCHES THE REAL LEADERBOARD ──────────────────────────────── */
{
  const env = makeEnv({ profiles: ['1'] });
  await mmc.startGame(env, 10);
  rigged(env, 10);
  for (let p = 0; p < 10; p++) await playMove(env, 2 * p + 1, 2 * p + 2);
  await view(env);
  const keys = [...env._store.keys()];
  check('no memory-match board was written', keys.filter(k => k.startsWith('lb_memory_match')), []);
  check('no personal game either', keys.filter(k => k.startsWith('mm_game_')), []);
  ok('chat keeps its own record instead', keys.includes('mm_chat_best'));
}

/* ── Stopping, and the done state clearing itself ───────────────────────── */
{
  const env = makeEnv();
  await mmc.startGame(env, 10);
  await mmc.stopGame(env);
  check('stopping clears it', (await view(env)).status, 'none');
  check('and votes do nothing', (await vote(env, '1', 1)).reason, 'closed');
}

{
  const env = makeEnv({ profiles: ['1'] });
  await mmc.startGame(env, 10);
  rigged(env, 10);
  for (let p = 0; p < 10; p++) await playMove(env, 2 * p + 1, 2 * p + 2);
  check('the result shows at first', (await view(env)).status, 'done');
  const g = board(env);
  g.finishedAt = Date.now() - 10 * 60 * 1000;
  save(env, g);
  check('then takes itself off screen', (await view(env)).status, 'none');
}

/* ── Only staff may run it ───────────────────────────────────────────────── */
{
  const env = makeEnv();
  env._store.set('site_moderators', JSON.stringify({ entries: [] }));
  const res = await mmc.onRequestPost({
    env,
    request: new Request('https://p.tv/api/memory-match-chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'start', pairs: 10 }),
    }),
  });
  check('an anonymous caller is refused', res.status, 403);
  check('and no board is dealt', env._store.has('mm_chat'), false);
}

/* ── Wiring ──────────────────────────────────────────────────────────────── */
{
  const registry = fs.readFileSync(path.join(REPO, 'server/lib/registry.js'), 'utf8');
  ok('the registry maps the live board', /mm_chat:\s*\{/.test(registry));
  ok('and chat\'s best, non-expiring', /mm_chat_best:[^\n]*expiry: 'none'/.test(registry));

  const cmds = fs.readFileSync(path.join(REPO, 'functions/api/bot/commands.js'), 'utf8');
  ok('chat dispatches !flip', /parsed\.command === '!flip'/.test(cmds));
  ok('as a PUBLIC command, before the moderator gate',
     cmds.indexOf("'!flip'") < cmds.indexOf('if (!isAuthorizedSender(env, event)) return;'));

  const ovHtml = fs.readFileSync(path.join(REPO, 'overlay.html'), 'utf8');
  ok('the overlay has the panel', /id="ovMemChat"/.test(ovHtml));
  ok('and loads its driver', /overlay-memory-chat\.js/.test(ovHtml));

  const ovCss = fs.readFileSync(path.join(REPO, 'css/pages/overlay.css'), 'utf8');
  ok('the panel still reaches display:none when hidden',
     /\.ov-mmc\[hidden\] \{ display: none; \}/.test(ovCss));

  const layout = fs.readFileSync(path.join(REPO, 'functions/api/overlay/layout.js'), 'utf8');
  ok('the layout route stores its position', /'ovMemChat'/.test(layout));

  const samples = fs.readFileSync(path.join(REPO, 'js/pages/overlay-samples.js'), 'utf8');
  ok('and the editor can place it', /id: 'ovMemChat'/.test(samples));

  const driver = fs.readFileSync(path.join(REPO, 'js/pages/overlay-memory-chat.js'), 'utf8');
  ok('the grid is built once per game, then toggled', /builtFor = cards\.length/.test(driver));
  ok('and the poller backs off when idle', /IDLE_POLL_MS/.test(driver));

  const dashHtml = fs.readFileSync(path.join(REPO, 'overlay-dashboard.html'), 'utf8');
  ok('the dashboard can start and stop it',
     /id="odMemStartBtn"/.test(dashHtml) && /id="odMemStopBtn"/.test(dashHtml));
  ok('with a board size', /id="odMemPairs"/.test(dashHtml));
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[memory-match-chat] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[memory-match-chat] ${passed} assertions passed.`);
console.log('');
