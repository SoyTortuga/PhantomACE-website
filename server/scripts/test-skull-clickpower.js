#!/usr/bin/env node
/* ══════════════════════════════════════════════
   SKULL CLICKER — click power and Blood Rush

     node server/scripts/test-skull-clickpower.js

   THE BUG THIS GUARDS AGAINST. getClickPower() has two terms: a base
   (click upgrades × prestige × achievements × perks × Reaping) and a
   CPS-based one (Void Touch/Reality Shatter/Oblivion Grip -- a % of your
   CPS added to every click). Blood Rush's x100 used to multiply only the
   base term. The CPS-based term is fed by getCPS(), which is already
   multiplied by every CPS buff a progressed player has stacked, so for
   anyone with real CPS and a %-of-CPS click upgrade it dwarfs the base --
   Blood Rush's x100 became a rounding error on the total, invisible on
   exactly the run where a player has played long enough to unlock it.
   Reported live: "I don't think blood rush is working properly".

   Blood Rush is now a timed buff (addTimedBuff with clickMult: 100) folded
   in by buffClickMult(), alongside the Cursed Garden and Hallowtide relic
   multipliers. The REAL functions -- getClickPower, buffClickMult,
   addTimedBuff, outBloodRush, buffScale -- are lifted out of the page and
   run together against the real break_infinity Decimal, with only their
   leaf dependencies stubbed to controlled values. So this is the shipped
   formula, not a re-implementation that could quietly drift from it.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const PAGE = path.join(REPO, 'games', 'skull-clicker', 'index.html');
const Decimal = createRequire(import.meta.url)(path.join(REPO, 'games', 'skull-clicker', 'break_infinity.min.js'));

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);
/* Float products of several multipliers can differ in the last ulp by order of operations. */
const near = (label, a, b) => ok(label + ' (' + a + ' ~ ' + b + ')', Math.abs(a - b) <= Math.abs(b) * 1e-12);

const page = fs.readFileSync(PAGE, 'utf8');

/* A function's full source, brace-matched (not a lazy regex that stops at
   the first closing brace of a nested block). The parameter list is skipped
   first, since a destructured parameter has braces of its own. */
function fnSource(name) {
  const at = page.search(new RegExp('function ' + name + '\\s*\\('));
  if (at < 0) return null;
  let p = page.indexOf('(', at), parens = 0;
  for (; p < page.length; p++) {
    if (page[p] === '(') parens++;
    else if (page[p] === ')' && --parens === 0) break;
  }
  let depth = 0;
  for (let j = page.indexOf('{', p); j < page.length; j++) {
    if (page[j] === '{') depth++;
    else if (page[j] === '}' && --depth === 0) return page.slice(at, j + 1);
  }
  return null;
}

const FNS = ['getClickPower', 'buffClickMult', 'addTimedBuff', 'outBloodRush', 'buffScale'];
const sources = Object.fromEntries(FNS.map(n => [n, fnSource(n)]));
for (const n of FNS) ok(`${n}() is found in the page`, !!sources[n]);

/* Every free variable the lifted functions read. Anything missing here is a
   ReferenceError at run time -- which is how a new multiplier sneaking into
   getClickPower() makes this test fail loudly instead of silently. */
const DEFAULTS = {
  clickBonus: 0, clickMulti: 1, cpsClickPct: 0,
  getPrestigeMult: () => 1, achMult: () => 1, perkClickMult: () => 1, metaClickMult: () => 1,
  gardenClickMult: () => 1, seasonRelicClickMult: () => 1,
  getCPS: () => new Decimal(0),
  pHas: () => false, renderBuffs: () => {},
};

function game(over = {}) {
  const vars = { ...DEFAULTS, ...over, Decimal, activeBuffs: [] };
  const names = Object.keys(vars);
  const body = FNS.map(n => sources[n]).join('\n') +
    '\nreturn { getClickPower, buffClickMult, addTimedBuff, outBloodRush, activeBuffs };';
  return new Function(...names, body)(...names.map(n => vars[n]));
}
const num = (d) => Number(d.toString());

/* ── Baseline: nothing bought ─────────────────────────────────────────── */
{
  const g = game();
  ok('getClickPower returns a Decimal', g.getClickPower() instanceof Decimal);
  check('plain click power with nothing bought', num(g.getClickPower()), 1);
}

