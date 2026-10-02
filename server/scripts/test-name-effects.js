#!/usr/bin/env node
/* ══════════════════════════════════════════════
   NAME EFFECTS — item → visual-variant mapping test

     node server/scripts/test-name-effects.js

   The Name Effect cosmetic is granted generically: rare/mythic rarity plus a
   name ("Name Effect" / "Exclusive Name Effect"), with no effect id on the
   item. nameEffectVariant in js/auth.js turns whatever is in inventory —
   including LEGACY items already granted before this system existed — into
   one of the three visuals defined in css/components.css. Nobody's earned
   reward may resolve to nothing, so every case here must land on a variant.

   The mapping now lives once in js/cosmetic-variants.js (function variantOf,
   aliased to nameEffectVariant). This extracts that real function and
   evaluates it — the same "test the file's own copy" approach as
   test-phamily-rewards.js — so the test tracks the shipped code.
   ══════════════════════════════════════════════ */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '../../js/cosmetic-variants.js'), 'utf8');

const start = src.indexOf('function variantOf');
const end = src.indexOf('/* end variant mapping */');
if (start === -1 || end === -1 || end < start) {
  console.error('Could not locate variantOf in js/cosmetic-variants.js — markers moved?');
  process.exit(1);
}
// eslint-disable-next-line no-eval
const nameEffectVariant = (0, eval)(src.slice(start, end).trim() + '\nvariantOf;');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  if (actual === expected) { passed++; return; }
  failures.push(`${label}\n      expected ${JSON.stringify(expected)}\n      got      ${JSON.stringify(actual)}`);
}

/* ── Legacy items (rarity + name only, no effect id) ─────────────────── */
check('Sentinel legacy rare → rare',
  nameEffectVariant({ rarity: 'rare', name: 'Name Effect' }), 'rare');
check('Wraith legacy mythic → mythic',
  nameEffectVariant({ rarity: 'mythic', name: 'Name Effect' }), 'mythic');
check('Eternal legacy "Exclusive Name Effect" → exclusive',
  nameEffectVariant({ rarity: 'mythic', name: 'Exclusive Name Effect' }), 'exclusive');
check('exclusive wins even if rarity is not mythic',
  nameEffectVariant({ rarity: 'rare', name: 'Exclusive Name Effect' }), 'exclusive');

/* ── Forward-looking meta.effect id (if future grants stamp one) ─────── */
check('meta.effect exclusive → exclusive',
  nameEffectVariant({ rarity: 'rare', name: 'Whatever', meta: { effect: 'exclusive' } }), 'exclusive');
check('meta.effect mythic → mythic',
  nameEffectVariant({ rarity: 'rare', name: 'Whatever', meta: { effect: 'mythic' } }), 'mythic');
check('meta.effect rare → rare',
  nameEffectVariant({ rarity: 'mythic', name: 'Whatever', meta: { effect: 'rare' } }), 'rare');

/* ── Fallbacks — nothing earned is ever invisible ───────────────────── */
check('unknown rarity, plain name → rare (visible floor)',
  nameEffectVariant({ rarity: 'common', name: 'Name Effect' }), 'rare');
check('no rarity, no name → rare',
  nameEffectVariant({ name: '' }), 'rare');
check('null item → null (no effect to apply)',
  nameEffectVariant(null), null);

/* ── Halloween themed variants (meta.theme='halloween') ──────────────── */
check('halloween rare → halloween-rare',
  nameEffectVariant({ rarity: 'rare', name: 'Name Effect', meta: { theme: 'halloween' } }), 'halloween-rare');
check('halloween mythic → halloween-mythic',
  nameEffectVariant({ rarity: 'mythic', name: 'Name Effect', meta: { theme: 'halloween' } }), 'halloween-mythic');
check('halloween "Exclusive Name Effect" → halloween-exclusive',
  nameEffectVariant({ rarity: 'mythic', name: 'Exclusive Name Effect', meta: { theme: 'halloween' } }), 'halloween-exclusive');
check('halloween exclusive via meta.effect → halloween-exclusive',
  nameEffectVariant({ rarity: 'rare', name: 'Whatever', meta: { theme: 'halloween', effect: 'exclusive' } }), 'halloween-exclusive');
check('halloween theme flattened onto item.theme (public payload) → halloween-mythic',
  nameEffectVariant({ rarity: 'mythic', name: 'Name Effect', theme: 'halloween' }), 'halloween-mythic');
