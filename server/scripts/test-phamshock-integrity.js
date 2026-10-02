#!/usr/bin/env node
/* ══════════════════════════════════════════════
   PHAMSHOCK INTEGRITY — what the room leaks, who writes it, who scores it

     node server/scripts/test-phamshock-integrity.js

   1. get-state is public (codes are listed), so it must never carry the
      room password or anybody's locked-in shot.
   2. Every room write goes through mutate(). The stand-in below holds a
      per-key lock and yields between steps, so a get-then-put handler
      would interleave here and lose writes, exactly as it did live.
   3. A round resolves once, and resolving it again (if anything ever did)
      gives the same battle -- sub-shells are seeded from the room.
   4. Wins are written by the server when the match ends, once, and only
      for a real match. The page no longer reports its own win.
   5. A kicked player stays kicked.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { onRequestGet, onRequestPost, _resolve } from '../../functions/api/pham-shock.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.resolve(HERE, '../../games/phamshock/index.html');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

const tick = () => new Promise(r => setImmediate(r));

function makeEnv() {
  const store = new Map();
  const locks = new Map();
  const calls = [];
  return {
    MARKETPLACE: {
      async get(key, type) {
        await tick();
        if (!store.has(key)) return null;
        const raw = store.get(key);
        return type === 'json' ? JSON.parse(raw) : raw;
      },
      async put(key, value) { await tick(); store.set(key, typeof value === 'string' ? value : JSON.stringify(value)); },
      async delete(key) { await tick(); store.delete(key); },
      async mutate(key, fn) {
        const prev = locks.get(key) || Promise.resolve();
        let release;
        const mine = new Promise(r => { release = r; });
        locks.set(key, prev.then(() => mine));
        await prev;
        try {
          await tick();
          const current = store.has(key) ? JSON.parse(store.get(key)) : null;
          const next = await fn(current);
          await tick();
          if (next === undefined) return current;
          store.set(key, JSON.stringify(next));
          if (key.startsWith('lb_')) calls.push('board:' + key);
          return JSON.parse(store.get(key));
        } finally { release(); }
      },
      async listValues({ prefix }) {
        const out = [];
        for (const [name, raw] of store) if (name.startsWith(prefix)) out.push({ name, value: JSON.parse(raw) });
        return out;
      },
      async claimMonthlyAward() { calls.push('monthly'); return false; },
    },
    _store: store,
    _calls: calls,
  };
}

const USERS = {
  a: { user_id: '101', display_name: 'Ash' },
  b: { user_id: '202', display_name: 'Bry' },
  c: { user_id: '303', display_name: 'Cal' },
};

function headersFor(who) {
  const h = { 'Content-Type': 'application/json' };
  if (USERS[who]) h.Cookie = `pham_session=${encodeURIComponent(JSON.stringify(USERS[who]))}`;
  return h;
}

async function post(env, who, body) {
  const extra = USERS[who] ? {} : { guestId: who, guestName: 'G-' + who };
  const res = await onRequestPost({
    env,
    request: new Request('https://test.local/api/pham-shock', {
      method: 'POST', headers: headersFor(who), body: JSON.stringify({ ...body, ...extra }),
    }),
  });
  return { status: res.status, data: await res.json() };
}

async function get(env, qs) {
  const res = await onRequestGet({ env, request: new Request(`https://test.local/api/pham-shock?${qs}`) });
  return { status: res.status, raw: await res.clone().text(), data: await res.json() };
}

function edit(env, code, fn) {
  const key = 'ps_room_' + code;
  const room = JSON.parse(env._store.get(key));
  fn(room);
  env._store.set(key, JSON.stringify(room));
}
const peek = (env, code) => JSON.parse(env._store.get('ps_room_' + code));
const board = (env) => (env._store.has('lb_shell_shock') ? JSON.parse(env._store.get('lb_shell_shock')) : []);
const idOf = (who) => (USERS[who] ? USERS[who].user_id : 'guest_' + who);

/** Room with these players, everyone ready, game started, wind still. */
async function startedRoom(env, who, opts = {}) {
  const made = await post(env, who[0], { action: 'create-room', password: opts.password || null });
  const code = made.data.code;
  for (const w of who.slice(1)) await post(env, w, { action: 'join-room', code, password: opts.password || undefined });
  for (const w of who) await post(env, w, { action: 'set-ready', code, ready: true });
  const s = await post(env, who[0], { action: 'start-game', code });
  if (s.status !== 200) throw new Error('start failed: ' + JSON.stringify(s.data));
  edit(env, code, r => { r.wind = 0; });
  return code;
}

