#!/usr/bin/env node
/* ══════════════════════════════════════════════
   DINODEX SORT — and the thing it must not give away

     node server/scripts/test-dinodex-sort.js

   Four orders: name A-Z and Z-A, rarity both ways.

   THE RULE THAT IS NOT OBVIOUS. An undiscovered species shows as "???",
   and the Dinodex is a game about finding out what the rest are. Sorting
   an unknown entry by its hidden NAME leaks it: drop one between
   Allosaurus and Ankylosaurus and the player has learnt it begins "An".
   Worse, flipping A-Z to Z-A would then narrow it from both ends.

   So the name orders rank discovered species only and set the rest
   behind them, in roster order, in BOTH directions — reversing the sort
   must not reorder the unknowns at all.

   Rarity is a different matter: the undiscovered card already prints its
   rarity as the subtitle, so ordering by it reveals nothing new, and
   those sorts place every entry.

   sortDex lives in the game's inline <script>, which a test cannot
   import, so it is extracted and evaluated — the real function, not a
   copy of its logic.
   ══════════════════════════════════════════════ */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GAME = readFileSync(join(REPO, 'games/dino-park/index.html'), 'utf8');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

/* ── The real sortDex, lifted out of the page ────────────────────────── */
const src = /function sortDex\(list, how\) \{[\s\S]*?\n\}/.exec(GAME);
ok('sortDex is found in the game', !!src);

const RARITY_ORDER = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
/* A roster deliberately NOT in alphabetical or rarity order, so a sort that
   silently did nothing would be visible. */
const ROSTER = [
  { id: 'zeta',  name: 'Zetasaurus',  rarity: 'common' },
  { id: 'alpha', name: 'Alphasaurus', rarity: 'legendary' },
  { id: 'mid',   name: 'Midosaurus',  rarity: 'rare' },
  { id: 'beta',  name: 'Betasaurus',  rarity: 'common' },
  { id: 'omega', name: 'Omegasaurus', rarity: 'epic' },
  { id: 'kappa', name: 'Kappasaurus', rarity: 'uncommon' },
];

function run(discovered) {
  const sandbox = {
    ROSTER, RARITY_ORDER,
    state: { discovered },
    DEX_SORTS: { default: {}, 'name-asc': {}, 'name-desc': {}, 'rare-asc': {}, 'rare-desc': {} },
    Map, JSON, Math,
  };
  vm.createContext(sandbox);
  vm.runInContext(src[0] + '\nglobalThis.__sortDex = sortDex;', sandbox);
  return (how) => sandbox.__sortDex(ROSTER, how).map(r => r.id);
}

/* ── Nothing discovered: the name sorts must not reorder anything ────── */
{
  const sort = run([]);
  const roster = ROSTER.map(r => r.id);
  check('with nothing found, A-Z leaves the dex order alone', sort('name-asc'), roster);
  check('and so does Z-A', sort('name-desc'), roster);
  ok('which is the point: neither reveals a single name',
    JSON.stringify(sort('name-asc')) === JSON.stringify(sort('name-desc')));

  /* Rarity still sorts, because rarity is already on the card. */
  check('rarity ascending still groups them',
    sort('rare-asc'), ['zeta', 'beta', 'kappa', 'mid', 'omega', 'alpha']);
  /* The direction applies to the BAND, not inside it: within one rarity the
     order stays stable (here, dex order, since none is discovered). Fully
     reversing would shuffle unknowns about for no reason, and the control
     says "Rarity", not "everything backwards". */
  check('and descending reverses the bands, not the entries inside them',
    sort('rare-desc'), ['alpha', 'omega', 'mid', 'kappa', 'zeta', 'beta']);
  check('so the common pair keeps its order in both directions',
    sort('rare-asc').slice(0, 2), sort('rare-desc').slice(-2));
}

/* ── Some discovered: known sorted, unknown set aside ────────────────── */
{
  const sort = run(['zeta', 'mid']);           // Zetasaurus, Midosaurus

  const az = sort('name-asc');
  check('A-Z puts the known names in order first', az.slice(0, 2), ['mid', 'zeta']);
  check('and leaves the unknowns behind in dex order',
    az.slice(2), ['alpha', 'beta', 'omega', 'kappa']);

  const za = sort('name-desc');
  check('Z-A reverses the known names', za.slice(0, 2), ['zeta', 'mid']);
  check('THE LEAK TEST: the unknowns do not move when the direction flips',
    za.slice(2), az.slice(2));
  ok('and are still last', za.slice(2).every(id => !['zeta', 'mid'].includes(id)));
}

/* ── Rarity keeps every entry in its band, readable ones first ───────── */
{
  const sort = run(['beta']);                  // Betasaurus, a common
  const up = sort('rare-asc');
  check('the two commons lead, the discovered one first',
    up.slice(0, 2), ['beta', 'zeta']);
  check('and the rest follow in rarity order',
    up.slice(2), ['kappa', 'mid', 'omega', 'alpha']);

  /* Every band is contiguous — a sort that interleaved rarities would make
     the rarity filter and the rarity sort disagree about the same set. */
  const rank = (id) => RARITY_ORDER.indexOf(ROSTER.find(r => r.id === id).rarity);
  const ranks = up.map(rank);
  ok('the bands are contiguous and ascending',
    ranks.every((n, i) => i === 0 || n >= ranks[i - 1]));

  const down = sort('rare-desc').map(rank);
  ok('and descending is contiguous too',
    down.every((n, i) => i === 0 || n <= down[i - 1]));
}

/* ── It is reachable, and does not lose entries ──────────────────────── */
{
  const sort = run(['zeta']);
  for (const how of ['default', 'name-asc', 'name-desc', 'rare-asc', 'rare-desc']) {
    check(`${how}: every species is still present`,
      sort(how).slice().sort(), ROSTER.map(r => r.id).sort());
  }
  check('an unknown sort name is left alone', sort('nonsense'), ROSTER.map(r => r.id));

  /* The control exists and is wired, or none of the above is reachable. */
  ok('the dex renders a sort control', /id="dexSortSel"/.test(GAME));
  ok('which re-renders on change', /dexSort=this\.value;renderDinodex\(\)/.test(GAME));
  ok('and the renderer applies it', /sortDex\(filtered, dexSort\)/.test(GAME));
  const opts = /const DEX_SORTS = \{([\s\S]*?)\n\};/.exec(GAME);
  ok('the four orders plus the default are offered',
    !!opts && ['default', 'name-asc', 'name-desc', 'rare-asc', 'rare-desc']
      .every(k => opts[1].includes(k)));
}

/* ── Report ─────────────────────────────────────────────────────────── */
if (failures.length) {
  console.error(`\n✗ ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`[dinodex-sort] ${passed} assertions passed.`);
