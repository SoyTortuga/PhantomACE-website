#!/usr/bin/env node
/* ══════════════════════════════════════════════
   MTGBBB POWERS — extra cards and wildcard stamps

     node server/scripts/test-mtgbbb-powers.js

   RUNS OFFLINE, same harness as test-mtgbbb-rooms.js: a fake KV, a
   pre-seeded set so create.js never reaches Scryfall, and a stubbed fetch
   that throws if anything tries.

   WHAT THIS IS GUARDING. Both powers are bought with real pass currency and
   both are spend-then-apply, so every failure mode here costs a player an
   item they paid for:

     - The item must come back if the room write fails. Losing the stamp AND
       the effect is the one outcome worse than either alone.
     - A stamp on a square the pulls already marked must be refused BEFORE
       the spend, not after — a stamp that visibly did nothing is the exact
       bug that sent this feature back for a rewrite.
     - An extra card must be dealt deterministically from the room's frozen
       pool. If it could reroll, buying it again after seeing it would be a
       slot machine; if it were dealt from the pool RECORDS rather than the
       names, it would be a card no pull could ever match.
     - An extra card must be another CHANCE, not another score — bestOf()
       takes the best card, never the sum, or a second card would out-score
       a better card by arithmetic.
   ══════════════════════════════════════════════ */

import * as create from '../../functions/api/mtgbbb/create.js';
import * as join from '../../functions/api/mtgbbb/join.js';
import * as mark from '../../functions/api/mtgbbb/mark.js';
import * as powers from '../../functions/api/mtgbbb/powers.js';
import * as state from '../../functions/api/mtgbbb/state.js';
import { setCacheKey, DATA_VERSION } from '../../functions/api/mtgbbb-scryfall.js';
import { SQUARES, bestOf, scoreCard, playerCards, wildsFor } from '../../functions/api/mtgbbb-scoring.js';

globalThis.fetch = async () => {
  throw new Error('test-mtgbbb-powers: unexpected network call');
};

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

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
  cards: fakeCards(40),
  treatments: [
    { id: 'foil', label: 'Foil', prints: 30, collectorOnly: false },
    { id: 'showcase', label: 'Showcase', prints: 10, collectorOnly: false },
  ],
  counts: { rare: 20, mythic: 20, total: 40, prints: 60 },
  playable: true,
};

