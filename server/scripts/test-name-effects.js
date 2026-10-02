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

if (failures.length) {
  console.error(`\n✗ ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`✓ all ${passed} name-effect mapping checks passed`);
