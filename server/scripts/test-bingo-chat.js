#!/usr/bin/env node
/* ══════════════════════════════════════════════
   COMMANDER BINGO — CHAT'S SHARED CARD

     node server/scripts/test-bingo-chat.js

   RUNS OFFLINE.

   WHAT THIS IS GUARDING. One card for the whole channel, on stream for a
   whole bingo night:

     - THE MARKS ARE NEVER STORED. They are derived from the room's own
       calledEvents every read, so a host's UNDO walks the card backwards too.
       A stored copy would be a second truth about what has been called, and
       the first desync would have the card on stream lying to everybody.
     - The wildcard cannot be spent on a square already called, or on the free
       space — both would be a vote that visibly did nothing.
     - It is placed ONCE. After that, votes stop.
     - A bingo is noticed and PAID on the call, not on the overlay's public
       read, and paid once: a second line must not re-pay the same people.
     - A card belongs to one room. Calls in another room must not touch it.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as bgc from '../../functions/api/bingo-chat.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

function makeEnv({ profiles = [], code = 'ABCD', called = [], status = 'active' } = {}) {
  const store = new Map();
  const chains = new Map();
  store.set(`bingo_${code}`, JSON.stringify({ code, status, calledEvents: called, players: [] }));
  store.set('bingo_current', JSON.stringify({ code }));
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

const card = (env) => JSON.parse(env._store.get('bingo_chat'));
async function view(env) {
  return await (await bgc.onRequestGet({ env })).json();
}
const stamp = (env, id, n, name) => bgc.stampFromChat(env, { userId: id, name: name || ('u' + id), text: String(n) });
const entries = (env, id) => {
  for (const [k, v] of env._store) if (k.startsWith(`gwe_${id}_`)) return JSON.parse(v).entries;
  return 0;
};
/** Call every square of chat's card except the ones named, to force a line. */
function callSquares(env, code, idxs) {
  const c = card(env);
  const game = JSON.parse(env._store.get(`bingo_${code}`));
  for (const i of idxs) if (c.cardIds[i] !== 0) game.calledEvents.push(c.cardIds[i]);
  env._store.set(`bingo_${code}`, JSON.stringify(game));
}

/* ── Opening ─────────────────────────────────────────────────────────────── */
{
  const env = makeEnv();
  check('an unknown game cannot be dealt a card', (await bgc.openChatCard(env, 'NOPE')).ok, false);

  const r = await bgc.openChatCard(env, 'ABCD');
  check('the live game can', r.ok, true);
  check('a full card is dealt', card(env).cardIds.length, 25);
  check('with a free space in the middle', card(env).cardIds[12], 0);

  const v = await view(env);
  check('the overlay shows it', v.status, 'live');
  check('25 squares', v.squares.length, 25);
  check('the free space marked from the off', v.squares[12].marked, true);
  check('and only that one', v.marked, 1);
}

{
  const env = makeEnv({ status: 'ended' });
  check('an ended game cannot be dealt a card', (await bgc.openChatCard(env, 'ABCD')).ok, false);
}

/* ── THE MARKS FOLLOW THE ROOM, INCLUDING BACKWARDS ─────────────────────── */
{
  const env = makeEnv();
  await bgc.openChatCard(env, 'ABCD');
  callSquares(env, 'ABCD', [0, 1, 2]);
  check('called squares mark themselves', (await view(env)).marked, 4);   // + free

  /* The host undoes one. Nothing tells the card — it is derived. */
  const game = JSON.parse(env._store.get('bingo_ABCD'));
  game.calledEvents.pop();
  env._store.set('bingo_ABCD', JSON.stringify(game));
  check('an undo walks the card back too', (await view(env)).marked, 3);
}

/* ── Voting the wildcard ─────────────────────────────────────────────────── */
{
  const env = makeEnv();
  await bgc.openChatCard(env, 'ABCD');

  check('a vote lands', (await stamp(env, '1', 5)).ok, true);
  check('stored 0-based from a 1-based message', card(env).votes['1'].square, 4);
  check('out of range is dropped', (await stamp(env, '2', 26)).reason, 'no-match');
  check('zero too', (await stamp(env, '2', 0)).reason, 'no-match');
  check('nonsense too', (await stamp(env, '2', 'banana')).reason, 'no-match');
  /* Both of these would be a vote that visibly did nothing. */
  check('the free space is refused', (await stamp(env, '2', 13)).reason, 'free-space');

  callSquares(env, 'ABCD', [7]);
  check('and a square already called', (await stamp(env, '2', 8)).reason, 'already-marked');

  check('a chatter may change their vote', (await stamp(env, '1', 6)).ok, true);
  check('still counted once', Object.keys(card(env).votes).length, 1);
  check('the same vote twice is a no-op', (await stamp(env, '1', 6)).reason, 'same');
}

