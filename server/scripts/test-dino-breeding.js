#!/usr/bin/env node
/* ══════════════════════════════════════════════
   DINO PARK — THE BREEDING PEN

     node server/scripts/test-dino-breeding.js

   The functions are read out of the page and evaluated, the same way the
   levelling and expedition suites do it, because they live in an inline
   <script> in a single-file game.

   WHAT MATTERS, in the order it would hurt:

     - THE FLOOR IS THE LOWER PARENT. If it were the higher, pairing a
       legendary with a fresh common would be a free legendary every day
       and the whole care loop could be skipped. Everything else about
       this feature is downstream of that one rule.

     - A REFUSED PAIRING COSTS NOTHING. Every check runs before the coins
       are taken and before either parent is stamped, or a rejected
       pairing would put two animals on a day's cooldown for free.

     - ADULTS ONLY, which is what makes this ask something of the player
       rather than pay out on its own. 60 care is real work at one care
       per live hour per type.

     - THE ODDS ARE SHOWN BEFORE PAYING. A gamble whose chances you cannot
       see is a slot machine, and this one takes real coins.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const PAGE = path.join(REPO, 'games/dino-park/index.html');
const src = fs.readFileSync(PAGE, 'utf8').replace(/\r\n/g, '\n');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

function lift(name, kind = 'function') {
  const re = kind === 'function'
    ? new RegExp(`\\nfunction ${name}\\([\\s\\S]*?\\n\\}`)
    : new RegExp(`\\nconst ${name} = [\\s\\S]*?;\\n`);
  const m = re.exec(src);
  if (!m) throw new Error(`could not find ${kind} ${name} in the page`);
  return m[0];
}

const sandbox = [
  lift('RARITY_ORDER', 'const'), lift('GROWTH_THRESHOLDS', 'const'),
  lift('BREED_COOLDOWN_MS', 'const'), lift('BREED_COST', 'const'),
  lift('BREED_UP_BASE', 'const'), lift('BREED_UP_CARE_CAP', 'const'),
  lift('BREED_UP_SAME_SPECIES', 'const'), lift('BREED_UP_SECOND_STEP', 'const'),
  lift('BREED_MUT_ONE', 'const'), lift('BREED_MUT_BOTH', 'const'),
  lift('rarityIndex'), lift('breedCooldownLeft'), lift('breedBlocker'),
  lift('breedEligible'), lift('breedFloorRarity'), lift('breedCost'),
  lift('breedUpChance'), lift('breedRollRarity'), lift('breedMutChance'),
  lift('breedChildSpecies'), lift('breedPair'),
  lift('allDinos'), lift('findDinoByUidLocal'),
].join('\n');

const harness = `
  let state = null;
  function save() {}
  function getStage(d) {
    return d.careCount >= GROWTH_THRESHOLDS.adult ? 'adult'
         : d.careCount >= GROWTH_THRESHOLDS.juvenile ? 'juvenile' : 'hatchling';
  }
  const ROSTER = [
    { id: 'compy',  name: 'Compsognathus', rarity: 'common' },
    { id: 'dodo',   name: 'Dodo',          rarity: 'common' },
    { id: 'raptor', name: 'Velociraptor',  rarity: 'uncommon' },
    { id: 'stego',  name: 'Stegosaurus',   rarity: 'uncommon' },
    { id: 'tricera',name: 'Triceratops',   rarity: 'rare' },
    { id: 'spino',  name: 'Spinosaurus',   rarity: 'epic' },
    { id: 'rex',    name: 'Tyrannosaurus', rarity: 'legendary' },
  ];
  function getRosterById(id) { return ROSTER.find(r => r.id === id); }
  function rollSpecies(r) { const p = ROSTER.filter(x => x.rarity === r); return p[Math.floor(Math.random() * p.length)]; }
  let acquired = [];
  function acquireEgg(speciesId, rarity, opts = {}) { acquired.push({ speciesId, rarity, opts }); return 'incubator'; }
`;

const api = new Function(harness + sandbox + `
  return {
    RARITY_ORDER, BREED_COOLDOWN_MS, BREED_COST, GROWTH_THRESHOLDS,
    BREED_UP_BASE, BREED_MUT_ONE, BREED_MUT_BOTH,
    rarityIndex, breedCooldownLeft, breedBlocker, breedEligible, breedFloorRarity,
    breedCost, breedUpChance, breedRollRarity, breedMutChance, breedChildSpecies, breedPair,
    setState: (s) => { state = s; },
    getState: () => state,
    acquired: () => acquired,
    resetAcquired: () => { acquired = []; },
  };
`)();

const {
  RARITY_ORDER, BREED_COOLDOWN_MS, BREED_COST, GROWTH_THRESHOLDS,
  rarityIndex, breedCooldownLeft, breedBlocker, breedEligible, breedFloorRarity,
  breedCost, breedUpChance, breedRollRarity, breedMutChance, breedChildSpecies, breedPair,
  setState, getState,
} = api;

let uidN = 0;
const ADULT = GROWTH_THRESHOLDS.adult;
const dino = (over = {}) => ({
  uid: 'u' + (++uidN), speciesId: 'raptor', careCount: ADULT, xp: 0, ...over,
});

function freshState(over = {}) {
  const s = { coins: 100000, park: [], vault: [], ...over };
  setState(s);
  api.resetAcquired();
  return s;
}

/* ── THE FLOOR IS THE LOWER PARENT ───────────────────────────────────
   The rule everything else rests on. */
{
  const common = dino({ speciesId: 'compy' });
  const legendary = dino({ speciesId: 'rex' });
  check('a legendary paired with a common guarantees only a common',
    breedFloorRarity(legendary, common), 'common');
  check('and it reads the same either way round',
    breedFloorRarity(common, legendary), 'common');
  check('two uncommons guarantee an uncommon',
    breedFloorRarity(dino({ speciesId: 'raptor' }), dino({ speciesId: 'stego' })), 'uncommon');

  /* Over many rolls the mismatched pair must never produce the legendary
     parent's tier for free. Two steps is the ceiling, so from common the
     best reachable is rare. */
  let best = 0;
  for (let i = 0; i < 4000; i++) {
    best = Math.max(best, rarityIndex(breedRollRarity(legendary, common)));
  }
  ok('and the mismatch can never reach legendary', best < rarityIndex('legendary'));
  check('two tiers above the floor is the ceiling', best, rarityIndex('rare'));
}