function makeEnv({ moderators = [], failWrites = null, inventories = {} } = {}) {
  const store = new Map();
  const chains = new Map();
  store.set('site_moderators', JSON.stringify({
    entries: moderators.map(id => ({ userId: String(id), name: 'Mod', addedBy: 'test' })),
  }));
  store.set(setCacheKey(FAKE_SET_CODE), JSON.stringify(FAKE_SET_DATA));
  for (const [userId, items] of Object.entries(inventories)) {
    store.set(`inv_${userId}`, JSON.stringify({ userId, items, equips: {} }));
  }
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
  mod: { user_id: '101', display_name: 'Mod', role: 'visitor' },
  player: { user_id: '303', display_name: 'Player', role: 'follower' },
  other: { user_id: '404', display_name: 'Other', role: 'follower' },
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
const inv = (env, userId) => JSON.parse(env._store.get(`inv_${userId}`) || '{"items":[]}');
const qty = (env, userId, type) => {
  const item = (inv(env, userId).items || []).find(i => i.game === 'commander-bingo' && i.type === type);
  return item ? (item.quantity || 1) : 0;
};
const stamps = (n) => [{ id: 'w1', game: 'commander-bingo', type: 'wildcard', name: 'Wildcard Stamp', consumable: true, quantity: n }];
const bonuses = (n) => [{ id: 'b1', game: 'commander-bingo', type: 'bonus-card', name: 'Extra Bingo Card', consumable: true, quantity: n }];

async function openRoom(env, code) {
  await post(create, env, 'mod', { code, setCode: FAKE_SET_CODE, boxes: 1 });
  await post(join, env, 'player', { code, name: 'Player' }, 'https://t.local/api/mtgbbb/join');
}

/* ── The items are the Commander Bingo pool, not a new namespace ─────────
   Renaming item identity out from under already-granted rewards is a
   mistake this project has paid for once; a stamp earned before MTGBBB
   existed has to spend here. */
{
  const env = makeEnv({ moderators: ['101'], inventories: { 303: stamps(1) } });
  await openRoom(env, 'POOL');
  const r = await post(powers, env, 'player', { action: 'wildcard', code: 'POOL', cardIndex: 0, squareIndex: 0 });
  check('a commander-bingo stamp spends in MTGBBB', r.status, 200);
  check('and is taken from that same pool', qty(env, '303', 'wildcard'), 0);
}

/* ── Authorization ─────────────────────────────────────────────────────── */
{
  const env = makeEnv({ moderators: ['101'], inventories: { 303: stamps(1), 404: stamps(1) } });
  await openRoom(env, 'AUTH');
  check('anonymous cannot spend',
    (await post(powers, env, null, { action: 'wildcard', code: 'AUTH', cardIndex: 0, squareIndex: 0 })).status, 401);
  check('someone who never joined cannot',
    (await post(powers, env, 'other', { action: 'wildcard', code: 'AUTH', cardIndex: 0, squareIndex: 0 })).status, 403);
  ok('and keeps their item', qty(env, '404', 'wildcard') === 1);
  check('a missing room is a 404',
    (await post(powers, env, 'player', { action: 'wildcard', code: 'NOPE', cardIndex: 0, squareIndex: 0 })).status, 404);
  check('an unknown action is refused',
    (await post(powers, env, 'player', { action: 'nonsense', code: 'AUTH' })).status, 400);
  ok('none of which spent the stamp', qty(env, '303', 'wildcard') === 1);
}

/* ── A stamp with nothing to stamp with ────────────────────────────────── */
{
  const env = makeEnv({ moderators: ['101'] });
  await openRoom(env, 'EMPT');
  const r = await post(powers, env, 'player', { action: 'wildcard', code: 'EMPT', cardIndex: 0, squareIndex: 0 });
  check('an empty inventory is refused', r.status, 400);
  check('with a reason a player can act on', r.data.error, 'No wildcard stamp in your inventory.');
  check('and nothing is stamped', room(env, 'EMPT').players[0].wildcards.length, 0);
}

/* ── A STAMP ACTUALLY MARKS THE SQUARE ─────────────────────────────────── */
{
  const env = makeEnv({ moderators: ['101'], inventories: { 303: stamps(3) } });
  await openRoom(env, 'MARK');
  const marked = (v, ci) => v.you.cards[ci].card.filter(sq => sq.marked).length;
  const before = (await get(state, env, 'player', { code: 'MARK' })).data;
  const beforeMarked = marked(before, 0);

  const r = await post(powers, env, 'player', { action: 'wildcard', code: 'MARK', cardIndex: 0, squareIndex: 7 });
  check('stamping an unmarked square succeeds', r.status, 200);
  check('the room records which card and square', room(env, 'MARK').players[0].wildcards, [{ cardIndex: 0, squareIndex: 7 }]);

  const after = (await get(state, env, 'player', { code: 'MARK' })).data;
  ok('the square comes back MARKED in the player view', after.you.cards[0].card[7].marked === true);
  /* `wild` is what lets the grid show it as a STAMP rather than a pull — a
     stamp that renders identically to a real mark is unverifiable on stream. */
  ok('and flagged as a stamp, not a pull', after.you.cards[0].card[7].wild === true);
  check('exactly one more square is marked', marked(after, 0), beforeMarked + 1);
  check('and the view reports the stamp was used', after.you.wildcardsUsed, 1);

  /* The stamp has to SURVIVE A REFRESH. It lives in the room, not in the
     browser, so a reload re-polls and finds it still there. */
  const reload = (await get(state, env, 'player', { code: 'MARK' })).data;
  ok('and it is still there on the next poll', reload.you.cards[0].card[7].marked === true);
}

/* ── Stamping an already-marked square is refused BEFORE the spend ──────
   Either already-marked route: one the pulls marked, and one a stamp
   marked. Both must cost nothing. */
{
  const env = makeEnv({ moderators: ['101'], inventories: { 303: stamps(2) } });
  await openRoom(env, 'DUPE');
  const card = room(env, 'DUPE').players[0].card;
  await post(mark, env, 'mod', { code: 'DUPE', action: 'mark', card: card[3], treatments: [] });

  const pulled = await post(powers, env, 'player', { action: 'wildcard', code: 'DUPE', cardIndex: 0, squareIndex: 3 });
  check('a square the pulls already marked is refused', pulled.status, 400);
  check('without spending the stamp', qty(env, '303', 'wildcard'), 2);

  await post(powers, env, 'player', { action: 'wildcard', code: 'DUPE', cardIndex: 0, squareIndex: 10 });
  const twice = await post(powers, env, 'player', { action: 'wildcard', code: 'DUPE', cardIndex: 0, squareIndex: 10 });
  check('stamping the same square twice is refused', twice.status, 400);
  check('and costs only the first stamp', qty(env, '303', 'wildcard'), 1);
  check('leaving one stamp on the room', room(env, 'DUPE').players[0].wildcards.length, 1);
}

/* ── Out-of-range stamps ───────────────────────────────────────────────── */
{
  const env = makeEnv({ moderators: ['101'], inventories: { 303: stamps(1) } });
  await openRoom(env, 'RANG');
  for (const [label, body] of [
    ['a negative square', { cardIndex: 0, squareIndex: -1 }],
    ['a square past the grid', { cardIndex: 0, squareIndex: SQUARES }],
    ['a non-integer square', { cardIndex: 0, squareIndex: 1.5 }],
    ['a card the player does not hold', { cardIndex: 2, squareIndex: 0 }],
    ['a negative card', { cardIndex: -1, squareIndex: 0 }],
  ]) {
    check(label + ' is refused', (await post(powers, env, 'player', { action: 'wildcard', code: 'RANG', ...body })).status, 400);
  }
  check('and none of them spent the stamp', qty(env, '303', 'wildcard'), 1);
}

/* ── The stamp comes back if the room write fails ──────────────────────── */
{
  const env = makeEnv({ moderators: ['101'], inventories: { 303: stamps(1) } });
  await openRoom(env, 'ROLL');
  env.MARKETPLACE.mutate = (orig => async (k, fn, o) => {
    if (k === 'mtgbbb_ROLL') throw new Error('store unavailable');
    return orig(k, fn, o);
  })(env.MARKETPLACE.mutate.bind(env.MARKETPLACE));

  let status;
  try { status = (await post(powers, env, 'player', { action: 'wildcard', code: 'ROLL', cardIndex: 0, squareIndex: 0 })).status; }
  catch { status = 'threw'; }
  check('a failed stamp does not leave the player down an item', qty(env, '303', 'wildcard'), 1);
  ok('and does not report success', status !== 200);
}

/* ── EXTRA CARDS ───────────────────────────────────────────────────────── */
{
  const env = makeEnv({ moderators: ['101'], inventories: { 303: bonuses(5) } });
  await openRoom(env, 'XTRA');
  check('a player starts on one card', room(env, 'XTRA').players[0].cards.length, 1);

  const first = await post(powers, env, 'player', { action: 'extra-card', code: 'XTRA' });
  check('buying an extra card succeeds', first.status, 200);
  check('the player now holds two', room(env, 'XTRA').players[0].cards.length, 2);
  check('and one bonus card was taken', qty(env, '303', 'bonus-card'), 4);
  check('the dealt card is a full grid', first.data.card.length, SQUARES);

  /* DEALT FROM NAMES, not pool records. A card of objects would never match
     a pull, because mark.js compares names exactly. */
  const pool = new Set(room(env, 'XTRA').pool.map(c => c.name));
  ok('every square is a card name from THIS room\'s pool', first.data.card.every(n => pool.has(n)));

  const second = await post(powers, env, 'player', { action: 'extra-card', code: 'XTRA' });
  check('a third card is allowed', second.status, 200);
  ok('and is a different card from the second', JSON.stringify(second.data.card) !== JSON.stringify(first.data.card));

  const fourth = await post(powers, env, 'player', { action: 'extra-card', code: 'XTRA' });
  check('a fourth is refused at the cap', fourth.status, 400);
  check('and is not charged for', qty(env, '303', 'bonus-card'), 3);
  check('the player is still on three', room(env, 'XTRA').players[0].cards.length, 3);

  const view = (await get(state, env, 'player', { code: 'XTRA' })).data;
  check('the player view returns all three cards', view.you.cards.length, 3);
}

/* ── An extra card is another CHANCE, not another score ─────────────────
   bestOf() takes the best single card. If it summed, a player could buy
   their way up the standings with worse cards. */
{
  const env = makeEnv({ moderators: ['101'], inventories: { 303: bonuses(1) } });
  await openRoom(env, 'BEST');
  await post(powers, env, 'player', { action: 'extra-card', code: 'BEST' });
  const r = room(env, 'BEST');
  const p = r.players[0];

  /* Mark a square from each card, so both score above zero. */
  await post(mark, env, 'mod', { code: 'BEST', action: 'mark', card: p.cards[0][0], treatments: [] });
  await post(mark, env, 'mod', { code: 'BEST', action: 'mark', card: p.cards[1][6], treatments: [] });

  const after = room(env, 'BEST');
  const me = after.players[0];
  const pulls = after.pulls;
  const { cards, wildcards } = playerCards(me);
  const each = cards.map((c, i) => scoreCard(c, pulls, wildsFor(wildcards, i)).points);
  const best = bestOf(me, pulls);
  check('the player is worth their BEST card', best.scored.points, Math.max(...each));
  ok('never the sum of their cards', best.scored.points < each.reduce((a, b) => a + b, 0) || each.filter(Boolean).length < 2);
  check('and the card count rides along for the host', best.cardCount, 2);
}

/* ── The deal is reproducible, never re-rollable ────────────────────────
   Same room code, same player, same card number => same card. A player who
   does not like their extra card cannot buy another to reroll it: the cap
   is by card COUNT, so the same seed comes back. */
{
  const a = makeEnv({ moderators: ['101'], inventories: { 303: bonuses(1) } });
  const b = makeEnv({ moderators: ['101'], inventories: { 303: bonuses(1) } });
  await openRoom(a, 'SEED');
  await openRoom(b, 'SEED');
  const ca = (await post(powers, a, 'player', { action: 'extra-card', code: 'SEED' })).data.card;
  const cb = (await post(powers, b, 'player', { action: 'extra-card', code: 'SEED' })).data.card;
  check('the same seed deals the same extra card', ca, cb);
}

/* ── A stamp lands on the card it names, not the active one ─────────────
   The client sends the card index it is showing; two cards must not share
   one stamp. */
{
  const env = makeEnv({ moderators: ['101'], inventories: { 303: [...stamps(1), ...bonuses(1)] } });
  await openRoom(env, 'CIDX');
  await post(powers, env, 'player', { action: 'extra-card', code: 'CIDX' });
  await post(powers, env, 'player', { action: 'wildcard', code: 'CIDX', cardIndex: 1, squareIndex: 4 });

  const view = (await get(state, env, 'player', { code: 'CIDX' })).data;
  ok('the named card carries the stamp', view.you.cards[1].card[4].wild === true);
  ok('and the other card does not', view.you.cards[0].card[4].wild === false);
}

/* ── A stamp counts toward a real bingo ────────────────────────────────
   The whole point of the item. Four pulls down a row plus a stamp on the
   fifth has to score the line, through the same bestOf() the standings and
   the host panel read. */
{
  const env = makeEnv({ moderators: ['101'], inventories: { 303: stamps(1) } });
  await openRoom(env, 'LINE');
  const card = room(env, 'LINE').players[0].card;
  for (const i of [0, 1, 2, 3]) {
    await post(mark, env, 'mod', { code: 'LINE', action: 'mark', card: card[i], treatments: [] });
  }
  const pre = bestOf(room(env, 'LINE').players[0], room(env, 'LINE').pulls);
  check('four of a row is not yet a line', pre.scored.lines.length, 0);

  await post(powers, env, 'player', { action: 'wildcard', code: 'LINE', cardIndex: 0, squareIndex: 4 });
  const post_ = bestOf(room(env, 'LINE').players[0], room(env, 'LINE').pulls);
  ok('the stamp completes the row', post_.scored.lines.length > 0);
  ok('and the player scores more for it', post_.scored.points > pre.scored.points);
  check('with the stamp counted for the host to see', post_.wildcardsUsed, 1);
}

/* ── Powers are closed once the box is done ────────────────────────────── */
{
  const env = makeEnv({ moderators: ['101'], inventories: { 303: [...stamps(1), ...bonuses(1)] } });
  await openRoom(env, 'OVER');
  await env.MARKETPLACE.mutate('mtgbbb_OVER', (r) => { r.status = 'ended'; return r; });
  check('no stamping an ended game',
    (await post(powers, env, 'player', { action: 'wildcard', code: 'OVER', cardIndex: 0, squareIndex: 0 })).status, 400);
  check('no extra cards either',
    (await post(powers, env, 'player', { action: 'extra-card', code: 'OVER' })).status, 400);
  check('and nothing was spent', qty(env, '303', 'wildcard') + qty(env, '303', 'bonus-card'), 2);
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[mtgbbb-powers] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[mtgbbb-powers] ${passed} assertions passed.`);
console.log('');
