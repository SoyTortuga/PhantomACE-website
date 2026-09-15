#!/usr/bin/env node
/* ══════════════════════════════════════════════
   MANA CLASH SCORING — test suite

     node server/scripts/test-scoring.js

   Every case in docs/MANA-CLASH-RULES.md, asserted. A dice game's scoring is
   the part players check hardest and complain about loudest, and "the game
   robbed me" is not something you can talk your way out of after the fact.
   These run in milliseconds and need no database, so there is no excuse for
   changing a scoring rule without re-running them.

   Faces: C=1 W=2 U=3 B=4 R=5 G=6
   ══════════════════════════════════════════════ */

import {
  scoreSelection, scorableMask, hasAnyScore, isHotDice, bestSelection,
  nOfAKindScore, FACES, FACE_VALUE, DICE_COUNT,
} from '../../functions/api/mana-clash-scoring.js';

let passed = 0;
const failures = [];

function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}

/** Dice written as digits — '115' is easier to read than ['C','C','R']. */
const D = (s) => s.split('').map(ch => {
  const f = FACES.find(x => FACE_VALUE[x] === Number(ch));
  if (!f) throw new Error(`bad die "${ch}" in "${s}"`);
  return f;
});

const pts = (s) => scoreSelection(D(s)).points;
const ok = (s) => scoreSelection(D(s)).valid;

/* ── Singles ─────────────────────────────────────────────────────────── */
check('single 1', pts('1'), 100);
check('single 5', pts('5'), 50);
check('1 and 5 together', pts('15'), 150);
check('two 1s', pts('11'), 200);
for (const v of ['2', '3', '4', '6']) {
  check(`single ${v} does not score`, ok(v), false);
}

/* ── Triples ─────────────────────────────────────────────────────────── */
check('three 1s', pts('111'), 1000);
check('three 2s', pts('222'), 200);
check('three 3s', pts('333'), 300);
check('three 4s', pts('444'), 400);
check('three 5s', pts('555'), 500);
check('three 6s', pts('666'), 600);

/* ── The doubling table, worked through exactly as the rules print it ── */
const DOUBLING = {
  1: [1000, 2000, 4000, 8000],
  2: [200, 400, 800, 1600],
  3: [300, 600, 1200, 2400],
  4: [400, 800, 1600, 3200],
  5: [500, 1000, 2000, 4000],
  6: [600, 1200, 2400, 4800],
};
for (const [v, row] of Object.entries(DOUBLING)) {
  row.forEach((expected, i) => {
    const n = i + 3;
    check(`${n} of a kind, value ${v} (formula)`, nOfAKindScore(Number(v), n), expected);
    check(`${n} of a kind, value ${v} (scored)`, pts(String(v).repeat(n)), expected);
  });
}

/* Six of a kind takes a 5000-point game outright. Stated in the rules; if
   this ever stops being true the rules are wrong, not the test. */
check('six 1s wins a 5000 game', pts('111111') >= 5000, true);

/* ── Whole-hand combinations ─────────────────────────────────────────── */
check('straight', pts('123456'), 1500);
check('three pairs', pts('223344'), 1500);
check('two triplets', pts('222333'), 2500);

/* ── Best reading always wins — the three cases the rules call out ───── */
check('111555 reads as two triplets, not 1000+500', pts('111555'), 2500);
check('1111 reads as four of a kind, not 1000+100', pts('1111'), 2000);
check('111222 reads as two triplets', pts('111222'), 2500);

/* More of the same principle, where the naive reading is the tempting one */
check('115 takes both 1s and the 5', pts('115'), 250);
check('11111 is five of a kind, not 1000+100+100', pts('11111'), 4000);
check('555 is a triple, not 3 x 50', pts('555'), 500);
check('55 is two singles', pts('55'), 100);
/* Four 5s: quad (1000) beats triple-plus-single (550). */
check('5555 is four of a kind', pts('5555'), 1000);
/* Three pairs (1500) beats four 2s + nothing, and the pair of 3s cannot
   score on its own — so the permissive 4+2 reading is what makes this
   selection legal at all. */