/* ── Placing it, once ────────────────────────────────────────────────────── */
{
  const env = makeEnv();
  await bgc.openChatCard(env, 'ABCD');
  check('nothing to place yet', (await bgc.placeStamp(env)).ok, false);

  await stamp(env, '1', 3);
  await stamp(env, '2', 3);
  await stamp(env, '3', 9);
  const p = await bgc.placeStamp(env);
  check('the most-backed square wins', p.square, 2);
  check('with its count', p.votes, 2);

  const v = await view(env);
  check('the card shows it stamped', v.stamp, 2);
  check('and that square is marked', v.squares[2].marked, true);
  check('flagged as a stamp, not a call', v.squares[2].stamped, true);
  check('counted in the total', v.marked, 2);                       // free + stamp

  check('it cannot be placed twice', (await bgc.placeStamp(env)).ok, false);
  check('and voting is over', (await stamp(env, '4', 20)).reason, 'placed');
}

/* ── A BINGO IS NOTICED ON THE CALL, AND PAID ONCE ──────────────────────── */
{
  const env = makeEnv({ profiles: ['1', '2'] });
  await bgc.openChatCard(env, 'ABCD');
  await stamp(env, '1', 1, 'Alice');
  await stamp(env, '2', 1, 'Bob');
  await stamp(env, '3', 1, 'Lurker');          // no account

  /* The top row, minus the square chat stamped. */
  await bgc.placeStamp(env);
  callSquares(env, 'ABCD', [1, 2, 3, 4]);

  const fired = await bgc.onSquareCalled(env, 'ABCD');
  check('the bingo is noticed', fired.fired, true);
  check('and the account holders are paid', fired.paid, 2);
  check('Alice has entries', entries(env, '1'), 2);
  check('Bob too', entries(env, '2'), 2);
  check('the lurker does not', entries(env, '3'), 0);
  check('the card reports the line', (await view(env)).bingos, 1);

  /* Calling more squares must not re-pay the same people. */
  const again = await bgc.onSquareCalled(env, 'ABCD');
  check('a second check pays nothing', again.fired, false);
  check('Alice is not paid twice', entries(env, '1'), 2);
}

/* ── A second line pays again, once ─────────────────────────────────────── */
{
  const env = makeEnv({ profiles: ['1'] });
  await bgc.openChatCard(env, 'ABCD');
  await stamp(env, '1', 1, 'Alice');
  await bgc.placeStamp(env);
  callSquares(env, 'ABCD', [1, 2, 3, 4]);
  await bgc.onSquareCalled(env, 'ABCD');
  check('one line paid', entries(env, '1'), 2);

  callSquares(env, 'ABCD', [5, 6, 7, 8, 9]);
  const second = await bgc.onSquareCalled(env, 'ABCD');
  check('a second line fires', second.fired, true);
  check('and pays again', entries(env, '1'), 4);
}

/* ── A card belongs to ONE room ──────────────────────────────────────────── */
{
  const env = makeEnv({ profiles: ['1'] });
  await bgc.openChatCard(env, 'ABCD');
  await stamp(env, '1', 1, 'Alice');
  await bgc.placeStamp(env);
  callSquares(env, 'ABCD', [1, 2, 3, 4]);

  const other = await bgc.onSquareCalled(env, 'WXYZ');
  check('another room cannot fire it', other.fired, false);
  check('and nobody is paid', entries(env, '1'), 0);
}

/* ── Chat can bingo without ever stamping ───────────────────────────────── */
{
  const env = makeEnv();
  await bgc.openChatCard(env, 'ABCD');
  callSquares(env, 'ABCD', [0, 1, 2, 3, 4]);
  const r = await bgc.onSquareCalled(env, 'ABCD');
  check('the line still fires', r.fired, true);
  check('with nobody to pay', r.paid, 0);
}

/* ── The card goes away with its game ───────────────────────────────────── */
{
  const env = makeEnv();
  await bgc.openChatCard(env, 'ABCD');
  const game = JSON.parse(env._store.get('bingo_ABCD'));
  game.status = 'ended';
  env._store.set('bingo_ABCD', JSON.stringify(game));
  check('an ended game takes the panel down', (await view(env)).status, 'none');

  env._store.delete('bingo_ABCD');
  check('and so does a vanished one', (await view(env)).status, 'none');
}

