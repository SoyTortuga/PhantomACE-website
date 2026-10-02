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
  KNOWN_THEMES,
  knownTheme,
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
  { rarity: 'rare', name: 'Name Effect', meta: { theme: 'halloween' } },
  { rarity: 'mythic', name: 'Exclusive Banner', meta: { theme: 'halloween' } },
  { rarity: 'rare', name: 'x', theme: 'halloween', effect: 'mythic' },
  { rarity: 'common', name: 'Name Effect', meta: { theme: 'halloween' } },
  { rarity: 'mythic', name: 'x', meta: { theme: 'other' } },
  { rarity: 'rare', name: 'Name Effect', meta: { theme: 'harvest' } },
  { rarity: 'mythic', name: 'Name Effect', meta: { theme: 'harvest' } },
  { rarity: 'mythic', name: 'Exclusive Banner', meta: { theme: 'harvest' } },
  { rarity: 'rare', name: 'x', theme: 'harvest', effect: 'exclusive' },
  { rarity: 'common', name: 'Profile Banner', theme: 'harvest' },
];
const UNKNOWN_THEMES = [
  'other', 'christmas', 'Halloween', 'halloween ', 'hallo ween', 'spooky season',
  '"><img src=x onerror=alert(1)>', '../evil', '__proto__', 'constructor', 'toString',
  42, true, { toString: () => 'halloween' }, ['halloween'],
  'Harvest', 'harvest ', 'dead harvest', 'dead-harvest', 'november', 'HARVEST',
  { toString: () => 'harvest' }, ['harvest'],
];
for (const theme of UNKNOWN_THEMES) {
  MATRIX.push({ rarity: 'mythic', name: 'Name Effect', meta: { theme } });
  MATRIX.push({ rarity: 'rare', name: 'Exclusive Banner', theme });
}
for (let i = 0; i < MATRIX.length; i++) {
  check('client==server for case ' + i, serverVariant(MATRIX[i]), clientVariant(MATRIX[i]));
}

/* ── KNOWN_THEMES whitelist ─────────────────────────────────────────── */
const clientThemes = (0, eval)(cvSrc.slice(s, e).trim() + '\nKNOWN_THEMES;');
check('KNOWN_THEMES identical client/server', [...clientThemes], [...KNOWN_THEMES]);
check('KNOWN_THEMES is halloween + harvest', [...KNOWN_THEMES], ['halloween', 'harvest']);

for (const theme of UNKNOWN_THEMES) {
  const label = JSON.stringify(String(theme));
  check(`unknown theme ${label} → plain mythic (server)`,
    serverVariant({ rarity: 'mythic', name: 'Name Effect', meta: { theme } }), 'mythic');
  check(`unknown theme ${label} → plain mythic (client)`,
    clientVariant({ rarity: 'mythic', name: 'Name Effect', meta: { theme } }), 'mythic');
  check(`unknown flattened theme ${label} → plain exclusive (server)`,
    serverVariant({ rarity: 'rare', name: 'Exclusive Banner', theme }), 'exclusive');
  check(`unknown flattened theme ${label} → plain exclusive (client)`,
    clientVariant({ rarity: 'rare', name: 'Exclusive Banner', theme }), 'exclusive');
  check(`knownTheme(${label}) → null`, knownTheme(theme), null);
}
check('known theme still themed (server)',
  serverVariant({ rarity: 'rare', name: 'Name Effect', meta: { theme: 'halloween' } }), 'halloween-rare');
check('known theme still themed (client)',
  clientVariant({ rarity: 'rare', name: 'Name Effect', meta: { theme: 'halloween' } }), 'halloween-rare');
check('knownTheme(halloween)', knownTheme('halloween'), 'halloween');
for (const [item, want] of [
  [{ rarity: 'rare', name: 'Name Effect', meta: { theme: 'harvest' } }, 'harvest-rare'],
  [{ rarity: 'mythic', name: 'Name Effect', meta: { theme: 'harvest' } }, 'harvest-mythic'],
  [{ rarity: 'mythic', name: 'Exclusive Name Effect', meta: { theme: 'harvest' } }, 'harvest-exclusive'],
  [{ rarity: 'rare', name: 'Exclusive Banner', theme: 'harvest' }, 'harvest-exclusive'],
  [{ rarity: 'common', name: 'Profile Banner', meta: { theme: 'harvest' } }, 'harvest-rare'],
]) {
  check(`harvest ${JSON.stringify(item)} (server)`, serverVariant(item), want);
  check(`harvest ${JSON.stringify(item)} (client)`, clientVariant(item), want);
}
check('knownTheme(harvest)', knownTheme('harvest'), 'harvest');
check('knownTheme(undefined)', knownTheme(undefined), null);

