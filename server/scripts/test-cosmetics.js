#!/usr/bin/env node
/* ══════════════════════════════════════════════
   SHARED COSMETICS RESOLVER — test suite

     node server/scripts/test-cosmetics.js

   Covers functions/api/cosmetics.js:
     - resolveEquippedCosmetics batches (one read per unique real user),
       excludes guests without a read, and resolves the equipped name-effect
       and banner to variants (including legacy rarity/name-only items);
     - its mapping stays identical to the client's variantOf() in
       js/cosmetic-variants.js (the two are separate copies by necessity — a
       browser <script> can't be imported server-side — so this asserts they
       agree across a matrix).
   ══════════════════════════════════════════════ */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  resolveEquippedCosmetics,
  nameEffectVariant as serverVariant,
  bannerPath,
} from '../../functions/api/cosmetics.js';

const here = dirname(fileURLToPath(import.meta.url));

/* Pull the client's variantOf out of the shared module and eval it. */
const cvSrc = readFileSync(join(here, '../../js/cosmetic-variants.js'), 'utf8');
const s = cvSrc.indexOf('function variantOf');
const e = cvSrc.indexOf('/* end variant mapping */');
// eslint-disable-next-line no-eval
const clientVariant = (0, eval)(cvSrc.slice(s, e).trim() + '\nvariantOf;');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), x = JSON.stringify(expected);
  if (a === x) { passed++; return; }
  failures.push(`${label}\n      expected ${x}\n      got      ${a}`);
}

/* ── Client / server mapping agreement ──────────────────────────────── */
const MATRIX = [
  null,
  { rarity: 'rare', name: 'Name Effect' },
  { rarity: 'mythic', name: 'Name Effect' },
  { rarity: 'mythic', name: 'Exclusive Name Effect' },
  { rarity: 'rare', name: 'Exclusive Banner' },
  { rarity: 'common', name: 'Profile Banner' },
  { rarity: 'rare', name: 'x', effect: 'exclusive' },
  { rarity: 'rare', name: 'x', meta: { effect: 'mythic' } },
  { rarity: 'mythic', name: 'x', effect: 'rare' },
  { name: '' },
];
for (let i = 0; i < MATRIX.length; i++) {
  check('client==server for case ' + i, serverVariant(MATRIX[i]), clientVariant(MATRIX[i]));
}

/* ── bannerPath ─────────────────────────────────────────────────────── */
check('bannerPath rare', bannerPath('rare'), '/assets/banners/banner-rare.png');
check('bannerPath null', bannerPath(null), null);

/* ── resolveEquippedCosmetics — mock KV ─────────────────────────────── */
const store = {
  inv_100: { items: [
      { id: 'ne1', type: 'name-effect', rarity: 'mythic', name: 'Name Effect' },
      { id: 'bn1', type: 'banner', rarity: 'mythic', name: 'Exclusive Banner' },
    ], equips: { profile: { 'name-effect': 'ne1', banner: 'bn1' } } },
  inv_200: { items: [
      { id: 'ne2', type: 'name-effect', rarity: 'rare', name: 'Name Effect' },
    ], equips: { profile: { 'name-effect': 'ne2' } } },
  inv_300: { items: [
      { id: 'bnX', type: 'banner', rarity: 'rare', name: 'Profile Banner' },
    ], equips: { profile: {} } },   // owns a banner but equips nothing
};
let reads = 0;
const env = { MARKETPLACE: { async get(key) { reads++; return store[key] || null; } } };

const res = await resolveEquippedCosmetics(env, ['100', '200', '300', '999', 'guest_abc', '100']);

check('user 100 name effect', res['100'].nameEffect, 'mythic');    // mythic rarity, plain name
check('user 100 banner', res['100'].banner, 'exclusive');          // "Exclusive Banner"
check('user 200 name effect', res['200'].nameEffect, 'rare');
check('user 200 banner (none equipped)', res['200'].banner, null);
check('user 300 nothing equipped', res['300'], { nameEffect: null, banner: null });
check('user 999 no inventory', res['999'], { nameEffect: null, banner: null });
check('guest excluded → nulls', res['guest_abc'], { nameEffect: null, banner: null });

/* Batched + guest-free: 100 (twice, deduped), 200, 300, 999 = 4 unique real
   ids = 4 reads. The guest is never read. */
check('batched: one read per unique real id, guests skipped', reads, 4);

if (failures.length) {
  console.error(`\n✗ ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`✓ all ${passed} cosmetics resolver checks passed`);