{
  const env = makeEnv();
  await bgc.openChatCard(env, 'ABCD');
  await bgc.closeChatCard(env);
  check('closing clears it', (await view(env)).status, 'none');
  check('and votes do nothing', (await stamp(env, '1', 5)).reason, 'closed');
}

/* ── Opening with no code uses the room on the overlay ──────────────────── */
{
  const env = makeEnv();
  const res = await bgc.onRequestPost({
    env,
    request: new Request('https://p.tv/api/bingo-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: 'pham_session=' + encodeURIComponent(JSON.stringify({ user_id: '900' })) },
      body: JSON.stringify({ action: 'open' }),
    }),
  });
  /* No moderator list in this env, so staff gating refuses — which is the
     point of the next block. Here we only assert it did not 500. */
  ok('it answers cleanly either way', res.status === 200 || res.status === 403);
}

/* ── Only staff may run it ───────────────────────────────────────────────── */
{
  const env = makeEnv();
  env._store.set('site_moderators', JSON.stringify({ entries: [] }));
  const res = await bgc.onRequestPost({
    env,
    request: new Request('https://p.tv/api/bingo-chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'open', code: 'ABCD' }),
    }),
  });
  check('an anonymous caller is refused', res.status, 403);
  check('and no card is dealt', env._store.has('bingo_chat'), false);
}

/* ── Wiring ──────────────────────────────────────────────────────────────── */
{
  const registry = fs.readFileSync(path.join(REPO, 'server/lib/registry.js'), 'utf8');
  ok('the registry maps bingo_chat', /bingo_chat:\s*\{/.test(registry));

  const call = fs.readFileSync(path.join(REPO, 'functions/api/bingo/call.js'), 'utf8');
  ok('a call checks chat\'s card', /onSquareCalled/.test(call));
  /* After the room's lock, like every other post-write dispatch here. */
  ok('after the room lock is released',
     call.indexOf('onSquareCalled') > call.indexOf('{ expirationTtl: GAME_TTL }'));

  const cmds = fs.readFileSync(path.join(REPO, 'functions/api/bot/commands.js'), 'utf8');
  ok('chat dispatches !stamp', /parsed\.command === '!stamp'/.test(cmds));
  ok('as a PUBLIC command, before the moderator gate',
     cmds.indexOf("'!stamp'") < cmds.indexOf('if (!isAuthorizedSender(env, event)) return;'));

  const ovHtml = fs.readFileSync(path.join(REPO, 'overlay.html'), 'utf8');
  ok('the overlay has the panel', /id="ovBingoChat"/.test(ovHtml));
  ok('and loads its driver', /overlay-bingo-chat\.js/.test(ovHtml));

  const ovCss = fs.readFileSync(path.join(REPO, 'css/pages/overlay.css'), 'utf8');
  ok('the panel still reaches display:none when hidden',
     /\.ov-bgc\[hidden\] \{ display: none; \}/.test(ovCss));

  const layout = fs.readFileSync(path.join(REPO, 'functions/api/overlay/layout.js'), 'utf8');
  ok('the layout route stores its position', /'ovBingoChat'/.test(layout));

  const samples = fs.readFileSync(path.join(REPO, 'js/pages/overlay-samples.js'), 'utf8');
  ok('and the editor can place it', /id: 'ovBingoChat'/.test(samples));

  const driver = fs.readFileSync(path.join(REPO, 'js/pages/overlay-bingo-chat.js'), 'utf8');
  /* 25 cells rebuilt every two seconds for a whole bingo night is exactly the
     churn the overlay rules exist to stop. */
  ok('the grid is built once and then only toggled', /built = true/.test(driver) && /classList\.toggle/.test(driver));
  ok('and the poller backs off when no card is out', /IDLE_POLL_MS/.test(driver));

  const dashHtml = fs.readFileSync(path.join(REPO, 'overlay-dashboard.html'), 'utf8');
  ok('the dashboard can deal, place and close',
     /id="odBgcOpenBtn"/.test(dashHtml) && /id="odBgcStampBtn"/.test(dashHtml) && /id="odBgcCloseBtn"/.test(dashHtml));
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[bingo-chat] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[bingo-chat] ${passed} assertions passed.`);
console.log('');