/* ── Raising both is what breeds upward ──────────────────────────────── */
{
  const lazyA = dino({ careCount: ADULT }), lazyB = dino({ careCount: ADULT });
  const keenA = dino({ careCount: 900 }), keenB = dino({ careCount: 900 });
  ok('a well-raised pair has better odds', breedUpChance(keenA, keenB) > breedUpChance(lazyA, lazyB));

  const mixed = breedUpChance(dino({ speciesId: 'raptor' }), dino({ speciesId: 'stego' }));
  const same = breedUpChance(dino({ speciesId: 'raptor' }), dino({ speciesId: 'raptor' }));
  ok('and a matched pair better still', same > mixed);
  ok('the odds are always a real probability',
    breedUpChance(keenA, keenB) > 0 && breedUpChance(keenA, keenB) <= 1);
}

/* ── A matched pair breeds true ──────────────────────────────────────── */
{
  const a = dino({ speciesId: 'stego' }), b = dino({ speciesId: 'stego' });
  for (let i = 0; i < 50; i++) {
    check('two Stegosaurus make a Stegosaurus', breedChildSpecies(a, b, 'uncommon').id, 'stego');
    if (failures.length) break;
  }
  /* A step up lands outside both parents' tier, so it rolls fresh. */
  const up = breedChildSpecies(a, b, 'rare');
  ok('a step up rolls a species of the new tier', up && up.rarity === 'rare');
}

/* ── Mutation inheritance ────────────────────────────────────────────── */
{
  const plain = dino(), carrier = dino({ mutation: 'albino' });
  const other = dino({ mutation: 'melanistic' });
  check('two plain parents pass nothing on', breedMutChance(plain, dino()), 0);
  ok('one carrier is a real chance', breedMutChance(plain, carrier) > 0);
  ok('two matching carriers is the best chance',
    breedMutChance(carrier, dino({ mutation: 'albino' })) > breedMutChance(plain, carrier));
  ok('two different mutations is not a bonus',
    breedMutChance(carrier, other) <= breedMutChance(carrier, dino({ mutation: 'albino' })));
}

/* ── Who may breed ───────────────────────────────────────────────────── */
{
  const now = Date.now();
  check('an adult can', breedBlocker(dino(), now), null);
  check('a juvenile cannot', breedBlocker(dino({ careCount: GROWTH_THRESHOLDS.juvenile }), now), 'young');
  check('a hatchling cannot', breedBlocker(dino({ careCount: 0 }), now), 'young');
  check('one out on an expedition cannot', breedBlocker(dino({ busy: 'r1' }), now), 'away');
  check('one that bred today cannot', breedBlocker(dino({ bredAt: now - 1000 }), now), 'resting');
  check('but can again tomorrow',
    breedBlocker(dino({ bredAt: now - BREED_COOLDOWN_MS - 1 }), now), null);

  const s = freshState();
  s.park.push(dino(), dino({ careCount: 0 }));
  s.vault.push(dino());
  check('the pen draws on the park and the vault alike', breedEligible().length, 2);
}

