#!/usr/bin/env node
/* ══════════════════════════════════════════════
   DINO PARK — vault capacity and Dinodex completion

     node server/scripts/test-dino-park-progress.js

   TWO COMPLETIONS, NOT ONE. Finding all 85 species and finding all 1105
   mutations are different games on different timescales, and the Dinodex
   used to average them into a single "Complete" figure that read 100%
   while a player had seen barely a tenth of the mutations.

   THE TOTAL IS COUNTED, NOT ASSUMED, which is the part that rots. The old
   code carried `ROSTER.length * 5` — 425 against a real 1105, because it
   counted neither the eight global mutations nor the fact that a species
   gets three colour swaps rather than five. It was never rendered, so
   nobody found out. Anything derived from a literal here will drift the
   moment a mutation is added, so this asserts the derivation instead: the
   game walks getSpecMutStatus, and the arithmetic behind 1105 is pinned
   here from the source tables.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const PAGE = path.join(REPO, 'games', 'dino-park', 'index.html');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

const page = fs.readFileSync(PAGE, 'utf8');

/* A top-level `const NAME = {` … `\n};` (or `[` … `\n];`) block. */
function block(name) {
  const i = page.indexOf(`const ${name}`);
  if (i < 0) return '';
  const objEnd = page.indexOf('\n};', i), arrEnd = page.indexOf('\n];', i);
  const end = objEnd < 0 ? arrEnd : arrEnd < 0 ? objEnd : Math.min(objEnd, arrEnd);
  return page.slice(i, end);
}
const topKeys = (name) =>
  [...block(name).matchAll(/^\s{2}([A-Za-z0-9_]+)\s*:/gm)].map(m => m[1]);

/* ── The vault ───────────────────────────────────────────────────────── */
{
  const m = /const MAX_VAULT_SIZE = (\d+);/.exec(page);
  ok('MAX_VAULT_SIZE is declared', !!m);
  const cap = m ? Number(m[1]) : 0;
  check('the vault holds 200', cap, 200);

  /* Every gate reads the constant. A literal 50 left behind in one of the
     four "is it full?" checks would refuse dinosaurs the vault has room
     for, and only on whichever path nobody tested. */
  const guards = (page.match(/state\.vault\.length\s*[<>]=?\s*MAX_VAULT_SIZE/g) || []).length;
  ok('the full/empty checks all read the constant', guards >= 4);
  ok('and none of them hardcode the old 50',
     !/state\.vault\.length\s*[<>]=?\s*50\b/.test(page));
}

/* ── Two completions ─────────────────────────────────────────────────── */
{
  ok('the Dinodex reports species completion', /dex-stat-lbl">Species Complete</.test(page));
  ok('and mutation completion separately', /dex-stat-lbl">Mutations Complete</.test(page));
  ok('with the old single "Complete" gone', !/dex-stat-lbl">Complete</.test(page));

  /* Five cards do not fit a phone in one row, and a fixed four-column grid
     would clip the fifth rather than wrap it. */
  ok('the stat bar wraps instead of fixing a column count',
     /\.dex-stats-bar\s*\{[^}]*repeat\(auto-fit/.test(page));

  /* The percentages must divide by the right denominators — species by the
     roster, mutations by the mutation total — or the two readouts are one
     readout with two labels. */
  ok('species completion divides by the roster',
     /pct\(discCount, ROSTER\.length\)/.test(page));
  ok('mutation completion divides by the mutation total',
     /pct\(muts\.found, muts\.total\)/.test(page));
}

/* ── The total is derived ────────────────────────────────────────────── */
{
  ok('the wrong ROSTER * 5 total is gone', !/ROSTER\.length \* 5/.test(page));
  ok('the total walks every species', /ROSTER\.forEach\(spec =>/.test(page));
  ok('and asks getSpecMutStatus what each one has',
     /getSpecMutStatus\(spec\.id\)\.forEach/.test(page));

  /* A save carrying a mutation id the game no longer defines must not
     count, or a renamed mutation shows a player 101% complete forever. */
  ok('found mutations are filtered against what exists',
     /state\.discoveredMutations\.filter\(k => dexMutTotalsCache\.has\(k\)\)/.test(page));

  /* THE ARITHMETIC, pinned from the source tables rather than from a
     number typed into the game. If a mutation is added anywhere, this
     recomputes and the game recomputes, and they still agree. */
  const roster = [...block('ROSTER').matchAll(/\{\s*id:'([A-Za-z0-9_]+)'/g)].map(m => m[1]);
  check('the roster is 85 species', roster.length, 85);

  const swaps = /\.slice\(0,\s*(\d+)\)/.exec(block('function pickSwaps') || page.slice(
    page.indexOf('function pickSwaps'), page.indexOf('function pickSwaps') + 400));
  const perSpeciesSwaps = swaps ? Number(swaps[1]) : 0;
  check('each species gets three colour swaps', perSpeciesSwaps, 3);

  const globals = topKeys('MUTATIONS');
  check('there are eight global mutations', globals.length, 8);

  const special = new Set(topKeys('SPECIAL_MUTS'));
  const rare = new Set(topKeys('RARE_MUTS'));
  const withSpecial = roster.filter(id => special.has(id)).length;
  const withRare = roster.filter(id => rare.has(id)).length;

  const total = roster.length * perSpeciesSwaps + withSpecial + withRare
              + roster.length * globals.length;
  check('which totals 1105 mutations', total, 1105);
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[dino-park-progress] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[dino-park-progress] ${passed} assertions passed.`);
console.log('');
