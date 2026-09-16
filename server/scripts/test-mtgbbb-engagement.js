#!/usr/bin/env node
/* ══════════════════════════════════════════════
   MTGBBB ENGAGEMENT — test suite for steps 6-7

     node server/scripts/test-mtgbbb-engagement.js

   Covers what mark.js does BEYOND recording a pull (overlay events,
   call-your-shot resolution), the mtgbbb_current pointer create.js and
   end.js maintain for the overlay, and end.js's write into lb_mtgbbb — the
   site's ordinary monthly-reset leaderboard, ridden rather than duplicated.
   See end.js's header for why that is not a `lb_mtgbbb_<YYYY-MM>` family,
   which is what this feature's own plan document guessed before this file
   existed.

   RUNS OFFLINE. pushOverlayEvent() and pullGiveawayCode() both do real I/O
   in production; here they land on the same fake KV store everything else
   in this suite uses, via a generic mutate() plus a minimal
   pullGiveawayCode() the store did not have to know about before this file.
   ══════════════════════════════════════════════ */

import * as create from '../../functions/api/mtgbbb/create.js';
import * as join from '../../functions/api/mtgbbb/join.js';
import * as mark from '../../functions/api/mtgbbb/mark.js';
import * as end from '../../functions/api/mtgbbb/end.js';
import * as shot from '../../functions/api/mtgbbb/shot.js';
import * as state from '../../functions/api/mtgbbb/state.js';
import { setCacheKey, DATA_VERSION } from '../../functions/api/mtgbbb-scryfall.js';

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

globalThis.fetch = async () => {
  throw new Error('test-mtgbbb-engagement: unexpected network call');
};

const FAKE_SET_CODE = 'tst';
function fakeCards(n) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    out.push({ name: `Test Card ${i}`, rarity: i <= 20 ? 'rare' : 'mythic', url: '', image: `img${i}.jpg`, art: `art${i}.jpg` });
  }
  return out;
}
const FAKE_SET_DATA = {
  version: DATA_VERSION, code: FAKE_SET_CODE, name: 'Test Set', releasedAt: '2026-01-01',
  setType: 'expansion', icon: '',
  cards: fakeCards(30),
  treatments: [
    { id: 'foil', label: 'Foil', prints: 30, collectorOnly: false },
    { id: 'showcase', label: 'Showcase', prints: 10, collectorOnly: false },
  ],
  counts: { rare: 20, mythic: 10, total: 30, prints: 60 },
  playable: true,
};
/* Mythics are cards 21-30 (rarity 'mythic' when i > 20). */
const MYTHIC = 'Test Card 21';

function makeEnv({ moderators = [] } = {}) {
  const store = new Map();
  const chains = new Map();
  store.set('site_moderators', JSON.stringify({
    entries: moderators.map(id => ({ userId: String(id), name: 'Mod', addedBy: 'test' })),
  }));
  store.set(setCacheKey(FAKE_SET_CODE), JSON.stringify(FAKE_SET_DATA));
  let codeCounter = 0;
  return {
    TWITCH_BROADCASTER_ID: '900',
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
      /* Deterministic, distinct per call — enough to prove a code landed
         on the right shot without needing a real pool. */
      async pullGiveawayCode(tier) { return `CODE-${tier.toUpperCase()}-${++codeCounter}`; },
    },
    _store: store,
  };
}

const USERS = {
  mod: { user_id: '101', display_name: 'Mod', role: 'visitor' },
  mod2: { user_id: '111', display_name: 'OtherMod', role: 'visitor' },
  player: { user_id: '303', display_name: 'Player', role: 'follower' },
  player2: { user_id: '404', display_name: 'Player Two', role: 'follower' },
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
  const res = await mod_.onRequestGet({ env, request: new Request(`${url}?${new URLSearchParams(query)}`, { headers }) });
  return { status: res.status, data: await res.json() };
}

const room = (env, code) => JSON.parse(env._store.get('mtgbbb_' + code));
const overlayEvents = (env) => {
  const raw = env._store.get('overlay_events');
  return raw ? JSON.parse(raw).events : [];
};
const createBody = (code, extra = {}) => ({ code, setCode: FAKE_SET_CODE, boxes: 1, ...extra });