/* ── Pairing ─────────────────────────────────────────────────────────── */
{
  const s = freshState();
  const a = dino({ speciesId: 'stego' }), b = dino({ speciesId: 'stego' });
  s.park.push(a);
  s.vault.push(b);

  const cost = breedCost(a, b);
  check('the price is the floor rarity', cost, BREED_COST.uncommon);

  const before = s.coins;
  const res = breedPair(a.uid, b.uid);
  ok('a vault animal can pair with a park one', res.ok);
  check('the coins are taken', s.coins, before - cost);
  check('an egg arrives', api.acquired().length, 1);
  ok('of the rolled rarity', api.acquired()[0].rarity === res.rarity);
  ok('both parents are stamped', !!a.bredAt && !!b.bredAt);
  check('and neither can go again today', breedBlocker(a, Date.now()), 'resting');
}

/* ── A REFUSED PAIRING COSTS NOTHING ─────────────────────────────────
   Every one of these must leave the coins and both parents untouched. */
{
  const cases = [
    ['a juvenile', () => [dino(), dino({ careCount: 1 })]],
    ['one already out', () => [dino(), dino({ busy: 'r1' })]],
    ['one resting', () => [dino(), dino({ bredAt: Date.now() })]],
  ];
  for (const [label, make] of cases) {
    const s = freshState();
    const [a, b] = make();
    s.park.push(a, b);
    const before = s.coins;
    const res = breedPair(a.uid, b.uid);
    check(`${label} is refused`, res.ok, false);
    check(`${label} costs no coins`, s.coins, before);
    ok(`${label} stamps nobody`, !a.bredAt || !b.bredAt);
    check(`${label} lays no egg`, api.acquired().length, 0);
  }

  /* And the same for the ones that are not about the animals. */
  const s = freshState({ coins: 1 });
  const a = dino(), b = dino();
  s.park.push(a, b);
  check('an unaffordable pairing is refused', breedPair(a.uid, b.uid).ok, false);
  check('and takes nothing', s.coins, 1);
  ok('and stamps nobody', !a.bredAt && !b.bredAt);

  const s2 = freshState();
  const c = dino();
  s2.park.push(c);
  check('an animal cannot pair with itself', breedPair(c.uid, c.uid).ok, false);
  check('nor with one that is gone', breedPair(c.uid, 'nope').ok, false);
  ok('and it is not stamped either way', !c.bredAt);
}

/* ── It is an egg source, not a dino source ─────────────────────────
   Breeding must go through the incubator like everything else, or it
   would be a way to skip the one wait the park is built around. */
{
  const s = freshState();
  const a = dino(), b = dino();
  s.park.push(a, b);
  const parkBefore = s.park.length, vaultBefore = s.vault.length;
  breedPair(a.uid, b.uid);
  check('no dino appears in the park', s.park.length, parkBefore);
  check('nor in the vault', s.vault.length, vaultBefore);
  check('only an egg', api.acquired().length, 1);
}

/* ── The page wires it up ────────────────────────────────────────────── */
{
  ok('the pen is on the eggs tab', /id="breedPen"/.test(src));
  ok('and rendered with it', /renderEggsTab\(\) \{ renderEventBanner\(\); renderBreeding\(\);/.test(src));
  ok('the picker reaches the pairing', /onBreedPair\(\)/.test(src));
  /* The odds have to be on screen before the coins are spent. */
  ok('the floor rarity is shown', /Guaranteed <b>\$\{escapeHtml\(floor\)\}/.test(src));
  ok('so is the chance of better', /chance of better/.test(src));
  ok('and the price is on the button', /Pair them &middot; \$\{cost\}/.test(src));

  /* The guest book draws before its fetch resolves: rendering only on
     success took the sign box down with a failed load, so a visitor
     could not leave a note because the notes would not load. */
  ok('the guest book renders before it loads',
     /renderGuestBook\(\);[\s\S]{0,20}?if \(_visitOwner\) loadGuestBook/.test(src));
}

console.log('');
if (failures.length) {
  console.log(`[dino-breeding] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[dino-breeding] ${passed} assertions passed.`);
console.log('');