/* ── Every multiplier in the base term applies ────────────────────────── */
{
  const g = game({ clickBonus: 4, clickMulti: 3, getPrestigeMult: () => 5, achMult: () => 2,
    perkClickMult: () => 1.5, metaClickMult: () => 1.24 });
  check('base = (1 + bonus) × multi × prestige × feats × perks × Reaping', num(g.getClickPower()), 5 * 3 * 5 * 2 * 1.5 * 1.24);
}

/* A progressed run: %-of-CPS click upgrades and a big CPS. */
const PROGRESSED = {
  clickBonus: 4, clickMulti: 3, cpsClickPct: 20,
  getPrestigeMult: () => 5, achMult: () => 2, perkClickMult: () => 1.5, metaClickMult: () => 1,
  getCPS: () => new Decimal(1_000_000),
};

/* ── Blood Rush, through the REAL buff path, multiplies the FULL click ── */
{
  const g = game(PROGRESSED);
  const normal = num(g.getClickPower());
  const out = g.outBloodRush();
  ok('Blood Rush announces itself', /BLOOD RUSH/.test(out.msg));
  const rush = g.activeBuffs.find(b => b.id === 'rush');
  ok('Blood Rush adds a timed click buff', !!rush && rush.clickMult === 100 && rush.endsAt > Date.now());
  check('buffClickMult reads it', g.buffClickMult(), 100);
  const rushed = num(g.getClickPower());
  check('Blood Rush is exactly 100x the unbuffed click, CPS term included', rushed, normal * 100);

  g.outBloodRush();
  check('a second Blood Rush refreshes rather than stacking to x10000', g.buffClickMult(), 100);
}

/* ── THE BUG, reproduced: at high CPS, the old formula barely moved ──── */
{
  const v = PROGRESSED;
  const base = (1 + v.clickBonus) * v.clickMulti * v.getPrestigeMult() * v.achMult() * v.perkClickMult();
  const cpsTerm = num(v.getCPS()) * v.cpsClickPct / 100;
  const oldFormulaBuffed = base * 100 + cpsTerm;          // Blood Rush only on `base`, per the old code
  const g = game(PROGRESSED);
  g.outBloodRush();
  const rushed = num(g.getClickPower());
  ok('the fix actually changes the outcome from the old (buggy) formula', rushed !== oldFormulaBuffed);
  const oldIncreasePct = (oldFormulaBuffed - (base + cpsTerm)) / (base + cpsTerm) * 100;
  ok('and the old formula really did fall far short of the promised x100 (9900%)', oldIncreasePct < 20);
}

/* ── Blood Rush still matters with no CPS-click upgrade at all ───────── */
{
  const g = game({ ...PROGRESSED, cpsClickPct: 0 });
  const normal = num(g.getClickPower());
  g.outBloodRush();
  check('with no %-of-CPS upgrade bought, it is a clean 100x', num(g.getClickPower()), normal * 100);
}

/* ── Garden and relic click bonuses also scale the whole click ───────── */
{
  const plain = num(game(PROGRESSED).getClickPower());
  const g = game({ ...PROGRESSED, gardenClickMult: () => 1.5, seasonRelicClickMult: () => 1.2 });
  near('garden × relic multiply the full click, CPS term included', num(g.getClickPower()), plain * 1.5 * 1.2);
  g.outBloodRush();
  near('and stack with Blood Rush', num(g.getClickPower()), plain * 1.5 * 1.2 * 100);
}

/* ── Everfrenzy doubles Blood Rush's duration, not its power ─────────── */
{
  const g = game({ ...PROGRESSED, pHas: (id) => id === 'everfrenzy' });
  const t0 = Date.now();
  g.outBloodRush();
  const rush = g.activeBuffs.find(b => b.id === 'rush');
  ok('Everfrenzy lasts twice as long (26s)', rush.endsAt - t0 >= 26000 && rush.endsAt - t0 < 27000);
  check('at the same x100', g.buffClickMult(), 100);
}

/* ── A debuff that cuts clicks folds in the same way ──────────────────── */
{
  const g = game(PROGRESSED);
  const plain = num(g.getClickPower());
  g.addTimedBuff({ id: 'curse', name: 'Curse', kind: 'debuff', clickMult: 0.5, durationMs: 1000 });
  check('a click debuff halves the full click', num(g.getClickPower()), plain * 0.5);
}

/* ── Big numbers: no overflow past the double ceiling ─────────────────── */
{
  const g = game({ ...PROGRESSED, getCPS: () => new Decimal('1e400') });
  g.outBloodRush();
  const p = g.getClickPower();
  ok('a 1e400-CPS run still yields a finite Decimal click', Number.isFinite(p.mantissa) && p.exponent >= 400);
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