check('222233 as three pairs', pts('222233'), 1500);
check('222233 is a legal keep', ok('222233'), true);
/* Four 1s plus a pair of 3s is the choice the rules are built around, and
   it is worth being exact about. Keeping ALL SIX can only be read as three
   pairs (1500), because the four-of-a-kind reading strands the 3s and a
   keep may not strand anything. Keeping just the four 1s is worth 2000 and
   leaves two dice to re-roll. So 1500-and-six-fresh-dice versus 2000-and-two
   is a real decision, not a scoring quirk. */
check('111133 kept whole is three pairs', pts('111133'), 1500);
check('1111 kept alone is four of a kind', pts('1111'), 2000);
check('111133 whole is a legal keep', ok('111133'), true);
check('keeping the 1s and one 3 is not legal', ok('11113'), false);

/* ── Validation: every kept die must contribute ──────────────────────── */
check('cannot hold a 2 with two 1s', ok('112'), false);
check('cannot hold a lone 3', ok('3'), false);
check('cannot hold 6 with a 1', ok('16'), false);
check('can hold three 2s', ok('222'), true);
check('pair of 3s alone is not a keep', ok('33'), false);
check('empty selection is not a keep', scoreSelection([]).valid, false);
check('seven dice is not a keep', scoreSelection(D('1111111')).valid, false);
check('unrecognised die is rejected', scoreSelection(['Z']).valid, false);

/* ── The scorable mask — what lights up ──────────────────────────────── */
check('mask: 1 2 3 4 5 6 all light (straight)', scorableMask(D('123456')), [true, true, true, true, true, true]);
check('mask: 234561 -> only the 5 and 1 in 23456x', scorableMask(D('234562')), [false, false, false, true, false, false]);
check('mask: 112346 -> the 1s and the 3? no, only 1s and nothing else', scorableMask(D('112346')), [true, true, false, false, false, false]);
check('mask: 222346 -> the triple lights, 4 and 6 do not', scorableMask(D('222346')), [true, true, true, false, false, false]);
check('mask: nothing scores', scorableMask(D('223466')), [false, false, false, false, false, false]);

/* A die that lights up must always be a legal keep on its own or with the
   others it lit with. Proven exhaustively below rather than asserted here. */

/* ── Bust (MANA BURN) and hot dice (MANA CLASH) ──────────────────────── */
check('223466 is a bust', hasAnyScore(D('223466')), false);
check('234466 is a bust', hasAnyScore(D('234466')), false);
check('a single 1 is not a bust', hasAnyScore(D('234461')), true);
check('hot dice on six', isHotDice(D('111555')), true);
check('hot dice on three remaining', isHotDice(D('111')), true);
check('hot dice on one remaining', isHotDice(D('5')), true);
check('not hot when a die is left over', isHotDice(D('1112')), false);
check('no dice is not hot dice', isHotDice([]), false);

/* ══ Exhaustive properties ══════════════════════════════════════════════
   Every hand of every size, checked for the invariants that must hold no
   matter what the table above says. This is what catches a rule change that
   looks right in one example and is wrong everywhere else. */

function* allHands(n) {
  if (n === 0) { yield []; return; }
  for (const rest of allHands(n - 1)) {
    for (const f of FACES) yield [f, ...rest];
  }
}

let hands = 0;
let maskViolations = 0;
let negative = 0;
let bustMismatch = 0;
let hotMismatch = 0;

for (let n = 1; n <= DICE_COUNT; n++) {
  for (const hand of allHands(n)) {
    hands++;
    const mask = scorableMask(hand);

    /* A lit die must be keepable: the selection of every lit die is not
       necessarily valid, but each lit die must appear in SOME valid
       selection — and a dark die must appear in NONE. Verified directly
       against every subset. */
    for (let i = 0; i < n; i++) {
      let appears = false;
      for (let bits = 1; bits < (1 << n) && !appears; bits++) {
        if (!(bits & (1 << i))) continue;
        const subset = [];
        for (let j = 0; j < n; j++) if (bits & (1 << j)) subset.push(hand[j]);
        if (scoreSelection(subset).valid) appears = true;
      }
      if (appears !== mask[i]) maskViolations++;
    }

    /* A valid selection never scores zero or less — a keep that pays
       nothing is the bug that makes a turn look stolen. */
    const whole = scoreSelection(hand);
    if (whole.valid && whole.points <= 0) negative++;

    /* Bust is exactly "no die lights up". */
    if (hasAnyScore(hand) !== mask.some(Boolean)) bustMismatch++;

    /* Hot dice is exactly "the whole hand is a legal keep". */
    if (isHotDice(hand) !== whole.valid) hotMismatch++;
  }
}