check('halloween floor: unknown rarity, plain name → halloween-rare',
  nameEffectVariant({ rarity: 'common', name: 'Name Effect', meta: { theme: 'halloween' } }), 'halloween-rare');
check('no theme → plain tier unchanged (mythic)',
  nameEffectVariant({ rarity: 'mythic', name: 'Name Effect' }), 'mythic');

/* ── Dead Harvest themed variants (meta.theme='harvest') ─────────────── */
check('harvest rare → harvest-rare',
  nameEffectVariant({ rarity: 'rare', name: 'Name Effect', meta: { theme: 'harvest' } }), 'harvest-rare');
check('harvest mythic → harvest-mythic',
  nameEffectVariant({ rarity: 'mythic', name: 'Name Effect', meta: { theme: 'harvest' } }), 'harvest-mythic');
check('harvest "Exclusive Name Effect" → harvest-exclusive',
  nameEffectVariant({ rarity: 'mythic', name: 'Exclusive Name Effect', meta: { theme: 'harvest' } }), 'harvest-exclusive');
check('harvest exclusive via meta.effect → harvest-exclusive',
  nameEffectVariant({ rarity: 'rare', name: 'Whatever', meta: { theme: 'harvest', effect: 'exclusive' } }), 'harvest-exclusive');
check('harvest theme flattened onto item.theme (public payload) → harvest-mythic',
  nameEffectVariant({ rarity: 'mythic', name: 'Name Effect', theme: 'harvest' }), 'harvest-mythic');
check('harvest floor: unknown rarity, plain name → harvest-rare',
  nameEffectVariant({ rarity: 'common', name: 'Name Effect', meta: { theme: 'harvest' } }), 'harvest-rare');

/* ── Still-unknown themes fall back to the plain tier ───────────────── */
for (const theme of ['christmas', 'Harvest', 'harvest ', 'dead harvest', 'november']) {
  check(`unknown theme ${JSON.stringify(theme)} → plain mythic`,
    nameEffectVariant({ rarity: 'mythic', name: 'Name Effect', meta: { theme } }), 'mythic');
}

/* ── Every themed variant the mapping can emit has CSS in components.css,
   animated tiers gated behind .name-fx-animate and dropped under
   prefers-reduced-motion. ─────────────────────────────────────────── */
const css = readFileSync(join(here, '../../css/components.css'), 'utf8').replace(/\r\n/g, '\n');
const esc = (t) => t.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
const rmBlocks = css.split('@media (prefers-reduced-motion: reduce)').slice(1).map(b => b.slice(0, b.indexOf('\n}')));
for (const theme of ['halloween', 'harvest']) {
  for (const tier of ['rare', 'mythic', 'exclusive']) {
    const cls = `.name-fx-${theme}-${tier}`;
    check(`${cls} has a rule`, new RegExp(esc(cls) + '\\s*\\{').test(css), true);
  }
  for (const tier of ['mythic', 'exclusive']) {
    const anim = `.name-fx-${theme}-${tier}.name-fx-animate`;
    check(`${anim} animates`, new RegExp(esc(anim) + '\\s*\\{\\s*animation:').test(css), true);
    check(`${anim} dropped under reduced motion`, rmBlocks.some(b => b.includes(anim)), true);
  }
}
const harvestStart = css.lastIndexOf('/*', css.indexOf('Dead Harvest themed name effects'));
const harvestCss = css.slice(harvestStart, css.lastIndexOf('/*', css.indexOf('Leaderboard row banner backdrop')))
  .replace(/\/\*[\s\S]*?\*\//g, '');
check('harvest CSS block found', harvestCss.length > 0, true);
check('harvest CSS has no box-shadow', /box-shadow/.test(harvestCss), false);
check('harvest CSS uses no hardcoded hex', /#[0-9a-fA-F]{3,8}\b/.test(harvestCss), false);
check('harvest loops are smooth drifts, not stepped flicker', /steps\(/.test(harvestCss), false);
check('harvest exclusive keeps gold on a banner leaderboard row',
  css.includes('.lb-row.has-banner .lb-name-text.name-fx-harvest-exclusive'), true);

if (failures.length) {
  console.error(`\n✗ ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`✓ all ${passed} name-effect mapping checks passed`);
