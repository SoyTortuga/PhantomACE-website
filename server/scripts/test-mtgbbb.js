#!/usr/bin/env node
/* ══════════════════════════════════════════════
   MTGBBB SCORING — test suite

     node server/scripts/test-mtgbbb.js

   Everything else in MTGBBB is measured against this module, so it is
   worth proving before a room, a panel or a Scryfall call exists.

   The rules look simple and are not. Marks score once per CARD but
   treatments score once per PULL, so a duplicate scores nothing the first
   way and something the second. Thirteen patterns overlap — the
   corners-and-centre pattern shares four squares with the diagonals and
   its centre with both — so "how many lines is this" is not a partition.
   And there is no free centre, which is the whole reason the corners
   pattern is five squares rather than four.

   Each of those is a place where an implementation can look right and pay
   the wrong number, on stream, to real people competing for a prize.
   ══════════════════════════════════════════════ */

import * as S from '../../functions/api/mtgbbb-scoring.js';

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

/** A pool big enough to fill a grid, with ids that sort predictably. */
const POOL = Array.from({ length: 80 }, (_, i) => 'c' + String(i).padStart(2, '0'));

/** A card whose squares are simply c00..c24, so index === id. */
const CARD = POOL.slice(0, S.SQUARES);

/** Pull the card sitting at grid index `i`. */
const pullAt = (i, treatments) => ({ card: CARD[i], treatments: treatments || [] });

/* ── The patterns ────────────────────────────────────────────────────── */
{
  check('thirteen patterns', S.PATTERNS.length, 13);
  check('five rows', S.PATTERNS.filter(p => p.kind === 'row').length, 5);
  check('five columns', S.PATTERNS.filter(p => p.kind === 'column').length, 5);
  check('two diagonals', S.PATTERNS.filter(p => p.kind === 'diagonal').length, 2);
  check('one corners pattern', S.PATTERNS.filter(p => p.kind === 'corners').length, 1);

  /* EVERY pattern is five squares. On a traditional card the corners
     pattern is four, because the centre is free. Here it is not. */
  check('every pattern is five squares',
    S.PATTERNS.filter(p => p.cells.length !== 5).map(p => p.id), []);
  check('no pattern repeats a square',
    S.PATTERNS.filter(p => new Set(p.cells).size !== 5).map(p => p.id), []);
  check('every square is on the grid',
    S.PATTERNS.filter(p => p.cells.some(c => c < 0 || c >= S.SQUARES)).map(p => p.id), []);
  check('no two patterns are the same set of squares',
    S.PATTERNS.length,
    new Set(S.PATTERNS.map(p => [...p.cells].sort((a, b) => a - b).join(','))).size);

  const corners = S.PATTERNS.find(p => p.kind === 'corners');
  check('corners & centre is exactly that', [...corners.cells].sort((a, b) => a - b),
    [0, 4, 12, 20, 24]);

  /* Overlap is intended and is the reason blackout pays all thirteen. */
  const diag = S.PATTERNS.find(p => p.id === 'diag');
  check('the corners pattern overlaps a diagonal',
    corners.cells.filter(c => diag.cells.includes(c)).sort((a, b) => a - b), [0, 12, 24]);
}

/* ── An empty card ───────────────────────────────────────────────────── */
{
  const r = S.scoreCard(CARD, []);
  check('nothing pulled scores nothing', r.points, 0);
  check('and completes no lines', r.lines.length, 0);
  check('and is not a blackout', r.blackout, false);
  check('nothing is one away on an empty card', S.oneAway(r.marked), []);
}

/* ── Marks ───────────────────────────────────────────────────────────── */
{
  const r = S.scoreCard(CARD, [pullAt(0), pullAt(7)]);
  check('two pulls, two marks', r.marks, 2);
  check('two points', r.points, 2);

  /* THE DUPLICATE RULE, half one. A box will pull the same rare twice. */
  const dup = S.scoreCard(CARD, [pullAt(0), pullAt(0), pullAt(0)]);
  check('a card pulled three times is marked once', dup.marks, 1);
  check('and scores one point', dup.points, 1);

  const off = S.scoreCard(CARD, [{ card: 'c99', treatments: ['foil'] }]);
  check('a card nobody holds scores nothing', off.points, 0);
  check('not even its treatments', off.treatments, 0);
}