function expireAim(env, code) { edit(env, code, r => { r.roundStartedAt = Date.now() - 31000; }); }

/* ── 1. Password and pending shots never leave the server ─────────────── */
{
  const env = makeEnv();
  const SECRET = 'hunter2-pw';
  const made = await post(env, 'a', { action: 'create-room', password: SECRET });
  const code = made.data.code;

  const lobby = await get(env, `action=get-state&code=${code}`);
  check('lobby get-state works without a login', lobby.status, 200);
  ok('the password is not anywhere in get-state', !lobby.raw.includes(SECRET));
  ok('and there is no password field at all', !('password' in lobby.data));
  check('the page is told only that one exists', lobby.data.hasPassword, true);

  const list = await get(env, 'action=list-rooms');
  ok('list-rooms does not carry it either', !list.raw.includes(SECRET));

  check('wrong password is still refused', (await post(env, 'b', { action: 'join-room', code, password: 'nope' })).status, 403);
  check('right password still admits', (await post(env, 'b', { action: 'join-room', code, password: SECRET })).status, 200);
  for (const w of ['a', 'b']) await post(env, w, { action: 'set-ready', code, ready: true });
  await post(env, 'a', { action: 'start-game', code });

  const shot = await post(env, 'a', { action: 'submit-turn', code, angle: 37, power: 83, weapon: 1 });
  check('a shot is accepted', shot.status, 200);
  ok('and stored server-side', peek(env, code).players[idOf('a')].submission);

  const mid = await get(env, `action=get-state&code=${code}`);
  ok('mid-aim get-state says Ash locked in', mid.data.players[idOf('a')].submitted);
  ok('but not what Ash fired', !mid.raw.includes('"submission"'));
  ok('no player record carries a submission', Object.values(mid.data.players).every(p => !('submission' in p)));
  ok('password still absent once playing', !mid.raw.includes(SECRET));
  ok('kicked list is not published', !('kicked' in mid.data));
}

/* ── 2. Simultaneous shots near the deadline all land ─────────────────── */
{
  const env = makeEnv();
  const code = await startedRoom(env, ['a', 'b', 'c']);
  const shots = await Promise.all([
    post(env, 'a', { action: 'submit-turn', code, angle: 60, power: 40, weapon: 0 }),
    post(env, 'b', { action: 'submit-turn', code, angle: 120, power: 40, weapon: 0 }),
    post(env, 'c', { action: 'submit-turn', code, angle: 90, power: 30, weapon: 0 }),
  ]);
  check('three simultaneous submits all succeed', shots.map(s => s.status), [200, 200, 200]);
  const room = peek(env, code);
  check('and all three were fired in the round', (room.roundResults || []).map(r => r.pid).sort(),
    [idOf('a'), idOf('b'), idOf('c')].sort());
  check('the round resolved exactly once', room.resolvedRound, 1);
}

/* ── 3. Resolve once under concurrent polls, identically ──────────────── */
async function splitterRound() {
  const env = makeEnv();
  const code = await startedRoom(env, ['a', 'b']);
  edit(env, code, r => {
    r.players[idOf('a')].submitted = true;
    r.players[idOf('a')].submission = { angle: 50, power: 45, weapon: 4 };
    r.players[idOf('b')].submitted = true;
    r.players[idOf('b')].submission = { angle: 125, power: 45, weapon: 9 };
    r.roundStartedAt = Date.now() - 31000;
  });
  return { env, code };
}

