#!/usr/bin/env node
/* ══════════════════════════════════════════════
   BINGO POWERS — extra cards and wildcard stamps, in both bingos

     node server/scripts/test-bingo-powers.js

   THE TWO BUGS FROM STREAM, restated as invariants:

     1. An extra card is an ADDITION the server remembers. The shipped
        version rerolled the page's only card locally: the original was
        destroyed on the spot, the server still held it, and a refresh
        resurrected it — the item bought a card that never existed
        anywhere but the tab that paid for it.

     2. A wildcard stamp must SURVIVE and COST EXACTLY ONE ITEM. The
        shipped version marked locally and told the generic inventory
        route an item was used; the poll's sweep then deleted the mark
        within three seconds. Spent, nothing gained.

   So the assertions here follow the money as much as the marks: every
   refusal must leave the inventory untouched, every success must take
   exactly one item, and everything a player paid for must come back on a
   rejoin, because a refresh is not supposed to be a refund-free reset.

   Both games run the same shape through their own grammar: Commander
   Bingo stamps EVENT IDS, MTGBBB stamps SQUARE INDICES, and MTGBBB's
   extra card must be deterministic — a card you can reroll by re-buying
   after a bad deal is a slot machine.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as bingoPowers from '../../functions/api/bingo/powers.js';
import * as bingoJoin from '../../functions/api/bingo/join.js';
import * as bingoState from '../../functions/api/bingo/state.js';
import * as mtgPowers from '../../functions/api/mtgbbb/powers.js';
import { buildCard, scoreCard, bestOf, standings } from '../../functions/api/mtgbbb-scoring.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

function fakeKV(seed = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    store,
    read(k) { return store.has(k) ? JSON.parse(store.get(k)) : null; },
    async get(k, t) { const v = store.get(k); return v === undefined ? null : (t === 'json' ? JSON.parse(v) : v); },
    async put(k, v) { store.set(k, String(v)); },
    async delete(k) { store.delete(k); },
    async list() { return { keys: [] }; },
    async mutate(k, fn) {
      const cur = store.has(k) ? JSON.parse(store.get(k)) : null;
      const out = await fn(cur);
      if (out === undefined) return;
      store.set(k, JSON.stringify(out));
    },
  };
}
const as = (id) => ({ Cookie: 'pham_session=' + encodeURIComponent(JSON.stringify({ user_id: id, display_name: 'P' + id })) });
const POST = (mod, env, body, h) => mod.onRequestPost({ env, request: new Request('https://x/api', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(body) }) });
const GETst = (env, code, h) => bingoState.onRequestGet({ env, request: new Request('https://x/api/bingo/state?code=' + code, { headers: h }) });

const wcItem = (q) => ({ id: 'wc1', game: 'commander-bingo', type: 'wildcard', name: 'Wildcard Stamp', consumable: true, quantity: q });
const bcItem = (q) => ({ id: 'bc1', game: 'commander-bingo', type: 'bonus-card', name: 'Extra Card', consumable: true, quantity: q });
const invOf = (env, uid) => env.MARKETPLACE.read('inv_' + uid) || { items: [] };
const countOf = (env, uid, type) => invOf(env, uid).items
  .filter(i => i.type === type).reduce((s, i) => s + (i.quantity || 1), 0);

/* ══ COMMANDER BINGO ═══════════════════════════════════════════════════ */

function bingoRoom(over = {}) {
  return {
    code: 'AAAA', status: 'active', calledEvents: [5, 9],
    players: [{ id: 'u_1', name: 'P1', cardIds: [0 /* free */, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24].slice(0, 25) }],
    ...over,
  };
}

{
  /* Extra card: appended server-side, original untouched, one item spent. */
  const env = { MARKETPLACE: fakeKV({ bingo_AAAA: bingoRoom(), inv_1: { items: [bcItem(2)] } }) };
  const res = await POST(bingoPowers, env, { action: 'extra-card', code: 'AAAA' }, as('1'));
  check('extra card is accepted', res.status, 200);
  const room = env.MARKETPLACE.read('bingo_AAAA');
  const me = room.players[0];
  check('the player now holds two cards', me.cards.length, 2);
  ok('the original card is card one, unchanged', me.cards[0].join() === me.cardIds.join());
  ok('the new card is a real card', me.cards[1].length === 25 && me.cards[1][12] === 0);
  check('exactly one item was spent', countOf(env, '1', 'bonus-card'), 1);

  /* The cap: a third card fits, a fourth is refused WITHOUT a spend. */
  await POST(bingoPowers, env, { action: 'extra-card', code: 'AAAA' }, as('1'));
  const refused = await POST(bingoPowers, env, { action: 'extra-card', code: 'AAAA' }, as('1'));
  check('the fourth card is refused', refused.status, 400);
  check('and costs nothing — no items left to lose anyway', countOf(env, '1', 'bonus-card'), 0);
  check('three cards is the ceiling', env.MARKETPLACE.read('bingo_AAAA').players[0].cards.length, 3);

  /* Without the item, refusal names the problem. */
  const env2 = { MARKETPLACE: fakeKV({ bingo_AAAA: bingoRoom(), inv_1: { items: [] } }) };
  const broke = await POST(bingoPowers, env2, { action: 'extra-card', code: 'AAAA' }, as('1'));
  check('no item, no card', broke.status, 400);
  check('and the room is untouched', env2.MARKETPLACE.read('bingo_AAAA').players[0].cards, undefined);
}

