#!/usr/bin/env node
/* ══════════════════════════════════════════════
   MTGBBB ROOM LIFECYCLE — test suite

     node server/scripts/test-mtgbbb-rooms.js

   RUNS OFFLINE. create.js calls loadSetData(), which is a cache hit against
   a pre-seeded mtgbbb_set_ row here — never a real Scryfall request — using
   the exact key and shape functions/api/mtgbbb-scryfall.js produces, so a
   change to that shape breaks this suite instead of breaking create.js
   silently in production.

   THE AUTHORIZATION MODEL IS THE POINT, same as test-bingo.js, but MTGBBB's
   is deliberately NOT bingo's. Bingo locks marking and ending to the exact
   host, which is a problem the moment that mod's stream crashes mid-box and
   someone else needs to keep marking. MTGBBB locks "run a room" — create,
   mark, end — to moderator-or-broadcaster generally, and reserves the
   host-specific lock for the one action where it actually matters: award,
   which mints real giveaway entries.
   ══════════════════════════════════════════════ */

import * as create from '../../functions/api/mtgbbb/create.js';
import * as join from '../../functions/api/mtgbbb/join.js';
import * as mark from '../../functions/api/mtgbbb/mark.js';
import * as state from '../../functions/api/mtgbbb/state.js';
import * as end from '../../functions/api/mtgbbb/end.js';
import * as award from '../../functions/api/mtgbbb/award.js';
import { setCacheKey, DATA_VERSION } from '../../functions/api/mtgbbb-scryfall.js';
import { SQUARES } from '../../functions/api/mtgbbb-scoring.js';

/* Nothing in this suite may reach Scryfall — every set code it uses is
   either pre-seeded into the fake KV or expected to fail validation before
   loadSetData() is ever called. A stubbed fetch enforces that: a real
   network call here would mean a code path escaped the cache and this
   suite would be exactly the "hammers a free service on every commit"
   problem test-mtgbbb-sets.js was written to avoid. */
globalThis.fetch = async () => {
  throw new Error('test-mtgbbb-rooms: unexpected network call — a set code escaped the KV cache');
};

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

/* ── A fake, fully-formed set: 30 names (5 over the minimum, so a card can
   still be dealt after a couple are excluded by a test), two ordinary
   treatments and one collector-only one. ── */
const FAKE_SET_CODE = 'tst';
function fakeCards(n) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    out.push({ name: `Test Card ${i}`, rarity: i <= 20 ? 'rare' : 'mythic', url: '', image: `img${i}.jpg`, art: '' });
  }
  return out;
}
const FAKE_SET_DATA = {
  version: DATA_VERSION,
  code: FAKE_SET_CODE,
  name: 'Test Set',
  releasedAt: '2026-01-01',
  setType: 'expansion',
  icon: '',
  cards: fakeCards(30),
  treatments: [
    { id: 'foil', label: 'Foil', prints: 30, collectorOnly: false },
    { id: 'showcase', label: 'Showcase', prints: 10, collectorOnly: false },
    { id: 'raisedfoil', label: 'Raised Foil', prints: 2, collectorOnly: true },
  ],
  counts: { rare: 20, mythic: 10, total: 30, prints: 60 },
  playable: true,
};

