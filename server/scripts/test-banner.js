#!/usr/bin/env node
/* ══════════════════════════════════════════════
   PROFILE BANNER — item → variant → path mapping test

     node server/scripts/test-banner.js

   The banner cosmetic is granted generically (rare/mythic rarity + a name,
   no effect id), so bannerVariant in js/pages/profile.js must resolve every
   already-granted banner — including legacy Phamily Time tiers — to one of
   the three tiered images. It also has to work on the PUBLIC profile payload,
   which flattens meta.effect onto `effect`. Nobody's earned banner may map to
   nothing; a null item maps to no banner.

   The mapping now lives once in js/cosmetic-variants.js (function variantOf,
   aliased to bannerVariant). This extracts that real function and evaluates
   it, so the test tracks the shipped code.
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
const bannerVariant = (0, eval)(src.slice(start, end).trim() + '\nvariantOf;');

/* The fixed image contract (asset-manager produces these). */
const pathFor = (v) => (v ? '/assets/banners/banner-' + v + '.png' : null);

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  if (actual === expected) { passed++; return; }
  failures.push(`${label}\n      expected ${JSON.stringify(expected)}\n      got      ${JSON.stringify(actual)}`);
}

/* ── Legacy banners (rarity + name only) ─────────────────────────────── */
check('Watcher legacy rare → rare', bannerVariant({ rarity: 'rare', name: 'Profile Banner' }), 'rare');
check('Revenant legacy mythic → mythic', bannerVariant({ rarity: 'mythic', name: 'Profile Banner' }), 'mythic');
check('Eternal legacy "Exclusive Banner" → exclusive', bannerVariant({ rarity: 'mythic', name: 'Exclusive Banner' }), 'exclusive');
check('exclusive wins over non-mythic rarity', bannerVariant({ rarity: 'rare', name: 'Exclusive Banner' }), 'exclusive');

/* ── Public payload shape (flattened effect) and raw meta.effect ─────── */
check('public payload effect=exclusive → exclusive', bannerVariant({ rarity: 'rare', name: 'x', effect: 'exclusive' }), 'exclusive');
check('raw meta.effect=mythic → mythic', bannerVariant({ rarity: 'rare', name: 'x', meta: { effect: 'mythic' } }), 'mythic');
check('explicit effect=rare beats mythic rarity', bannerVariant({ rarity: 'mythic', name: 'x', effect: 'rare' }), 'rare');

/* ── Fallbacks — nothing earned is invisible ────────────────────────── */
check('unknown rarity, plain name → rare (floor)', bannerVariant({ rarity: 'common', name: 'Profile Banner' }), 'rare');
check('null item → null (no banner)', bannerVariant(null), null);

/* ── variant → path (the fixed 1200x280 contract) ───────────────────── */
check('rare path', pathFor(bannerVariant({ rarity: 'rare', name: 'Profile Banner' })), '/assets/banners/banner-rare.png');
check('mythic path', pathFor(bannerVariant({ rarity: 'mythic', name: 'Profile Banner' })), '/assets/banners/banner-mythic.png');
check('exclusive path', pathFor(bannerVariant({ rarity: 'mythic', name: 'Exclusive Banner' })), '/assets/banners/banner-exclusive.png');
check('null → no path', pathFor(bannerVariant(null)), null);

if (failures.length) {
  console.error(`\n✗ ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`✓ all ${passed} banner mapping checks passed`);