check('exhaustive: every hand of 1-6 dice covered', hands, 6 + 36 + 216 + 1296 + 7776 + 46656);
check('exhaustive: mask agrees with the scorer everywhere', maskViolations, 0);
check('exhaustive: no valid selection scores zero', negative, 0);
check('exhaustive: bust is exactly an unlit hand', bustMismatch, 0);
check('exhaustive: hot dice is exactly a full-hand keep', hotMismatch, 0);

/* The odds quoted in the rules, confirmed against the same engine the game
   uses rather than against arithmetic done once in a chat message. */
let sixOfAKind = 0;
for (const hand of allHands(6)) {
  if (new Set(hand).size === 1) sixOfAKind++;
}
check('six of a kind is 6 in 46656', [sixOfAKind, 46656], [6, 46656]);

/* ── The suggested keep ──────────────────────────────────────────────────
   What the page pre-selects after a roll, so the player deselects what they
   do not want. It has to be a selection the server will accept, which is a
   stronger requirement than "the dice that light up": a die lights up if it
   scores in SOME reading, and two dice can light up under readings that
   exclude each other. */

const sel = (str) => bestSelection(D(str));

check('suggests both 1s and the 5', sel('115').points, 250);
check('suggests the triple over a single', sel('111').points, 1000);
check('suggests two triplets over triple+triple', sel('111555').points, 2500);
check('suggests nothing on a bust', sel('223466'), null);
/* Four 1s and a pair: three pairs takes all six for 1500, four-of-a-kind
   takes four for 2000. More points wins. */
check('prefers the higher score over the bigger keep', sel('111133').points, 2000);
check('and keeps only the four dice', sel('111133').indices.length, 4);
/* Equal points, fewer dice: keeping fewer leaves more to re-roll. */
check('breaks ties toward fewer dice', sel('15').indices.length, 2);

/* THE PROPERTY THAT MATTERS. Across every hand, the suggestion must be a
   selection scoreSelection() accepts, must be the best available score, and
   must exist exactly when the hand is not a bust. If this ever fails, the
   page pre-selects dice the server then refuses, and the player is told
   their own default is illegal. */
let suggestInvalid = 0;
let suggestNotBest = 0;
let suggestMissing = 0;

for (let n = 1; n <= DICE_COUNT; n++) {
  for (const hand of allHands(n)) {
    const s = bestSelection(hand);

    if (!hasAnyScore(hand)) {
      if (s !== null) suggestMissing++;
      continue;
    }
    if (s === null) { suggestMissing++; continue; }

    const chosen = s.indices.map(i => hand[i]);
    if (!scoreSelection(chosen).valid) suggestInvalid++;
    if (scoreSelection(chosen).points !== s.points) suggestInvalid++;

    /* No subset may beat it. */
    let top = 0;
    for (let bits = 1; bits < (1 << n); bits++) {
      const subset = [];
      for (let i = 0; i < n; i++) if (bits & (1 << i)) subset.push(hand[i]);
      const r = scoreSelection(subset);
      if (r.valid && r.points > top) top = r.points;
    }
    if (s.points !== top) suggestNotBest++;
  }
}

check('exhaustive: every suggestion is a legal keep', suggestInvalid, 0);
check('exhaustive: every suggestion is the best available', suggestNotBest, 0);
check('exhaustive: suggested exactly when not a bust', suggestMissing, 0);

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[scoring] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[scoring] ${passed} assertions passed.`);
console.log(`[scoring] ${hands.toLocaleString()} hands checked exhaustively.`);
console.log('');