/* ── mtgbbb_current: set on create, resolved by state.js, cleared on end ── */
{
  const env = makeEnv({ moderators: ['101'] });
  check('no live game yet', (await get(state, env, null, { current: 1 })).status, 404);

  await post(create, env, 'mod', createBody('CURA'));
  const cur = await get(state, env, null, { current: 1 });
  check('current resolves the just-created room', cur.status, 200);
  check('to the right code', cur.data.code, 'CURA');

  await post(end, env, 'mod', { code: 'CURA' });
  check('current is cleared once that room ends', (await get(state, env, null, { current: 1 })).status, 404);
}

{
  /* Ending a STALE room must not blank a pointer that has since moved on. */
  const env = makeEnv({ moderators: ['101'] });
  await post(create, env, 'mod', createBody('OLD1'));
  await post(end, env, 'mod', { code: 'OLD1' }); // clears current
  await post(create, env, 'mod', createBody('NEW1')); // current -> NEW1
  await post(end, env, 'mod', { code: 'OLD1' }); // already ended; must be a no-op on current
  check('a repeat end on an old room does not touch a newer current pointer',
    (await get(state, env, null, { current: 1 })).data.code, 'NEW1');
}

/* ── Overlay: the pull event ─────────────────────────────────────────── */
{
  const env = makeEnv({ moderators: ['101'] });
  await post(create, env, 'mod', createBody('OVL1'));
  await post(join, env, 'player', { code: 'OVL1', name: 'Player' });
  await post(join, env, 'player2', { code: 'OVL1', name: 'Player Two' });

  const pool = room(env, 'OVL1').pool;
  const bothHave = pool.find(c =>
    room(env, 'OVL1').players.every(p => p.card.includes(c.name)));
  /* Not guaranteed by a random deal on a 30-card pool with two 25-card
     hands, but likely; fall back to whatever card player 1 holds so the
     "holders" assertion below is just looser, not wrong, if it isn't. */
  const cardName = bothHave ? bothHave.name : room(env, 'OVL1').players[0].card[0];

  await post(mark, env, 'mod', { code: 'OVL1', card: cardName, treatments: ['foil'] });

  const events = overlayEvents(env);
  const pullEvents = events.filter(e => e.type === 'mtgbbb-pull');
  check('exactly one pull event', pullEvents.length, 1);
  check('names the card', pullEvents[0].card, cardName);
  check('treatments come back as labels, not ids', pullEvents[0].treatments, ['Foil']);
  check('players is the room size', pullEvents[0].players, 2);
  ok('holders is at least 1 — the card came from a real card in the room',
    pullEvents[0].holders >= 1);
}

/* ── Overlay: bingo diff, and blackout standing alone ────────────────── */
{
  const env = makeEnv({ moderators: ['101'] });
  await post(create, env, 'mod', createBody('OVL2'));
  await post(join, env, 'player', { code: 'OVL2', name: 'Player' });
  const card = room(env, 'OVL2').players[0].card; // row 0 is card[0..4]

  for (let i = 0; i < 4; i++) {
    await post(mark, env, 'mod', { code: 'OVL2', card: card[i] });
  }
  check('no bingo yet at four of five', overlayEvents(env).filter(e => e.type === 'mtgbbb-bingo').length, 0);

  await post(mark, env, 'mod', { code: 'OVL2', card: card[4] }); // completes row 0
  const bingoEvents = overlayEvents(env).filter(e => e.type === 'mtgbbb-bingo');
  check('exactly one bingo event for completing row 0', bingoEvents.length, 1);
  check('named for the player', bingoEvents[0].who, 'Player');
  check('pattern is the row label', bingoEvents[0].pattern, 'Row 1');

  /* Undo the row, remark it — must fire again, not silently suppress. */
  const pullId = room(env, 'OVL2').pulls.find(p => p.card === card[4]).id;
  await post(mark, env, 'mod', { code: 'OVL2', action: 'undo', pullId });
  await post(mark, env, 'mod', { code: 'OVL2', card: card[4] });
  check('re-marking after undo fires the bingo again — no stale suppression',
    overlayEvents(env).filter(e => e.type === 'mtgbbb-bingo').length, 2);
}