{
  const { env, code } = await splitterRound();
  const before = peek(env, code);
  const polls = await Promise.all(Array.from({ length: 12 }, () => get(env, `action=get-state&code=${code}`)));
  const after = peek(env, code);

  check('every concurrent poll succeeds', polls.every(p => p.status === 200), true);
  check('the round resolved once', after.resolvedRound, 1);
  const sigs = new Set(polls.map(p => JSON.stringify(p.data.roundResults)));
  check('every poll saw the same roundResults', sigs.size, 1);
  ok('and sub-shells were actually fired', after.roundResults.some(r => r.subs.length > 0));

  const expectedCraters = after.roundResults.reduce((n, r) => n + (r.hit && !r.burst ? 1 : 0) + r.subs.length, 0);
  check('explosions grew by one round, not twelve', after.explosions.length - before.explosions.length, expectedCraters);
  check('each player lost exactly one round of ammo',
    [after.players[idOf('a')].ammo[4], after.players[idOf('b')].ammo[9]], [1, 0]);

  const again = await splitterRound();
  await get(again.env, `action=get-state&code=${again.code}`);
  const b = peek(again.env, again.code);
  edit(again.env, again.code, r => { r.code = code; });
  const sameSeed = await splitterRound();
  edit(sameSeed.env, sameSeed.code, r => {
    r.code = code; r.terrainSeed = before.terrainSeed;
    for (const id of Object.keys(r.players)) r.players[id].x = before.players[id].x;
  });
  await get(sameSeed.env, `action=get-state&code=${sameSeed.code}`);
  check('a fresh room with the same code, seed and shots plays the same battle',
    JSON.stringify(peek(sameSeed.env, sameSeed.code).roundResults), JSON.stringify(after.roundResults));
  ok('(a different room plays a different one)', JSON.stringify(b.roundResults) !== JSON.stringify(after.roundResults));
}

{
  const { env, code } = await splitterRound();
  const base = peek(env, code);
  base.phase = 'aiming';
  const r1 = JSON.parse(JSON.stringify(base));
  const r2 = JSON.parse(JSON.stringify(base));
  const real = Math.random;
  let n = 0;
  Math.random = () => ((n++ * 0.6180339887) % 1);
  _resolve(r1);
  Math.random = () => 0.999;
  _resolve(r2);
  Math.random = real;
  check('resolve ignores Math.random: two runs, two RNG states, one battle',
    JSON.stringify(r1.roundResults), JSON.stringify(r2.roundResults));
  check('and the same terrain afterwards', JSON.stringify(r1.explosions), JSON.stringify(r2.explosions));
  check('resolving the same round twice is a no-op', _resolve(r1), false);
}

/* ── 4. Wins are recorded by the server, once, for real matches ───────── */
/* b fires a Nuke straight up from 1 HP and it comes down on b. a sits out. */
async function finishWith(env, code, loser) {
  edit(env, code, r => {
    const p = r.players[idOf(loser)];
    p.hp = 1;
    p.submitted = true;
    p.submission = { angle: 90, power: 10, weapon: 3 };
  });
  expireAim(env, code);
  return Promise.all(Array.from({ length: 8 }, () => get(env, `action=get-state&code=${code}`)));
}