/* ── Treatments ──────────────────────────────────────────────────────── */
{
  const foil = S.scoreCard(CARD, [pullAt(0, ['foil'])]);
  check('a foil scores the mark and the treatment', foil.points, 2);

  /* STACKING. One physical card, two treatments, two points. */
  const both = S.scoreCard(CARD, [pullAt(0, ['foil', 'borderless'])]);
  check('a borderless foil is two treatments', both.treatments, 2);
  check('and scores three with its mark', both.points, 3);

  /* THE DUPLICATE RULE, half two. The mark does not score again; the
     treatments do. This is the case most likely to be implemented as
     "skip the pull entirely if already marked", which pays 1 instead
     of 3. */
  const later = S.scoreCard(CARD, [pullAt(0), pullAt(0, ['foil', 'borderless'])]);
  check('a plain copy then a borderless foil is one mark', later.marks, 1);
  check('and two treatments', later.treatments, 2);
  check('scoring three in total', later.points, 3);

  /* A moderator working at the pace of a live box will double-tick a chip.
     Within one pull that must not pay twice. */
  const fat = S.scoreCard(CARD, [pullAt(0, ['foil', 'foil'])]);
  check('the same chip ticked twice on one pull scores once', fat.treatments, 1);

  /* But the same treatment on a genuinely separate pull does score again. */
  const twice = S.scoreCard(CARD, [pullAt(0, ['foil']), pullAt(0, ['foil'])]);
  check('two foil copies score two treatments', twice.treatments, 2);

  check('no treatments array is no treatments',
    S.scoreCard(CARD, [{ card: CARD[0] }]).treatments, 0);
  check('junk in the array does not score',
    S.countTreatments({ treatments: ['foil', '', null, undefined, 3] }), 1);
}

/* ── Bingo ───────────────────────────────────────────────────────────── */
{
  const row0 = [0, 1, 2, 3, 4].map(i => pullAt(i));
  const r = S.scoreCard(CARD, row0);
  check('a completed row is one line', r.lines.length, 1);
  check('scoring five marks plus five bingo', r.points, 10);

  /* Four of five pays the marks and nothing else — the most important
     negative case in the file. */
  const four = S.scoreCard(CARD, row0.slice(0, 4));
  check('four of five is no bingo', four.lines.length, 0);
  check('and scores only its marks', four.points, 4);
  check('the fifth square is one away', S.oneAway(four.marked), [4]);

  /* CUMULATIVE. A row and a column crossing it is two lines, nine marks. */
  const cross = S.scoreCard(CARD, [
    ...row0,
    ...[5, 10, 15, 20].map(i => pullAt(i)),
  ]);
  check('a row and a column are two lines', cross.lines.length, 2);
  check('scoring nine marks and two bingos', cross.points, 9 + 10);

  /* The corners pattern is reachable without any row, column or diagonal,
     which is the point of having it. */
  const corners = S.scoreCard(CARD, [0, 4, 12, 20, 24].map(i => pullAt(i)));
  check('corners and centre alone is a bingo', corners.lines.length, 1);
  check('and it is the corners pattern', corners.lines[0].kind, 'corners');
  check('scoring five marks plus five', corners.points, 10);

  /* A completed diagonal takes the centre and two corners with it, but on
     its own is still one line. */
  const diag = S.scoreCard(CARD, [0, 6, 12, 18, 24].map(i => pullAt(i)));
  check('a diagonal alone is one line', diag.lines.length, 1);
}

/* ── Blackout ────────────────────────────────────────────────────────── */
{
  const all = CARD.map((_, i) => pullAt(i));
  const r = S.scoreCard(CARD, all);

  check('every square marked is a blackout', r.blackout, true);
  check('and completes all thirteen patterns', r.lines.length, 13);
  check('scoring 25 marks, 65 bingo and 25 blackout', r.points, 115);
  check('which is the stated maximum', r.points, S.MAX_BASE_SCORE);
  check('broken down', r.breakdown, { marks: 25, treatments: 0, bingo: 65, blackout: 25 });

  /* One square short is not a blackout, and loses far more than one
     point: the square sits on a row, a column and possibly more. */
  const short = S.scoreCard(CARD, all.slice(0, 24));
  check('twenty-four squares is not a blackout', short.blackout, false);
  check('and is worth much less than 114', short.points < 114, true);

  const treated = S.scoreCard(CARD, CARD.map((_, i) => pullAt(i, ['foil'])));
  check('a blackout in all foils adds 25 more', treated.points, 140);
}

/* ── One away ────────────────────────────────────────────────────────── */
{
  /* Square 12 is the centre: it sits on row 2, column 2, both diagonals
     and the corners pattern. Filling everything except it should report
     it exactly once, not five times. */
  const allButCentre = CARD.map((_, i) => i).filter(i => i !== 12).map(i => pullAt(i));
  const r = S.scoreCard(CARD, allButCentre);
  check('the centre is reported one away exactly once', S.oneAway(r.marked), [12]);
  check('and five patterns are still open', r.lines.length, 13 - 5);

  /* Two independent near-lines report both squares. */
  const two = S.scoreCard(CARD, [
    ...[0, 1, 2, 3].map(i => pullAt(i)),
    ...[20, 21, 22, 23].map(i => pullAt(i)),
  ]);
  check('two near-rows are two one-aways', S.oneAway(two.marked), [4, 24]);

  /* Three of five is not one away. */
  const three = S.scoreCard(CARD, [0, 1, 2].map(i => pullAt(i)));
  check('three of five reports nothing', S.oneAway(three.marked), []);
}