{
  /* Blackout: fill every square in one final mark and see exactly one
     event, not one for blackout plus one for every line it also completes. */
  const env = makeEnv({ moderators: ['101'] });
  await post(create, env, 'mod', createBody('OVL3'));
  await post(join, env, 'player', { code: 'OVL3', name: 'Player' });
  const card = room(env, 'OVL3').players[0].card;

  for (let i = 0; i < 24; i++) {
    await post(mark, env, 'mod', { code: 'OVL3', card: card[i] });
  }
  const beforeLast = overlayEvents(env).filter(e => e.type === 'mtgbbb-bingo').length;
  ok('several lines completed before the last square', beforeLast > 0);

  await post(mark, env, 'mod', { code: 'OVL3', card: card[24] }); // blackout
  const afterLast = overlayEvents(env).filter(e => e.type === 'mtgbbb-bingo');
  check('exactly one new bingo event on the blackout square', afterLast.length - beforeLast, 1);
  check('and it is the Blackout event, not a line', afterLast[afterLast.length - 1].pattern, 'Blackout');
}

/* ── lb_mtgbbb: rides the existing monthly board, not a per-month key ──── */
{
  const env = makeEnv({ moderators: ['101'] });
  await post(create, env, 'mod', createBody('LBX1'));
  await post(join, env, 'player', { code: 'LBX1', name: 'Player' });
  const card = room(env, 'LBX1').players[0].card;
  await post(mark, env, 'mod', { code: 'LBX1', card: card[0] });
  await post(end, env, 'mod', { code: 'LBX1' });

  const lb = JSON.parse(env._store.get('lb_mtgbbb'));
  check('the player is on the board', lb.some(e => e.id === 'u_303' && e.score === 1), true);

  /* A better session later keeps the higher score, not the newer one. */
  await post(create, env, 'mod', createBody('LBX2'));
  await post(join, env, 'player', { code: 'LBX2', name: 'Player' });
  const card2 = room(env, 'LBX2').players[0].card;
  for (let i = 0; i < 5; i++) await post(mark, env, 'mod', { code: 'LBX2', card: card2[i] });
  await post(end, env, 'mod', { code: 'LBX2' });

  const lb2 = JSON.parse(env._store.get('lb_mtgbbb'));
  const row = lb2.find(e => e.id === 'u_303');
  ok('the board kept the better of the two sessions', row.score >= 5);

  check('ending an already-ended room does not double-write the board',
    (await post(end, env, 'mod', { code: 'LBX1' })).status, 200);
  const lb3 = JSON.parse(env._store.get('lb_mtgbbb'));
  check('still exactly one row for the player', lb3.filter(e => e.id === 'u_303').length, 1);
}

/* ── Call your shot: setting one ─────────────────────────────────────── */
{
  const env = makeEnv({ moderators: ['101'] });
  await post(create, env, 'mod', createBody('SHT1')); // callYourShot defaults off
  await post(join, env, 'player', { code: 'SHT1', name: 'Player' });

  check('off by default', (await post(shot, env, 'player', { code: 'SHT1', card: MYTHIC })).status, 400);
}

{
  const env = makeEnv({ moderators: ['101'] });
  await post(create, env, 'mod', createBody('SHT2', { callYourShot: { enabled: true, cap: 1 } }));

  check('must be logged in', (await post(shot, env, null, { code: 'SHT2', card: MYTHIC })).status, 401);
  check('must have joined the room',
    (await post(shot, env, 'player', { code: 'SHT2', card: MYTHIC })).status, 400);

  await post(join, env, 'player', { code: 'SHT2', name: 'Player' });
  check('a non-mythic is refused',
    (await post(shot, env, 'player', { code: 'SHT2', card: 'Test Card 1' })).status, 400);
  check('a card not in the pool is refused',
    (await post(shot, env, 'player', { code: 'SHT2', card: 'Nonexistent' })).status, 400);
  check('a named treatment without foil is refused',
    (await post(shot, env, 'player', { code: 'SHT2', card: MYTHIC, treatmentId: 'showcase' })).status, 400);
  check('foil itself is not a valid "named treatment"',
    (await post(shot, env, 'player', { code: 'SHT2', card: MYTHIC, wantsFoil: true, treatmentId: 'foil' })).status, 400);
  check('an unknown treatment id is refused',
    (await post(shot, env, 'player', { code: 'SHT2', card: MYTHIC, wantsFoil: true, treatmentId: 'nope' })).status, 400);

  const common = await post(shot, env, 'player', { code: 'SHT2', card: MYTHIC });
  check('a bare card is the common tier', common.data.tier, 'common');
  check('one shot per player', (await post(shot, env, 'player', { code: 'SHT2', card: MYTHIC })).status, 409);

  /* Cap is 1, and it is already spent. */
  await post(join, env, 'player2', { code: 'SHT2', name: 'Player Two' });
  check('the cap refuses a second shot from anyone',
    (await post(shot, env, 'player2', { code: 'SHT2', card: 'Test Card 22' })).status, 409);
}

