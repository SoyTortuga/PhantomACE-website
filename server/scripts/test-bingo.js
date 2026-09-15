#!/usr/bin/env node
/* ══════════════════════════════════════════════
   COMMANDER BINGO — test suite

     node server/scripts/test-bingo.js

   The bingo API had no authorization anywhere. Anyone who knew a room code
   — and players are told it, that is how they join — could call events into
   somebody else's game, un-call them, or end it. That was survivable while
   bingo paid nothing. It is not survivable now that a called event is what
   decides who gets giveaway entries, so the refusals are what this file is
   mostly about.

   The awkward one is who may award a prize. Hosting is open to anyone with
   a Twitch login, which is right — a pod should be able to run its own
   card. But entries are real currency, so "the host" cannot be the
   permission: a host who could mint them means anyone can, by opening a
   game and declaring themselves the winner. It takes BOTH a moderator AND
   the host of that particular game.
   ══════════════════════════════════════════════ */

import * as create from '../../functions/api/bingo/create.js';
import * as join from '../../functions/api/bingo/join.js';
import * as call from '../../functions/api/bingo/call.js';
import * as end from '../../functions/api/bingo/end.js';
import * as award from '../../functions/api/bingo/award.js';

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

function makeEnv({ moderators = [] } = {}) {
  const store = new Map();
  const chains = new Map();
  store.set('site_moderators', JSON.stringify({
    entries: moderators.map(id => ({ userId: String(id), name: 'Mod', addedBy: 'test' })),
  }));
  return {
    TWITCH_BROADCASTER_ID: '900',
    MARKETPLACE: {
      async get(k, t) { if (!store.has(k)) return null; const r = store.get(k); return t === 'json' ? JSON.parse(r) : r; },
      async put(k, v) { store.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
      async delete(k) { store.delete(k); },
      /* Serialised per key, like the real advisory lock. */
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

const USERS = {
  broadcaster: { user_id: '900', display_name: 'PhantomACE', role: 'broadcaster' },
  mod: { user_id: '101', display_name: 'Mod', role: 'visitor' },
  mod2: { user_id: '111', display_name: 'OtherMod', role: 'visitor' },
  viewer: { user_id: '202', display_name: 'Viewer', role: 'follower' },
  player: { user_id: '303', display_name: 'Player', role: 'follower' },
};

const cookie = (who) => `pham_session=${encodeURIComponent(JSON.stringify(USERS[who]))}`;

async function post(mod, env, who, body, url = 'https://t.local/api/bingo/x') {
  const headers = { 'Content-Type': 'application/json' };
  if (who) headers.Cookie = cookie(who);
  const res = await mod.onRequestPost({
    env, request: new Request(url, { method: 'POST', headers, body: JSON.stringify(body) }),
  });
  return { status: res.status, data: await res.json() };
}

const game = (env, code) => JSON.parse(env._store.get('bingo_' + code));

/* ── Hosting needs a login ───────────────────────────────────────────── */
{
  const env = makeEnv();
  check('anonymous cannot host', (await post(create, env, null, { code: 'ABCD' })).status, 401);
  check('a logged-in viewer can host', (await post(create, env, 'viewer', { code: 'ABCD' })).status, 200);
  check('and is recorded as the host', game(env, 'ABCD').host, '202');
  check('a code cannot be reused', (await post(create, env, 'mod', { code: 'ABCD' })).status, 409);
}

/* ── Playing needs a login ───────────────────────────────────────────── */
{
  const env = makeEnv();
  await post(create, env, 'mod', { code: 'BCDE' });

  check('anonymous cannot join', (await post(join, env, null, { code: 'BCDE', name: 'Nobody' })).status, 401);
  const j = await post(join, env, 'player', { code: 'BCDE', name: 'Player' });
  check('a logged-in player can', j.status, 200);
  check('and gets a card', j.data.cardIds.length, 25);
  check('keyed to their account', game(env, 'BCDE').players[0].id, 'u_303');

  /* Rejoining returns the SAME card rather than dealing a new one. */
  const again = await post(join, env, 'player', { code: 'BCDE', name: 'Player' });
  check('rejoining keeps the same card', again.data.cardIds, j.data.cardIds);
  check('and does not duplicate the player', game(env, 'BCDE').players.length, 1);

  /* The name falls back to the session rather than being required. */
  const noName = await post(join, env, 'viewer', { code: 'BCDE' });
  check('a missing name falls back to the display name', noName.status, 200);
  check('using the session', game(env, 'BCDE').players[1].name, 'Viewer');
}

/* ── Only the host drives the game ───────────────────────────────────── */
{
  const env = makeEnv();
  await post(create, env, 'mod', { code: 'CDEF' });
  await post(join, env, 'player', { code: 'CDEF', name: 'Player' });

  check('a player cannot call events', (await post(call, env, 'player', { code: 'CDEF', eventId: 5 })).status, 403);
  check('nor can a stranger', (await post(call, env, 'viewer', { code: 'CDEF', eventId: 5 })).status, 403);
  check('nor anonymous', (await post(call, env, null, { code: 'CDEF', eventId: 5 })).status, 403);
  check('the host can', (await post(call, env, 'mod', { code: 'CDEF', eventId: 5 })).status, 200);
  check('and it is recorded', game(env, 'CDEF').calledEvents, [5]);

  check('a player cannot un-call', (await post(call, env, 'player', { code: 'CDEF', eventId: 5, action: 'uncall' })).status, 403);
  check('a player cannot end the game', (await post(end, env, 'player', { code: 'CDEF' })).status, 403);
  check('the host can end it', (await post(end, env, 'mod', { code: 'CDEF' })).status, 200);
  check('and it is ended', game(env, 'CDEF').status, 'ended');
}

/* ── Awarding needs moderator AND host ───────────────────────────────── */
{
  const env = makeEnv({ moderators: ['101', '111'] });

  /* Hosted by a plain viewer, who is NOT a moderator. */
  await post(create, env, 'viewer', { code: 'DEFG' });
  await post(join, env, 'player', { code: 'DEFG', name: 'Player' });

  const asHost = await post(award, env, 'viewer', { code: 'DEFG', playerId: 'u_303', rarity: 'mythic' });
  /* THE POINT. Being the host is not enough, or anyone could mint 50
     entries by opening a game and awarding themselves. */
  check('a non-moderator host cannot award', asHost.status, 403);

  const asOtherMod = await post(award, env, 'mod', { code: 'DEFG', playerId: 'u_303', rarity: 'common' });
  /* And being a moderator is not enough either — this is not their game. */
  check('a moderator who is not the host cannot award', asOtherMod.status, 403);
  check('and is told why', asOtherMod.data.error, 'That is not your game.');
}

{
  const env = makeEnv({ moderators: ['101', '111'] });
  await post(create, env, 'mod', { code: 'EFGH' });            // host IS a moderator
  await post(join, env, 'player', { code: 'EFGH', name: 'Player' });

  check('an unknown rarity is refused',
    (await post(award, env, 'mod', { code: 'EFGH', playerId: 'u_303', rarity: 'legendary' })).status, 400);
  check('a missing player is refused',
    (await post(award, env, 'mod', { code: 'EFGH', playerId: 'u_999', rarity: 'rare' })).status, 404);

  const r = await post(award, env, 'mod', { code: 'EFGH', playerId: 'u_303', rarity: 'rare' });
  check('the host-moderator can award', r.status, 200);
  check('rare is worth 15 entries', r.data.entries, 15);
  check('and the entries are credited', r.data.total, 15);

  ok('a ledger row was written for the player',
    [...env._store.keys()].some(k => k.includes('303')));

  /* One prize per player per game. */
  const twice = await post(award, env, 'mod', { code: 'EFGH', playerId: 'u_303', rarity: 'mythic' });
  check('the same player cannot be awarded twice', twice.status, 409);
  check('and the first prize stands', game(env, 'EFGH').prizes.length, 1);
  check('at the rarity actually given', game(env, 'EFGH').prizes[0].rarity, 'rare');
}

{
  /* A double click, or two moderators at once, must pay once. */
  const env = makeEnv({ moderators: ['101'] });
  await post(create, env, 'mod', { code: 'FGHI' });
  await post(join, env, 'player', { code: 'FGHI', name: 'Player' });

  const results = await Promise.all(Array.from({ length: 6 }, () =>
    post(award, env, 'mod', { code: 'FGHI', playerId: 'u_303', rarity: 'mythic' })));

  check('exactly one award succeeds', results.filter(r => r.status === 200).length, 1);
  check('the rest are refused', results.filter(r => r.status === 409).length, 5);
  check('and only one prize is recorded', game(env, 'FGHI').prizes.length, 1);
}

{
  /* Every rarity the host can pick, at the same values the chat drops use. */
  const env = makeEnv({ moderators: ['101'] });
  const expected = { common: 2, uncommon: 5, rare: 15, mythic: 50 };
  for (const [rarity, entries] of Object.entries(expected)) {
    const code = 'R' + rarity.slice(0, 3).toUpperCase();
    await post(create, env, 'mod', { code });
    await post(join, env, 'player', { code, name: 'Player' });
    const r = await post(award, env, 'mod', { code, playerId: 'u_303', rarity });
    check(`${rarity} awards ${entries} entries`, r.data.entries, entries);
  }
}

{
  /* A guest record from before login was required has no account to pay. */
  const env = makeEnv({ moderators: ['101'] });
  await post(create, env, 'mod', { code: 'GHIJ' });
  const g = game(env, 'GHIJ');
  g.players.push({ id: 'g_old123', name: 'LegacyGuest', cardIds: new Array(25).fill(1) });
  env._store.set('bingo_GHIJ', JSON.stringify(g));

  const r = await post(award, env, 'mod', { code: 'GHIJ', playerId: 'g_old123', rarity: 'common' });
  check('a guest cannot be credited', r.status, 400);
  ok('and is told plainly why', /guest/i.test(r.data.error));
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[bingo] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[bingo] ${passed} assertions passed.`);
console.log('');