/* Every variant either side can produce must be a valid single class token —
   a space here is what threw in classList.add and killed forum controls. */
for (const item of MATRIX) {
  const v = clientVariant(item);
  if (v !== null && !/^[a-z0-9-]+$/.test(v)) failures.push(`variant ${JSON.stringify(v)} is not a safe class token`);
  else passed++;
}

/* ── bannerPath ─────────────────────────────────────────────────────── */
check('bannerPath rare', bannerPath('rare'), '/assets/banners/banner-rare.png');
check('bannerPath null', bannerPath(null), null);
check('bannerPath halloween-mythic', bannerPath('halloween-mythic'), '/assets/banners/banner-halloween-mythic.png');
check('bannerPath halloween-exclusive', bannerPath('halloween-exclusive'), '/assets/banners/banner-halloween-exclusive.png');
for (const tier of ['rare', 'mythic', 'exclusive']) {
  check(`bannerPath harvest-${tier}`, bannerPath(`harvest-${tier}`), `/assets/banners/banner-harvest-${tier}.png`);
}
/* The client's bannerPath is the same generic template — no theme hardcoded. */
const cbs = cvSrc.indexOf('function bannerPath');
const cbe = cvSrc.indexOf('}', cvSrc.indexOf('return', cbs)) + 1;
// eslint-disable-next-line no-eval
const clientBannerPath = (0, eval)('(' + cvSrc.slice(cbs, cbe) + ')');
for (const v of [null, 'rare', 'halloween-mythic', 'harvest-rare', 'harvest-mythic', 'harvest-exclusive']) {
  check(`client bannerPath(${v}) == server`, clientBannerPath(v), bannerPath(v));
}

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
  inv_400: { items: [            // October themed grants (meta.theme='halloween')
      { id: 'hne', type: 'name-effect', rarity: 'mythic', name: 'Name Effect', meta: { theme: 'halloween' } },
      { id: 'hbn', type: 'banner', rarity: 'rare', name: 'Exclusive Banner', meta: { theme: 'halloween' } },
    ], equips: { profile: { 'name-effect': 'hne', banner: 'hbn' } } },
  inv_500: { items: [            // a month with no CSS/art, and a malformed theme
      { id: 'xne', type: 'name-effect', rarity: 'mythic', name: 'Name Effect', meta: { theme: 'christmas' } },
      { id: 'xbn', type: 'banner', rarity: 'rare', name: 'Profile Banner', meta: { theme: 'spooky season' } },
    ], equips: { profile: { 'name-effect': 'xne', banner: 'xbn' } } },
  inv_600: { items: [            // November themed grants (meta.theme='harvest')
      { id: 'vne', type: 'name-effect', rarity: 'rare', name: 'Name Effect', meta: { theme: 'harvest' } },
      { id: 'vbn', type: 'banner', rarity: 'mythic', name: 'Profile Banner', meta: { theme: 'harvest' } },
    ], equips: { profile: { 'name-effect': 'vne', banner: 'vbn' } } },
};
let reads = 0;
const env = { MARKETPLACE: { async get(key) { reads++; return store[key] || null; } } };

const res = await resolveEquippedCosmetics(env, ['100', '200', '300', '400', '500', '600', '999', 'guest_abc', '100']);

check('user 100 name effect', res['100'].nameEffect, 'mythic');    // mythic rarity, plain name
check('user 100 banner', res['100'].banner, 'exclusive');          // "Exclusive Banner"
check('user 200 name effect', res['200'].nameEffect, 'rare');
check('user 200 banner (none equipped)', res['200'].banner, null);
check('user 300 nothing equipped', res['300'], { nameEffect: null, banner: null });
check('user 400 halloween name effect', res['400'].nameEffect, 'halloween-mythic');
check('user 400 halloween banner', res['400'].banner, 'halloween-exclusive');
check('user 500 unknown theme → plain mythic', res['500'].nameEffect, 'mythic');
check('user 500 malformed theme → plain rare', res['500'].banner, 'rare');
check('user 600 harvest name effect', res['600'].nameEffect, 'harvest-rare');
check('user 600 harvest banner', res['600'].banner, 'harvest-mythic');
check('user 999 no inventory', res['999'], { nameEffect: null, banner: null });
check('guest excluded → nulls', res['guest_abc'], { nameEffect: null, banner: null });

/* Batched + guest-free: 100 (twice, deduped), 200, 300, 400, 500, 600, 999
   = 7 unique real ids = 7 reads. The guest is never read. */
check('batched: one read per unique real id, guests skipped', reads, 7);

if (failures.length) {
  console.error(`\n✗ ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`✓ all ${passed} cosmetics resolver checks passed`);