/* ── Building a card ─────────────────────────────────────────────────── */
{
  const a = S.buildCard(POOL, 'ROOM:user1');
  check('a card is 25 squares', a.length, 25);
  check('all distinct', new Set(a).size, 25);
  check('all from the pool', a.filter(id => !POOL.includes(id)).length, 0);

  /* THE REFRESH EXPLOIT. Same seed, same card — otherwise a player
     reloads until the grid looks good. */
  check('the same seed is the same card', S.buildCard(POOL, 'ROOM:user1'), a);
  ok('a different player gets a different card',
    JSON.stringify(S.buildCard(POOL, 'ROOM:user2')) !== JSON.stringify(a));
  ok('and so does the same player in a different room',
    JSON.stringify(S.buildCard(POOL, 'ROOM2:user1')) !== JSON.stringify(a));

  /* Not a rotation or a reversal of the same draw — seeds close together
     must not produce visibly related cards. */
  const b = S.buildCard(POOL, 'ROOM:user2');
  ok('two cards do not simply share an order',
    a.filter((id, i) => b[i] === id).length < 10);

  /* A pool of exactly 25 is legal and gives everyone the same squares in
     different places. Below that there is no card to build. */
  check('a pool of exactly 25 works', S.buildCard(POOL.slice(0, 25), 's').length, 25);

  let refused = null;
  try { S.buildCard(POOL.slice(0, 24), 's'); } catch (e) { refused = e.message; }
  ok('a pool of 24 is refused, not padded', refused !== null);
  ok('and the reason says what was wrong', /24/.test(refused || ''));

  /* Duplicates in the pool are collapsed before the count is checked, so
     a set listing a card twice cannot sneak past the guard and produce a
     grid with the same card on two squares. */
  let dupRefused = null;
  try { S.buildCard([...POOL.slice(0, 20), ...POOL.slice(0, 20)], 's'); }
  catch (e) { dupRefused = e.message; }
  ok('a pool of 40 entries but 20 cards is refused', dupRefused !== null);

  /* Every square of the pool should be reachable; a generator that only
     ever drew from the first 25 would pass every test above. */
  const seen = new Set();
  for (let i = 0; i < 200; i++) for (const id of S.buildCard(POOL, 'seed' + i)) seen.add(id);
  check('the whole pool is reachable', seen.size, POOL.length);
}

/* ── Across every player ─────────────────────────────────────────────── */
{
  const cards = [
    ['a', 'b', 'c'],
    ['a', 'b', 'd'],
    ['a', 'e', 'f'],
  ];
  const counts = S.cardCounts(cards);
  check('a is on every card', counts.get('a'), 3);
  check('b on two', counts.get('b'), 2);
  check('f on one', counts.get('f'), 1);
  check('the hottest card', S.hottest(cards, 1), [{ id: 'a', count: 3 }]);
  check('top three', S.hottest(cards, 3).map(h => h.id), ['a', 'b', 'c']);

  /* A card holding a duplicate must not count twice toward the heat map,
     or the overlay's "41 of 62 cards had this" would exceed the number of
     players. */
  check('a duplicate on one card counts once',
    S.cardCounts([['a', 'a', 'b']]).get('a'), 1);
}

/* ── Standings ───────────────────────────────────────────────────────── */
{
  const players = [
    { id: 'u1', name: 'Bea', card: CARD },
    { id: 'u2', name: 'Abe', card: [...CARD].reverse() },
    { id: 'u3', name: 'Cam', card: POOL.slice(40, 65) },
  ];
  const table = S.standings(players, [pullAt(0, ['foil'])]);

  check('everyone is ranked', table.length, 3);
  check('the leader is first', table[0].points >= table[1].points, true);
  check('and scores mark plus treatment', table[0].points, 2);

  /* TIES ARE NOT BROKEN HERE. The host flips a coin on stream, so
     inventing a tiebreak would quietly decide something they have said
     they want to decide themselves. */
  const tied = S.standings([
    { id: 'u1', name: 'Bea', card: CARD },
    { id: 'u2', name: 'Abe', card: CARD },
  ], [pullAt(3)]);
  check('tied players score the same', tied[0].points, tied[1].points);

  check('an empty room is an empty table', S.standings([], []), []);
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[mtgbbb] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[mtgbbb] ${passed} assertions passed.`);
console.log('');