{
  const env = makeEnv({ moderators: ['101'] });
  await post(create, env, 'mod', createBody('SHT3', { callYourShot: { enabled: true } }));
  await post(join, env, 'player', { code: 'SHT3', name: 'Player' });
  await post(mark, env, 'mod', { code: 'SHT3', card: MYTHIC }); // already pulled

  check('a shot on an already-pulled card is refused, forward-only',
    (await post(shot, env, 'player', { code: 'SHT3', card: MYTHIC })).status, 400);
}

/* ── Call your shot: resolution ──────────────────────────────────────── */
{
  const env = makeEnv({ moderators: ['101'] });
  await post(create, env, 'mod', createBody('SHT4', { callYourShot: { enabled: true } }));
  await post(join, env, 'player', { code: 'SHT4', name: 'Player' });

  const s1 = await post(shot, env, 'player', { code: 'SHT4', card: MYTHIC, wantsFoil: true, treatmentId: 'showcase' });
  check('rare tier for card + foil + a named treatment', s1.data.tier, 'rare');

  /* All or nothing: foil alone is not the rare commitment. */
  await post(mark, env, 'mod', { code: 'SHT4', card: MYTHIC, treatments: ['foil'] });
  const s = await get(state, env, 'player', { code: 'SHT4' });
  check('resolved', s.data.you.shot.resolved, true);
  check('but lost — foil without the named treatment is not the rare commitment', s.data.you.shot.won, false);
  check('no code on a loss', s.data.you.shot.code, null);
}

{
  const env = makeEnv({ moderators: ['101'] });
  await post(create, env, 'mod', createBody('SHT5', { callYourShot: { enabled: true } }));
  await post(join, env, 'player', { code: 'SHT5', name: 'Player' });
  await post(shot, env, 'player', { code: 'SHT5', card: MYTHIC, wantsFoil: true, treatmentId: 'showcase' });

  await post(mark, env, 'mod', { code: 'SHT5', card: MYTHIC, treatments: ['foil', 'showcase'] });
  const s = await get(state, env, 'player', { code: 'SHT5' });
  check('exact match wins', s.data.you.shot.won, true);
  ok('and a code was minted for it', typeof s.data.you.shot.code === 'string' && s.data.you.shot.code.startsWith('CODE-RARE-'));
}

{
  const env = makeEnv({ moderators: ['101'] });
  await post(create, env, 'mod', createBody('SHT6', { callYourShot: { enabled: true } }));
  await post(join, env, 'player', { code: 'SHT6', name: 'Player' });
  await post(shot, env, 'player', { code: 'SHT6', card: MYTHIC }); // common: any printing wins

  await post(mark, env, 'mod', { code: 'SHT6', card: MYTHIC }); // plain, no treatments
  const s = await get(state, env, 'player', { code: 'SHT6' });
  check('common tier wins on any printing', s.data.you.shot.won, true);
}

/* ── Heat map and the call-your-shot summary come back from state.js ────── */
{
  const env = makeEnv({ moderators: ['101'] });
  await post(create, env, 'mod', createBody('HEAT', { callYourShot: { enabled: true, cap: 5 } }));
  await post(join, env, 'player', { code: 'HEAT', name: 'Player' });

  const s = await get(state, env, null, { code: 'HEAT' });
  check('heat map has entries', s.data.heatMap.length > 0, true);
  check('call-your-shot summary reports enabled + cap', s.data.callYourShot, { enabled: true, cap: 5, count: 0 });
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[mtgbbb-engagement] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[mtgbbb-engagement] ${passed} assertions passed.`);
console.log('');