{
  const env = makeEnv();
  const code = await startedRoom(env, ['a', 'b']);
  const polls = await finishWith(env, code, 'b');
  const room = peek(env, code);
  check('the match finished', room.status, 'finished');
  check('Ash won', room.winner, idOf('a'));
  check('every poll saw the same winner', [...new Set(polls.map(p => p.data.winner))], [idOf('a')]);
  check('the win is on lb_shell_shock once', board(env).map(e => [e.id, e.score]), [[idOf('a'), 1]]);
  check('with the winner\'s name', (board(env)[0] || {}).name, 'Ash');
  ok('monthly awards were settled before the board write',
    env._calls.indexOf('monthly') > -1 && env._calls.indexOf('monthly') < env._calls.indexOf('board:lb_shell_shock'));
  for (let i = 0; i < 5; i++) await get(env, `action=get-state&code=${code}`);
  await post(env, 'a', { action: 'submit-turn', code, angle: 45, power: 50, weapon: 0 });
  check('later polls and requests do not count it again', (board(env)[0] || {}).score, 1);

  const code2 = await startedRoom(env, ['a', 'b']);
  await finishWith(env, code2, 'b');
  check('a second match adds a second win', (board(env)[0] || {}).score, 2);
}

{
  const env = makeEnv();
  const code = await startedRoom(env, ['a', 'zed']);
  await finishWith(env, code, 'zed');
  check('beating a guest finishes the match', peek(env, code).winner, idOf('a'));
  check('but does not count -- guest ids are free to mint', board(env), []);
}

{
  const env = makeEnv();
  const code = await startedRoom(env, ['a', 'b']);
  await post(env, 'b', { action: 'leave-room', code });
  expireAim(env, code);
  await get(env, `action=get-state&code=${code}`);
  const room = peek(env, code);
  check('an abandoned match ends with the last one standing', [room.status, room.winner], ['finished', idOf('a')]);
  check('and is not a win', board(env), []);
}

{
  const env = makeEnv();
  const code = await startedRoom(env, ['a', 'b']);
  edit(env, code, r => { r.status = 'finished'; r.winner = idOf('a'); r.players[idOf('b')].eliminated = true; delete r.finishedAt; });
  await get(env, `action=get-state&code=${code}`);
  check('a room finished before this change (no finishedAt) is left alone', board(env), []);
}

/* ── 5. Kicks stick ───────────────────────────────────────────────────── */
{
  const env = makeEnv();
  const made = await post(env, 'a', { action: 'create-room' });
  const code = made.data.code;
  await post(env, 'b', { action: 'join-room', code });
  check('only the host may kick', (await post(env, 'b', { action: 'kick-player', code, targetId: idOf('a') })).status, 403);
  check('the host kicks Bry', (await post(env, 'a', { action: 'kick-player', code, targetId: idOf('b') })).status, 200);
  const back = await post(env, 'b', { action: 'join-room', code });
  check('Bry cannot rejoin', back.status, 403);
  check('and is told why', back.data.error, 'The host removed you from this room.');
  ok('Bry is not in the room', !peek(env, code).players[idOf('b')]);
  check('someone else still can join', (await post(env, 'c', { action: 'join-room', code })).status, 200);
}

/* ── 6. The page ──────────────────────────────────────────────────────── */
{
  const src = fs.readFileSync(CLIENT, 'utf8');
  ok('the page no longer POSTs its own win', !/\/api\/leaderboards/.test(src));
  ok('the lobby reads hasPassword, not the password', /room\.hasPassword/.test(src) && !/room\.password/.test(src));
  ok('weapon hotkeys cover 0-9', /\/\^\[0-9\]\$\/\.test\(e\.key\)/.test(src) && /e\.key === '0' \? 9/.test(src));
  ok('the old 1-5 hotkey range is gone', !/e\.key <= '5'/.test(src));
  const submit = src.slice(src.indexOf('async function submitTurn'), src.indexOf('// ── Game Over'));
  ok('submitTurn shows refusals instead of swallowing them', /showNotice\(/.test(submit) && !/if \(data\.error\) return;/.test(submit));
  ok('no invalid var(--red)NN colours remain', !/var\(--red\)[0-9a-f]{2}/i.test(src));
  ok('no box-shadow', !/box-shadow/.test(src));
  ok('the notice can be hidden', /\.game-notice\[hidden\]\s*\{\s*display:\s*none/.test(src));
}

if (failures.length) {
  console.error(`\nFAIL — ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`PASS — ${passed} checks`);
