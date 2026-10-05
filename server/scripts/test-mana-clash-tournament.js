#!/usr/bin/env node
/* ══════════════════════════════════════════════
   MANA CLASH — BRACKET NIGHT test suite

     node server/scripts/test-mana-clash-tournament.js

   Drives the real handlers with a fake MARKETPLACE: sign-ups, bracket
   generation (incl. byes), seeding match rooms, reporting results (both the
   settle path and the manual host override), round advancement, and crowning a
   champion.
   ══════════════════════════════════════════════ */

import {
  onRequestGet, onRequestPost, generateBracket, setMatchWinner,
  publicTournament, reportTournamentMatch, TOURNEY_KEY,
} from '../../functions/api/mana-clash-tournament.js';

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
function ok(label, cond) { check(label, !!cond, true); }

function makeEnv() {
  const store = new Map();
  return {
    TWITCH_BROADCASTER_ID: '999',
    MARKETPLACE: {
      async get(key, type) {
        if (!store.has(key)) return null;
        const raw = store.get(key);
        return type === 'json' ? JSON.parse(raw) : raw;
      },
      async put(key, value) { store.set(key, typeof value === 'string' ? value : JSON.stringify(value)); },
      async delete(key) { store.delete(key); },
      async mutate(key, fn) {
        const current = store.has(key) ? JSON.parse(store.get(key)) : null;
        const next = await fn(current);
        if (next === undefined) return current;
        store.set(key, JSON.stringify(next));
        return JSON.parse(store.get(key));
      },
      async listValues({ prefix }) {
        const out = [];
        for (const [name, raw] of store) if (name.startsWith(prefix)) out.push({ name, value: JSON.parse(raw) });
        return out;
      },
    },
    _store: store,
  };
}

const USERS = {
  host: { user_id: '999', display_name: 'PhantomACE' },
  a: { user_id: '101', display_name: 'Ash' },
  b: { user_id: '202', display_name: 'Bry' },
  c: { user_id: '303', display_name: 'Cal' },
  d: { user_id: '404', display_name: 'Dot' },
};
const cookieFor = (u) => `pham_session=${encodeURIComponent(JSON.stringify(USERS[u]))}`;

async function post(env, who, body) {
  const res = await onRequestPost({
    env,
    request: new Request('https://test.local/api/mana-clash-tournament', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieFor(who) },
      body: JSON.stringify(body),
    }),
  });
  return { status: res.status, data: await res.json() };
}
async function get(env, who) {
  const res = await onRequestGet({
    env, request: new Request('https://test.local/api/mana-clash-tournament', { headers: { Cookie: cookieFor(who) } }),
  });
  return { status: res.status, data: await res.json() };
}
const raw = (env) => JSON.parse(env._store.get(TOURNEY_KEY));

/* ── Pure bracket math ── */
{
  const b4 = generateBracket([{ id: '1', name: 'A' }, { id: '2', name: 'B' }, { id: '3', name: 'C' }, { id: '4', name: 'D' }]);
  check('4 players → 2 rounds', b4.length, 2);
  check('round 0 has 2 matches', b4[0].length, 2);
  check('final round has 1 match', b4[1].length, 1);
  ok('no byes with a full power-of-two field', b4[0].every(m => !m.bye));

  const b3 = generateBracket([{ id: '1', name: 'A' }, { id: '2', name: 'B' }, { id: '3', name: 'C' }]);
  check('3 players → padded to a 4-slot bracket (2 rounds)', b3.length, 2);
  ok('3 players produce exactly one bye', b3[0].filter(m => m.bye && m.winner).length === 1);
  const byeWinner = b3[0].find(m => m.bye && m.winner).winner;
  ok('the bye player is advanced into the final', b3[1].some(m => (m.a && m.a.id === byeWinner) || (m.b && m.b.id === byeWinner)));

  /* setMatchWinner cascades into the next round and crowns a champion. */
  const st = { status: 'active', players: [{ id: '1', name: 'A' }, { id: '2', name: 'B' }, { id: '3', name: 'C' }, { id: '4', name: 'D' }], rounds: b4, round: 0, champion: null };
  setMatchWinner(st, 0, 0, st.rounds[0][0].a.id);
  setMatchWinner(st, 0, 1, st.rounds[0][1].a.id);
  ok('both round-0 winners slot into the final', st.rounds[1][0].a && st.rounds[1][0].b);
  setMatchWinner(st, 1, 0, st.rounds[1][0].a.id);
  check('a final-round winner becomes champion', st.champion.id, st.rounds[1][0].a.id);
  check('and the tournament is done', st.status, 'done');
}

/* ── Full flow through the handlers ── */
{
  const env = makeEnv();

  check('a non-mod cannot open a bracket', (await post(env, 'a', { action: 'open' })).status, 403);
  check('the broadcaster opens sign-ups', (await post(env, 'host', { action: 'open' })).data.tournament.status, 'signups');

  for (const u of ['a', 'b', 'c', 'd']) await post(env, u, { action: 'join' });
  check('four players joined', raw(env).players.length, 4);
  check('joining twice is a no-op', (await post(env, 'a', { action: 'join' })).data.tournament.playerCount, 4);

  check('generate needs the mod', (await post(env, 'a', { action: 'generate' })).status, 403);
  const gen = await post(env, 'host', { action: 'generate' });
  check('generate activates the bracket', gen.data.tournament.status, 'active');
  check('2 rounds for 4 players', raw(env).rounds.length, 2);

  await post(env, 'host', { action: 'start-round' });
  const r0 = raw(env).rounds[0];
  ok('both round-0 matches got a room code', r0.every(m => m.code));
  const room0 = JSON.parse(env._store.get('mc_room_' + r0[0].code));
  ok('a match room is seeded with both players', Object.keys(room0.players).length === 2);
  check('the match room is tagged for the tournament', room0.tournament, { round: 0, match: 0 });

  /* settle-path report for match 0; manual host report for match 1. */
  await reportTournamentMatch(env, { round: 0, match: 0 }, r0[0].a.id);
  check('a reported match records its winner', raw(env).rounds[0][0].winner, r0[0].a.id);
  await post(env, 'host', { action: 'report', round: 0, match: 1, winnerId: r0[1].b.id });
  check('the host can report a winner by hand', raw(env).rounds[0][1].winner, r0[1].b.id);

  check('cannot advance a player (mod only)', (await post(env, 'a', { action: 'advance' })).status, 403);
  check('advancing to the final', (await post(env, 'host', { action: 'advance' })).data.tournament.round, 1);

  await post(env, 'host', { action: 'start-round' });
  const final = raw(env).rounds[1][0];
  ok('the final match got a room code', !!final.code);
  await reportTournamentMatch(env, { round: 1, match: 0 }, final.a.id);
  const done = raw(env);
  check('the final crowns a champion', done.status, 'done');
  ok('the champion is one of the finalists', done.champion && (done.champion.id === final.a.id));

  /* The public view never leaks user ids; a player sees their own match. */
  const viewA = (await get(env, 'a')).data;
  ok('public rounds carry names, not ids', viewA.rounds.every(rd => rd.every(m => (!m.a || m.a.id === undefined) && (!m.b || m.b.id === undefined))));
  ok('champion is exposed by name', viewA.champion && viewA.champion.name);
}

console.log('');
if (failures.length) {
  console.log(`[mana-clash-tournament] ${passed} passed, ${failures.length} FAILED\n`);
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[mana-clash-tournament] ${passed} assertions passed.`);
console.log('');