function makeEnv({ moderators = [], failWrites = null } = {}) {
  const store = new Map();
  const chains = new Map();
  /* `failWrites` is a predicate over the key. Awarding writes the room and
     then the entry ledger, and the whole point of the rollback path is what
     happens when the second write fails while the first has landed — which
     cannot be provoked without being able to break one key and not the
     other. */
  store.set('site_moderators', JSON.stringify({
    entries: moderators.map(id => ({ userId: String(id), name: 'Mod', addedBy: 'test' })),
  }));
  store.set(setCacheKey(FAKE_SET_CODE), JSON.stringify(FAKE_SET_DATA));
  return {
    TWITCH_BROADCASTER_ID: '900',
    MARKETPLACE: {
      async get(k, t) { if (!store.has(k)) return null; const r = store.get(k); return t === 'json' ? JSON.parse(r) : r; },
      async put(k, v) { store.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
      async delete(k) { store.delete(k); },
      async mutate(k, fn) {
        const prev = chains.get(k) || Promise.resolve();
        const run = prev.then(async () => {
          if (failWrites && failWrites(k)) throw new Error(`store unavailable: ${k}`);
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

async function post(mod_, env, who, body, url = 'https://t.local/api/mtgbbb/x') {
  const headers = { 'Content-Type': 'application/json' };
  if (who) headers.Cookie = cookie(who);
  const res = await mod_.onRequestPost({
    env, request: new Request(url, { method: 'POST', headers, body: JSON.stringify(body) }),
  });
  return { status: res.status, data: await res.json() };
}

async function get(mod_, env, who, query, url = 'https://t.local/api/mtgbbb/state') {
  const headers = {};
  if (who) headers.Cookie = cookie(who);
  const full = `${url}?${new URLSearchParams(query)}`;
  const res = await mod_.onRequestGet({ env, request: new Request(full, { headers }) });
  return { status: res.status, data: await res.json() };
}

const room = (env, code) => JSON.parse(env._store.get('mtgbbb_' + code));
const createBody = (code, extra = {}) => ({ code, setCode: FAKE_SET_CODE, boxes: 1, ...extra });

/* ── Opening a room needs moderator or broadcaster, not just a login ────── */
{
  const env = makeEnv({ moderators: ['101'] });
  check('anonymous cannot open a room', (await post(create, env, null, createBody('ABCD'))).status, 401);
  check('a plain viewer cannot', (await post(create, env, 'viewer', createBody('ABCD'))).status, 403);
  const r = await post(create, env, 'mod', createBody('ABCD'));
  check('a moderator can', r.status, 200);
  check('and is recorded as the host', room(env, 'ABCD').host, '101');
  check('the broadcaster can too', (await post(create, env, 'broadcaster', createBody('ABCE'))).status, 200);
  check('a code cannot be reused', (await post(create, env, 'mod', createBody('ABCD'))).status, 409);
}

/* ── Room creation validates its inputs ──────────────────────────────── */
{
  const env = makeEnv({ moderators: ['101'] });
  check('a malformed set code is refused before it can reach Scryfall',
    (await post(create, env, 'mod', createBody('BADS', { setCode: 'not-a-set-code!' }))).status, 400);
  check('zero boxes is refused', (await post(create, env, 'mod', createBody('BOX0', { boxes: 0 }))).status, 400);
  check('a non-integer box count is refused',
    (await post(create, env, 'mod', createBody('BOXX', { boxes: 2.5 }))).status, 400);
  check('too many boxes is refused', (await post(create, env, 'mod', createBody('BOXM', { boxes: 99 }))).status, 400);
  check('Collector Booster is refused',
    (await post(create, env, 'mod', createBody('COLL', { product: 'collector' }))).status, 400);
  check('an unknown treatment id is refused',
    (await post(create, env, 'mod', createBody('TRTX', { treatments: ['nope'] }))).status, 400);

  const r = await post(create, env, 'mod', createBody('OKAY', { boxes: 3 }));
  check('a valid room reports its pack count', r.data.packCount, 90);
  check('collector-only treatments are off by default',
    room(env, 'OKAY').treatments.some(t => t.id === 'raisedfoil'), false);
  check('ordinary treatments are on by default',
    room(env, 'OKAY').treatments.map(t => t.id).sort(), ['foil', 'showcase']);
  check('the pool is frozen into the room', room(env, 'OKAY').pool.length, 30);

  const r2 = await post(create, env, 'mod', createBody('OPTIN', { treatments: ['raisedfoil'] }));
  check('an explicit treatment list is honoured, collector-only included',
    r2.data.treatments.map(t => t.id), ['raisedfoil']);
}

/* ── Joining needs a login ───────────────────────────────────────────── */
{
  const env = makeEnv({ moderators: ['101'] });
  await post(create, env, 'mod', createBody('JOIN'));

  check('anonymous cannot join', (await post(join, env, null, { code: 'JOIN' })).status, 401);
  const j = await post(join, env, 'player', { code: 'JOIN', name: 'Player' });
  check('a logged-in player can', j.status, 200);
  check('and gets a full card', j.data.card.length, SQUARES);
  check('drawn from the room pool', j.data.card.every(n => n.startsWith('Test Card')), true);
  check('keyed to their account', room(env, 'JOIN').players[0].id, 'u_303');

  const again = await post(join, env, 'player', { code: 'JOIN', name: 'Player' });
  check('rejoining returns the SAME card', again.data.card, j.data.card);
  check('and does not duplicate the player', room(env, 'JOIN').players.length, 1);

  const other = await post(join, env, 'viewer', { code: 'JOIN' });
  check('a different account gets a different card', other.data.card === j.data.card, false);

  check('cannot join a game that does not exist',
    (await post(join, env, 'player', { code: 'NOPE' })).status, 404);
}

/* ── Marking is moderator-or-broadcaster, not host-locked ───────────────── */
{
  const env = makeEnv({ moderators: ['101', '111'] });
  await post(create, env, 'mod', createBody('MARK'));
  await post(join, env, 'player', { code: 'MARK', name: 'Player' });
  const myCard = room(env, 'MARK').players[0].card;

  check('a player cannot mark', (await post(mark, env, 'player', { code: 'MARK', card: myCard[0] })).status, 403);
  check('nor a stranger', (await post(mark, env, 'viewer', { code: 'MARK', card: myCard[0] })).status, 403);

  const m1 = await post(mark, env, 'mod2', { code: 'MARK', card: myCard[0], treatments: ['foil'] });
  check('a DIFFERENT moderator than the host can mark — this is the corrected model', m1.status, 200);
  check('and it is recorded', room(env, 'MARK').pulls.length, 1);
  check('with the treatment', room(env, 'MARK').pulls[0].treatments, ['foil']);

  check('a card not in the set is refused',
    (await post(mark, env, 'mod', { code: 'MARK', card: 'Not A Real Card' })).status, 400);
  check('an unknown treatment id is refused',
    (await post(mark, env, 'mod', { code: 'MARK', card: myCard[1], treatments: ['madeup'] })).status, 400);

  /* Duplicate treatments in one request collapse rather than double-count —
     scoreCard also dedupes per pull, so this proves mark.js does not stash
     a value that scoring later has to clean up. */
  const dup = await post(mark, env, 'mod', { code: 'MARK', card: myCard[1], treatments: ['foil', 'foil'] });
  check('duplicate treatments in one pull collapse to one', dup.data.pull.treatments, ['foil']);

  const pullId = room(env, 'MARK').pulls[0].id;
  const undo = await post(mark, env, 'mod', { code: 'MARK', action: 'undo', pullId });
  check('undo removes it', undo.status, 200);
  check('and it is gone', room(env, 'MARK').pulls.find(p => p.id === pullId), undefined);
  check('undoing an already-gone pull is refused',
    (await post(mark, env, 'mod', { code: 'MARK', action: 'undo', pullId })).status, 404);

  check('the pack counter starts at zero', room(env, 'MARK').packsOpened, 0);
  await post(mark, env, 'mod', { code: 'MARK', action: 'pack' });
  await post(mark, env, 'mod', { code: 'MARK', action: 'pack' });
  await post(mark, env, 'mod', { code: 'MARK', action: 'pack', delta: -1 });
  check('the pack counter moves independently of pulls', room(env, 'MARK').packsOpened, 1);
  await post(mark, env, 'mod', { code: 'MARK', action: 'pack', delta: -1 });
  await post(mark, env, 'mod', { code: 'MARK', action: 'pack', delta: -1 });
  check('and never goes below zero', room(env, 'MARK').packsOpened, 0);
}

/* ── Scoring comes back live off state.js, not off stored points ────────── */
{
  const env = makeEnv({ moderators: ['101'] });
  await post(create, env, 'mod', createBody('SCOR'));
  await post(join, env, 'player', { code: 'SCOR', name: 'Player' });
  const myCard = room(env, 'SCOR').players[0].card;

  await post(mark, env, 'mod', { code: 'SCOR', card: myCard[0], treatments: ['foil', 'showcase'] });
  await post(mark, env, 'mod', { code: 'SCOR', card: myCard[0] }); // same card again: mark once, no new treatments

  const s = await get(state, env, 'player', { code: 'SCOR' });
  check('state is reachable without a login too',
    (await get(state, env, null, { code: 'SCOR' })).status, 200);
  check('the caller sees their own card', s.data.you.card.length, SQUARES);
  check('with the pulled square marked', s.data.you.card[0].marked, true);
  check('one mark point', s.data.you.breakdown.marks, 1);
  check('two treatment points from the first pull, none from the repeat', s.data.you.breakdown.treatments, 2);
  check('total points match', s.data.you.points, 3);
  check('standings include the player', s.data.standings.some(p => p.id === 'u_303' && p.points === 3), true);
  check('the pool comes back for the moderator search — it is not private', s.data.pool.length, 30);

  /* A stranger polling the same room sees the board but not the card. */
  const strangerView = await get(state, env, 'viewer', { code: 'SCOR' });
  check('a non-player sees no "you"', strangerView.data.you, undefined);
  check('but does see standings', strangerView.data.standings.length, 1);
}

/* ── Ending is moderator-or-broadcaster, not host-locked ─────────────────── */
{
  const env = makeEnv({ moderators: ['101', '111'] });
  await post(create, env, 'mod', createBody('ENDX'));
  await post(join, env, 'player', { code: 'ENDX', name: 'Player' });

  check('a player cannot end it', (await post(end, env, 'player', { code: 'ENDX' })).status, 403);
  const e = await post(end, env, 'mod2', { code: 'ENDX' });
  check('a different moderator than the host can', e.status, 200);
  check('and it is ended', room(env, 'ENDX').status, 'ended');

  check('marking after the game ends is refused',
    (await post(mark, env, 'mod', { code: 'ENDX', card: room(env, 'ENDX').pool[0].name })).status, 400);
  check('joining after the game ends is refused',
    (await post(join, env, 'viewer', { code: 'ENDX' })).status, 400);
}

/* ── Awarding needs moderator AND host, exactly like bingo ───────────────── */
{
  const env = makeEnv({ moderators: ['101', '111'] });
  await post(create, env, 'mod', createBody('AWD1'));
  await post(join, env, 'player', { code: 'AWD1', name: 'Player' });

  const asOtherMod = await post(award, env, 'mod2', { code: 'AWD1', playerId: 'u_303', rarity: 'common' });
  check('a moderator who is not the host cannot award', asOtherMod.status, 403);
  check('and is told why', asOtherMod.data.error, 'That is not your game.');

  const r = await post(award, env, 'mod', { code: 'AWD1', playerId: 'u_303', rarity: 'rare' });
  check('the host-moderator can award', r.status, 200);
  check('rare is worth 15 entries', r.data.entries, 15);
  check('and the entries are credited', r.data.total, 15);

  const twice = await post(award, env, 'mod', { code: 'AWD1', playerId: 'u_303', rarity: 'mythic' });
  check('the same player cannot be awarded twice', twice.status, 409);
  check('and the first prize stands', room(env, 'AWD1').prizes.length, 1);
}

{
  /* A double click, or two moderators at once, must pay once. */
  const env = makeEnv({ moderators: ['101'] });
  await post(create, env, 'mod', createBody('AWD2'));
  await post(join, env, 'player', { code: 'AWD2', name: 'Player' });

  const results = await Promise.all(Array.from({ length: 6 }, () =>
    post(award, env, 'mod', { code: 'AWD2', playerId: 'u_303', rarity: 'mythic' })));

  check('exactly one award succeeds', results.filter(r => r.status === 200).length, 1);
  check('the rest are refused', results.filter(r => r.status === 409).length, 5);
  check('and only one prize is recorded', room(env, 'AWD2').prizes.length, 1);
}

/* ── A failed entry credit leaves nothing behind ───────────────────────

   Awarding writes the room, then the entry ledger. If the second write
   fails the player used to be left marked as awarded with no entries, and
   the duplicate guard then refused every retry — unfixable from the panel,
   at the loudest moment in the game. */
{
  const env = makeEnv({ moderators: ['101'], failWrites: (k) => k.startsWith('gwe_') });
  await post(create, env, 'mod', createBody('FAIL'));
  await post(join, env, 'player', { code: 'FAIL', name: 'Gus' });

  const r = await post(award, env, 'mod', { code: 'FAIL', playerId: 'u_303', rarity: 'rare' });

  check('a credit failure is a 503, not a silent success', r.status, 503);
  check('and does not claim the prize was awarded', r.data.awarded, false);
  ok('and says to try again', /try again/i.test(r.data.error || ''));

  /* THE ACTUAL BUG: this used to be 1, and the guard then refused forever. */
  check('no prize is left on the room', room(env, 'FAIL').prizes.length, 0);

  /* And so the retry works. Same store, entries now writable again. */
  const env2 = makeEnv({ moderators: ['101'] });
  await post(create, env2, 'mod', createBody('FAIL2'));
  await post(join, env2, 'player', { code: 'FAIL2', name: 'Gus' });
  let broken = true;
  const envFlaky = { ...env2, MARKETPLACE: {
    ...env2.MARKETPLACE,
    async mutate(k, fn, o) {
      if (broken && k.startsWith('gwe_')) throw new Error('store unavailable');
      return env2.MARKETPLACE.mutate(k, fn, o);
    },
  } };

  const first = await post(award, envFlaky, 'mod', { code: 'FAIL2', playerId: 'u_303', rarity: 'rare' });
  check('the first attempt fails', first.status, 503);
  broken = false;
  const second = await post(award, envFlaky, 'mod', { code: 'FAIL2', playerId: 'u_303', rarity: 'rare' });
  check('and awarding again then succeeds', second.status, 200);
  check('crediting the entries once', second.data.total > 0, true);
  check('with exactly one prize recorded', room(env2, 'FAIL2').prizes.length, 1);
}

/* ── A successful award records what it paid ──────────────────────── */
{
  const env = makeEnv({ moderators: ['101'] });
  await post(create, env, 'mod', createBody('PAID'));
  await post(join, env, 'player', { code: 'PAID', name: 'Gus' });

  const r = await post(award, env, 'mod', { code: 'PAID', playerId: 'u_303', rarity: 'mythic' });
  check('the award succeeds', r.status, 200);
  ok('and credits entries', r.data.total > 0);

  const prize = room(env, 'PAID').prizes[0];
  check('the prize names the player', prize.name, 'Gus');
  check('at the rarity the host chose', prize.rarity, 'mythic');
  /* Entries come from TIER_INFO server-side, never from the request body —
     the shape of the Phamily Time claim bug. */
  ok('with an entry count the request never supplied', prize.entries > 0);
}

/* ── Concurrent joins do not lose a player ───────────────────────────────── */
{
  const env = makeEnv({ moderators: ['101'] });
  await post(create, env, 'mod', createBody('RACE'));

  const who = ['mod', 'mod2', 'viewer', 'player'];
  await Promise.all(who.map(w => post(join, env, w, { code: 'RACE', name: w })));
  check('every concurrent joiner is recorded', room(env, 'RACE').players.length, who.length);
  ok('each with a full card', room(env, 'RACE').players.every(p => p.card.length === SQUARES));
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[mtgbbb-rooms] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[mtgbbb-rooms] ${passed} assertions passed.`);
console.log('');