{
  /* Wildcards: recorded in the room, spent once, refusals free. */
  const env = { MARKETPLACE: fakeKV({ bingo_AAAA: bingoRoom(), inv_1: { items: [wcItem(2)] } }) };

  const good = await POST(bingoPowers, env, { action: 'wildcard', code: 'AAAA', cardIndex: 0, eventId: 7 }, as('1'));
  check('a stamp on an uncalled square lands', good.status, 200);
  check('and is recorded in the room', env.MARKETPLACE.read('bingo_AAAA').players[0].wildcards, [{ cardIndex: 0, eventId: 7 }]);
  check('for one item', countOf(env, '1', 'wildcard'), 1);

  /* THE MONEY INVARIANT. Every refusal below must leave the count at 1. */
  const called = await POST(bingoPowers, env, { action: 'wildcard', code: 'AAAA', cardIndex: 0, eventId: 5 }, as('1'));
  check('stamping a called square is refused', called.status, 400);
  const offCard = await POST(bingoPowers, env, { action: 'wildcard', code: 'AAAA', cardIndex: 0, eventId: 60 }, as('1'));
  check('stamping a square not on the card is refused', offCard.status, 400);
  const dupe = await POST(bingoPowers, env, { action: 'wildcard', code: 'AAAA', cardIndex: 0, eventId: 7 }, as('1'));
  check('stamping twice is refused', dupe.status, 400);
  const ghost = await POST(bingoPowers, env, { action: 'wildcard', code: 'AAAA', cardIndex: 5, eventId: 7 }, as('1'));
  check('a card the player does not hold is refused', ghost.status, 400);
  check('and none of those refusals cost an item', countOf(env, '1', 'wildcard'), 1);

  /* What a refresh restores: state must hand back cards AND stamps. */
  const st = await (await GETst(env, 'AAAA', as('1'))).json();
  check('state returns my cards', st.you.cards.length, 1);
  check('and my stamps', st.you.wildcards, [{ cardIndex: 0, eventId: 7 }]);
  const anon = await (await GETst(env, 'AAAA')).json();
  ok('but nothing personal without a session', !('you' in anon));
}

{
  /* A room from before powers existed: cardIds only. */
  const env = { MARKETPLACE: fakeKV({ bingo_AAAA: bingoRoom(), inv_1: { items: [wcItem(1)] } }) };
  delete env.MARKETPLACE; env.MARKETPLACE = fakeKV({ bingo_AAAA: bingoRoom(), inv_1: { items: [wcItem(1)] } });
  const res = await POST(bingoPowers, env, { action: 'wildcard', code: 'AAAA', cardIndex: 0, eventId: 8 }, as('1'));
  check('legacy players are normalised, not crashed', res.status, 200);
  const me = env.MARKETPLACE.read('bingo_AAAA').players[0];
  ok('and keep cardIds mirrored to cards[0] for the host page', me.cardIds.join() === me.cards[0].join());
}

/* ══ MTGBBB ════════════════════════════════════════════════════════════ */

const POOL = Array.from({ length: 30 }, (_, i) => ({ name: 'Card ' + i, rarity: i % 7 === 0 ? 'rare' : 'common', image: '' }));
function mtgRoom(over = {}) {
  const card = buildCard(POOL.map(c => c.name), 'ROOM:u1');
  return {
    code: 'BBBB', status: 'active', pool: POOL, pulls: [],
    players: [{ id: 'u_1', name: 'P1', card }],
    ...over,
  };
}

{
  /* Scoring: a wildcard completes lines but mints no treatment points. */
  const card = buildCard(POOL.map(c => c.name), 'x');
  const pulls = [0, 1, 2, 3].map(i => ({ card: card[i], treatments: [] }));
  const without = scoreCard(card, pulls);
  const withWild = scoreCard(card, pulls, [4]);
  check('four pulls plus a stamp complete the top row', withWild.lines.length >= 1, true);
  ok('which the un-stamped card had not', without.lines.length === 0);
  check('stamps add marks', withWild.marks, without.marks + 1);
  check('but never treatments', withWild.treatments, without.treatments);

  /* bestOf: the better card wins, not the sum. */
  const p = { cards: [card, buildCard(POOL.map(c => c.name), 'y')], wildcards: [{ cardIndex: 0, squareIndex: 4 }] };
  const best = bestOf(p, pulls);
  check('the stamped card is the best card', best.cardIndex, 0);
  const board = standings([{ id: 'u_1', name: 'P1', ...p }], pulls);
  check('standings carry the card count for the host', board[0].cardCount, 2);
  check('and the stamps used', board[0].wildcardsUsed, 1);
}

