#!/usr/bin/env node
/* ══════════════════════════════════════════════
   DINO PARK — trade-up

     node server/scripts/test-dino-trade-up.js

   Five of one rarity for one of the next, on two tracks: five UNMUTATED
   for an unmutated, five MUTATED for a mutated. The tracks are separate so
   that mutated dinosaurs — worth far more — cannot be laundered through a
   pile of plain ones.

   THE FUNCTIONS ARE LIFTED OUT AND RUN, not pattern-matched. Dino Park is
   one HTML file with no module boundary, so the temptation is to assert
   that the source contains the right-looking text; that passes just as
   happily when the logic is wrong. These are pulled out by name and
   executed against stub state instead, so what is checked is behaviour.

   THE COOLDOWN REMAP IS THE SUBTLE ONE. Cooldowns are keyed by park index
   ('feed_3'), so removing a dinosaur renumbers every one after it. The
   single-removal paths deleted the departing index and left the rest,
   which quietly handed one dinosaur's cooldown to another; taking five at
   once would scramble a park. removeDinos remaps the survivors, and the
   older callers now go through it too.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const page = fs.readFileSync(path.join(REPO, 'games', 'dino-park', 'index.html'), 'utf8');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

/* Source of one top-level function, by brace matching from its opening. */
function fnSource(name) {
  const start = page.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`no function ${name}`);
  let depth = 0, i = page.indexOf('{', start);
  for (let j = i; j < page.length; j++) {
    if (page[j] === '{') depth++;
    else if (page[j] === '}') { depth--; if (depth === 0) return page.slice(start, j + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}
function literal(name) {
  const i = page.indexOf(`const ${name} = [`) >= 0
    ? page.indexOf(`const ${name} = [`) : page.indexOf(`const ${name}=[`);
  const end = page.indexOf('];', i);
  return page.slice(page.indexOf('[', i), end + 1);
}

/* ── The rarity ladder ───────────────────────────────────────────────── */
const RARITY_ORDER = eval(literal('RARITY_ORDER'));
const tradeUpRarity = eval(`(${fnSource('tradeUpRarity')})`);
{
  check('common trades into uncommon', tradeUpRarity('common'), 'uncommon');
  check('uncommon into rare', tradeUpRarity('uncommon'), 'rare');
  check('rare into epic', tradeUpRarity('rare'), 'epic');
  check('epic into legendary', tradeUpRarity('epic'), 'legendary');
  /* Nothing sits above legendary, so it trades into itself — the reward at
     the top is the guaranteed mutation rather than a tier, which keeps
     legendaries from being a dead end for the 1105-entry mutation dex. */
  check('legendary into legendary', tradeUpRarity('legendary'), 'legendary');
  check('and an unknown rarity is refused rather than guessed at',
        tradeUpRarity('mythic'), null);
}

/* ── The reweighted mutation roll ────────────────────────────────────── */
{
  const cost = /const TRADE_UP_COST = (\d+);/.exec(page);
  check('a trade-up costs five', cost && Number(cost[1]), 5);

  const SPECIES_DEF = { t1: { p: '#C8A060' } };
  const RARE_MUTS = { t1: ['Rare'] };
  const SPECIAL_MUTS = { t1: ['Special'] };
  const MUTATIONS = { albino: 1, melanistic: 1, golden: 1, crystal: 1,
                      volcanic: 1, phantomace: 1, spectral: 1, toxic: 1 };
  const pickSwaps = () => [{ id: 'sw1' }, { id: 'sw2' }, { id: 'sw3' }];
  const ctx = { SPECIES_DEF, RARE_MUTS, SPECIAL_MUTS, MUTATIONS, pickSwaps, Math };
  const make = (name) => new Function(...Object.keys(ctx),
    `${fnSource(name)}; return ${name};`)(...Object.values(ctx));

  const tradeUp = make('rollMutationTradeUp');
  const egg = make('rollMutationGuaranteed');

  const tally = (fn) => {
    const t = { rare: 0, special: 0, swap: 0, global: 0, none: 0 };
    for (let i = 0; i < 40000; i++) {
      const m = fn('t1');
      if (m === 'rare_t1') t.rare++;
      else if (m === 'sp_t1') t.special++;
      else if (/^sw\d$/.test(m)) t.swap++;
      else if (m in MUTATIONS) t.global++;
      else t.none++;
    }
    return t;
  };
  const t = tally(tradeUp), g = tally(egg);

  ok('a trade-up mutation is never absent', t.none === 0);
  ok('and neither is a guaranteed one', g.none === 0);

  /* THE POINT OF THE SEPARATE ROLL. Guaranteed-mutation eggs keep the
     ordinary relative odds on purpose; the trade-up is allowed to beat
     them because it costs five already-mutated dinosaurs. If these ever
     converge, the mutated track is pure loss. */
  ok('rare mutations are far likelier from a trade-up than from an egg',
     t.rare > g.rare * 4);
  ok('special mutations likelier too', t.special > g.special * 1.5);
  ok('paid for out of the colour swaps, not the globals',
     t.swap < g.swap && Math.abs(t.global - g.global) < g.global * 0.15);
  /* Still a roll, not a guarantee: a rare must stay the uncommon case. */
  ok('but a rare is still the minority outcome', t.rare < 40000 * 0.35);
}

/* ── Removal remaps the cooldowns it does not delete ─────────────────── */
{
  /* Bound per scenario, because the function closes over `state`. */
  const bind = (state) => new Function('state', `
    let selectedDinoIdx, collSelectedIdx;
    ${fnSource('removeDinos')}
    return removeDinos;
  `)(state);

  const s1 = {
    park: ['a', 'b', 'c', 'd', 'e'],
    vault: ['v0', 'v1', 'v2'],
    cooldowns: { feed_0: 10, play_0: 11, feed_1: 20, feed_2: 30, feed_3: 40, feed_4: 50 },
  };
  const removed = bind(s1)([{ source: 'park', idx: 0 }, { source: 'park', idx: 1 },
                            { source: 'park', idx: 3 }, { source: 'vault', idx: 1 }]);

  check('the survivors are the ones not picked', s1.park, ['c', 'e']);
  check('and the vault lost only its pick', s1.vault, ['v0', 'v2']);
  check('everything picked comes back', removed.sort(), ['a', 'b', 'd', 'v1'].sort());

  /* 'c' was park index 2 and is now 0; 'e' was 4 and is now 1. Their
     cooldowns have to follow them, and nobody else's may arrive. */
  check('cooldowns follow their dinosaur down the array',
        s1.cooldowns, { feed_0: 30, feed_1: 50 });

  /* Multi-digit indices are where a naive endsWith('_1') match goes wrong. */
  const s2 = {
    park: new Array(12).fill(0).map((_, i) => 'd' + i),
    vault: [],
    cooldowns: { feed_1: 1, feed_11: 11, feed_10: 10 },
  };
  bind(s2)([{ source: 'park', idx: 0 }]);
  check('and a two-digit index is not confused with a one-digit one',
        s2.cooldowns, { feed_0: 1, feed_10: 11, feed_9: 10 });
}

/* ── The rules live in the action, not only in the render ────────────── */
{
  const pick = fnSource('toggleTradeUpPick');
  /* A dimmed card is a drawing. With the check only in the render, a stale
     card could put a rare among four commons, reach five, and light up a
     button that performTradeUp would then refuse. */
  ok('picking checks the track', /tradeUpEligible\(entry\.dino, tradeUpTrack\)/.test(pick));
  ok('picking checks the rarity', /got !== want/.test(pick));
  ok('and it cannot exceed the cost', /tradeUpPicks\.length >= TRADE_UP_COST/.test(pick));

  const perform = fnSource('performTradeUp');
  ok('the exchange re-resolves against live state', /tradeUpEntries\(\)/.test(perform));
  ok('and re-checks rarity before consuming anything',
     /rarities\.some\(r => r !== from\)/.test(perform));
  ok('and bails on a stale selection', /picked\.some\(e => !e\)/.test(perform));
  /* Order matters: nothing may be destroyed before the checks have run. */
  ok('nothing is removed until the checks have passed',
     perform.indexOf('removeDinos') > perform.indexOf('rarities.some'));

  /* Both tracks must reach the player, and the mutated one must use the
     reweighted roll rather than the egg roll. */
  ok('the mutated track uses the reweighted roll', /rollMutationTradeUp\(spec\.id\)/.test(perform));
  ok('and the top of the ladder still guarantees a mutation',
     /to === from \? rollMutationGuaranteed\(spec\.id\) : null/.test(perform));

  ok('a new species is recorded in the dex', /state\.discovered\.push\(spec\.id\)/.test(perform));
  ok('and a new mutation is too', /state\.discoveredMutations\.push\(mk\)/.test(perform));
}

/* ── The older removal paths go through the same helper ──────────────── */
{
  /* This is the bug the helper exists for. If either of these grows its
     own splice-and-delete again, cooldowns start drifting between
     dinosaurs and nothing says so. */
  ok('no removal path deletes cooldowns by suffix any more',
     !/k\.endsWith\('_' \+ idx\)/.test(page));
  ok('moving to the vault goes through removeDinos',
     /removeDinos\(\[\{ source: 'park', idx \}\]\)/.test(page));
  ok('and so does listing on the marketplace',
     /removeDinos\(\[\{ source, idx \}\]\)/.test(page));
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[dino-trade-up] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[dino-trade-up] ${passed} assertions passed.`);
console.log('');
