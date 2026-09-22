#!/usr/bin/env node
/* ══════════════════════════════════════════════
   SKULL CLICKER — click power and Blood Rush

     node server/scripts/test-skull-clickpower.js

   THE BUG THIS GUARDS AGAINST. getClickPower() has two terms: a base
   (click upgrades × prestige × achievements × perks) and a CPS-based one
   (Void Touch/Reality Shatter/Oblivion Grip -- a % of your CPS added to
   every click). Blood Rush's x100 used to multiply only the base term.
   The CPS-based term is fed by getCPS(), which is already multiplied by
   every CPS buff a progressed player has stacked, so for anyone with real
   CPS and a %-of-CPS click upgrade it dwarfs the base -- Blood Rush's
   x100 became a rounding error on the total, invisible on exactly the
   run where a player has played long enough to unlock it. Reported live:
   "I don't think blood rush is working properly" / "not seeing any
   effect when it's active".

   Extracted and run for real (not just pattern-matched), with its
   dependencies stubbed to controlled values -- getClickPower() is a pure
   function of them, so this is a real regression test, not a guess about
   what the source says.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const PAGE = path.join(REPO, 'games', 'skull-clicker', 'index.html');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

const page = fs.readFileSync(PAGE, 'utf8');

/* The exact function body, run with its free variables supplied as
   parameters -- so this is the real formula, not a re-implementation of
   it that could quietly drift from what actually ships. */
const src = page.match(/function getClickPower\(\)\s*\{[\s\S]*?\n\s*\}/);
ok('getClickPower() is found in the page', !!src);

function makeGetClickPower(vars) {
  const body = src[0]
    .replace(/^function getClickPower\(\)\s*\{/, '')
    .replace(/\}$/, '');
  const names = Object.keys(vars);
  const fn = new Function(...names, body);
  return () => fn(...names.map(n => vars[n]));
}

/* ── Baseline: no buffs, a modest click setup ────────────────────────── */
{
  const getClickPower = makeGetClickPower({
    clickBonus: 0, clickMulti: 1, cpsClickPct: 0, clickBuffMult: 1,
    getPrestigeMult: () => 1, achMult: () => 1, perkClickMult: () => 1,
    getCPS: () => 0,
  });
  check('plain click power with nothing bought', getClickPower(), 1);
}

/* ── Blood Rush multiplies the FULL click, not just the base term ───── */
{
  const vars = {
    clickBonus: 4, clickMulti: 3, cpsClickPct: 20,      // Void Touch + Reality Shatter + Oblivion Grip
    getPrestigeMult: () => 5, achMult: () => 2, perkClickMult: () => 1.5,
    getCPS: () => 1_000_000,                             // a progressed run's CPS
  };
  const normal = makeGetClickPower({ ...vars, clickBuffMult: 1 })();
  const rushed = makeGetClickPower({ ...vars, clickBuffMult: 100 })();
  check('Blood Rush is exactly 100x the unbuffed click, CPS term included', rushed, normal * 100);
}

/* ── THE BUG, reproduced: at high CPS, the old formula barely moved ──── */
{
  const vars = {
    clickBonus: 4, clickMulti: 3, cpsClickPct: 20,
    getPrestigeMult: () => 5, achMult: () => 2, perkClickMult: () => 1.5,
    getCPS: () => 1_000_000,
  };
  const base = (1 + vars.clickBonus) * vars.clickMulti * vars.getPrestigeMult() * vars.achMult() * vars.perkClickMult();
  const cpsTerm = vars.getCPS() * vars.cpsClickPct / 100;
  const oldFormulaBuffed = base * 100 + cpsTerm;          // Blood Rush only on `base`, per the old code
  const rushed = makeGetClickPower({ ...vars, clickBuffMult: 100 })();
  ok('the fix actually changes the outcome from the old (buggy) formula', rushed !== oldFormulaBuffed);
  const oldIncreasePct = (oldFormulaBuffed - (base + cpsTerm)) / (base + cpsTerm) * 100;
  ok('and the old formula really did fall far short of the promised x100 (9900%)',
     oldIncreasePct < 20);   // it managed about 11% here, nowhere close to what "x100" promises
}

/* ── Blood Rush still matters even with no CPS-click upgrade at all ──── */
{
  const vars = {
    clickBonus: 4, clickMulti: 3, cpsClickPct: 0,
    getPrestigeMult: () => 5, achMult: () => 2, perkClickMult: () => 1.5,
    getCPS: () => 1_000_000,
  };
  const normal = makeGetClickPower({ ...vars, clickBuffMult: 1 })();
  const rushed = makeGetClickPower({ ...vars, clickBuffMult: 100 })();
  check('with no %-of-CPS upgrade bought, it was already a clean 100x', rushed, normal * 100);
}

/* ── Wiring ───────────────────────────────────────────────────────────── */
{
  ok('clickBuffMult multiplies the whole return, not the base sub-term',
     /\(base \+ \(getCPS\(\) \* cpsClickPct \/ 100\)\) \* clickBuffMult/.test(page));
  ok('Blood Rush still sets a x100 multiplier for its duration',
     /clickBuffMult = 100;/.test(page) && /BLOOD RUSH/.test(page));
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[skull-clickpower] ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[skull-clickpower] ${passed} assertions passed.`);
console.log('');