{
  /* Extra card: deterministic — the same seed deals the same card. */
  const env = { MARKETPLACE: fakeKV({ mtgbbb_BBBB: mtgRoom(), inv_1: { items: [bcItem(1)] } }) };
  const res = await POST(mtgPowers, env, { action: 'extra-card', code: 'BBBB' }, as('1'));
  check('mtgbbb extra card is accepted', res.status, 200);
  const room = env.MARKETPLACE.read('mtgbbb_BBBB');
  check('the player holds two cards', room.players[0].cards.length, 2);
  check('dealt exactly as the seed dictates — no reroll by re-buying',
        room.players[0].cards[1], buildCard(POOL.map(c => c.name), 'BBBB:1:extra1'));
  check('one item spent', countOf(env, '1', 'bonus-card'), 0);
}

{
  /* Wildcard: positional, refused when the pulls already marked it. */
  const room = mtgRoom();
  const pulledName = room.players[0].card[3];
  room.pulls = [{ card: pulledName, treatments: [] }];
  const env = { MARKETPLACE: fakeKV({ mtgbbb_BBBB: room, inv_1: { items: [wcItem(1)] } }) };

  const already = await POST(mtgPowers, env, { action: 'wildcard', code: 'BBBB', cardIndex: 0, squareIndex: 3 }, as('1'));
  check('a square the pulls marked is refused', already.status, 400);
  check('for free', countOf(env, '1', 'wildcard'), 1);

  const good = await POST(mtgPowers, env, { action: 'wildcard', code: 'BBBB', cardIndex: 0, squareIndex: 8 }, as('1'));
  check('an unmarked square takes the stamp', good.status, 200);
  check('recorded positionally', env.MARKETPLACE.read('mtgbbb_BBBB').players[0].wildcards, [{ cardIndex: 0, squareIndex: 8 }]);
  check('and the item is gone', countOf(env, '1', 'wildcard'), 0);
}

/* ══ The clients hold up their half ════════════════════════════════════ */
{
  const cb = fs.readFileSync(path.join(REPO, 'games/commander-bingo/index.html'), 'utf8').replace(/\r\n/g, '\n');

  /* The sweep is gone: marks are DERIVED from called + own stamps. */
  ok('bingo marks are derived, never swept', /const next = entry \? deriveMarks\(entry\)/.test(cb));
  ok('the old sweep deletion is gone', !/markedSet\.delete\(id\);\n\s+const cell/.test(cb));
  ok('the bonus card goes through the server', /action: 'extra-card', code: gameCode/.test(cb));
  ok('and no longer rerolls locally', !/card = generateCard\(\);\n\s+markedSet = new Set\(\['free'\]\);\n\s+previousBingos = 0;\n\s+exitWildcardMode/.test(cb));
  ok('the wildcard goes through the server', /action: 'wildcard', code: gameCode/.test(cb));
  ok('the client no longer claims item use itself', !/action: 'use', itemId/.test(cb));
  ok('the inventory bar is live-game only', /if \(gameMode !== 'live'\)/.test(cb));
  ok('results take the best card', /Results and the leaderboard read the player's BEST card/.test(cb));

  const host = fs.readFileSync(path.join(REPO, 'games/commander-bingo/host.html'), 'utf8').replace(/\r\n/g, '\n');
  ok('the host scores every card a player holds', /cards\.forEach\(\(ids, ci\) => \{/.test(host));
  ok('with wildcards counted as marks', /countBingos\(cardEvents, wildIds\)/.test(host));
  ok('and the row says how a score was reached', /r\.cardCount \+ ' cards'/.test(host));

  const mb = fs.readFileSync(path.join(REPO, 'games/mtgbbb/index.html'), 'utf8').replace(/\r\n/g, '\n');
  ok('mtgbbb renders the active card from you.cards', /you\.cards\[activeCardIdx\]\) \? you\.cards\[activeCardIdx\]\.card : you\.card/.test(mb));
  ok('its wildcard goes through powers', /\/api\/mtgbbb\/powers/.test(mb));
  ok('items come from the shared commander-bingo pool', /\/api\/inventory\?game=commander-bingo/.test(mb));
  ok('stamped cells are badged', /\.mtg-cell\.wild::after/.test(mb));
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[bingo-powers] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[bingo-powers] ${passed} assertions passed.`);
console.log('');
