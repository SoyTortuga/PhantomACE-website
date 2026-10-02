#!/usr/bin/env node
/* ══════════════════════════════════════════════
   MEMORY MATCH COSMETICS — test suite

     node server/scripts/test-memory-match-cosmetics.js

   - Every card back / emote set name resolves (getCosmeticId) to its own
     catalog key, never to the basic/bonus fallback or a neighbour's key.
   - Every card back has a .card-front.cb-<key> rule + ::after glyph; the
     November "Dead Harvest" ones stay on the black/grey/red/bone palette,
     with no box-shadow or side-border accents.
   - Every emote set has real channel emote URLs and differs from the rest.
   - A stored owned id (and a legacy key) survives the reload path
     (resolveEquipped).
   ══════════════════════════════════════════════ */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '../../games/memory-match/index.html'), 'utf8');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), x = JSON.stringify(expected);
  if (a === x) { passed++; return; }
  failures.push(`${label}\n      expected ${x}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

const script = src.slice(src.indexOf('<script>', src.indexOf('<body>')) + 8, src.lastIndexOf('</script>'));
const catalogSrc = script.slice(0, script.indexOf('let activeCardBack'));
const fnSrc = ['getCosmeticId', 'resolveEquipped'].map(n => {
  const start = script.indexOf('function ' + n + '(');
  let depth = 0, i = script.indexOf('{', start);
  for (; i < script.length; i++) {
    if (script[i] === '{') depth++;
    else if (script[i] === '}' && --depth === 0) break;
  }
  return script.slice(start, i + 1);
}).join('\n');
// eslint-disable-next-line no-eval
const MM = (0, eval)(`(function(){${catalogSrc}\n${fnSrc}\nreturn { CARD_BACKS, EMOTE_SETS, getCosmeticId, resolveEquipped };})()`);
const css = src.slice(src.indexOf('<style>'), src.indexOf('</style>'));

const NOVEMBER_CB = { wheat: '🌾', crow: '🐦‍⬛', sickle: '🦴', moon: '🌕' };
const NOVEMBER_EMOTE = ['barrow', 'harvest'];

/* ── Names resolve to their own key ─────────────────────────────────── */
for (const [key, def] of Object.entries(MM.CARD_BACKS)) {
  if (key === 'default') continue;
  check(`card back "${def.name}" → ${key}`, MM.getCosmeticId({ name: def.name }, 'cb'), key);
  check(`card back ${key} css class`, def.cssClass, 'cb-' + key);
  ok(`card back ${key} has a .card-front rule`, css.includes(`.card-front.cb-${key} {`));
  ok(`card back ${key} has an ::after glyph`, new RegExp(`\\.card-front\\.cb-${key}::after \\{ content: '[^']+'`).test(css));
}
for (const [key, def] of Object.entries(MM.EMOTE_SETS)) {
  if (key === 'default') continue;
  check(`emote set "${def.name}" → ${key}`, MM.getCosmeticId({ name: def.name }, 'emote'), key);
}
for (const k of Object.keys(NOVEMBER_CB)) {
  ok(`"${MM.CARD_BACKS[k].name}" is a "… Card Back" name`, / Card Back$/.test(MM.CARD_BACKS[k].name));
}
for (const k of NOVEMBER_EMOTE) {
  ok(`"${MM.EMOTE_SETS[k].name}" is a "… Emote Pack" name`, / Emote Pack$/.test(MM.EMOTE_SETS[k].name));
}

/* Every name the pass has ever handed out still maps where it did. */
const LEGACY = {
  'Basic Card Back': 'basic', 'Phamily Card Back': 'phamily', 'Rare Card Back': 'rare',
  'Legendary Card Back': 'legendary', 'Cobweb Card Back': 'cobweb', 'Crypt Card Back': 'crypt',
  'Bat Card Back': 'bat', 'Ghost Card Back': 'ghost', 'Card Back': 'basic',
};
for (const [n, k] of Object.entries(LEGACY)) check(`legacy "${n}" → ${k}`, MM.getCosmeticId({ name: n }, 'cb'), k);
const LEGACY_E = { 'Emote Pack': 'bonus', 'Premium Emote Pack': 'premium', 'Spooky Emote Pack': 'spooky', 'Haunted Emote Pack': 'haunted' };
for (const [n, k] of Object.entries(LEGACY_E)) check(`legacy "${n}" → ${k}`, MM.getCosmeticId({ name: n }, 'emote'), k);

/* ── November CSS: palette + banned properties ──────────────────────── */
for (const [k, glyph] of Object.entries(NOVEMBER_CB)) {
  const rules = css.split('\n').join(' ').match(new RegExp(`\\.card-front\\.cb-${k}(::after)? \\{[^}]*\\}`, 'g')) || [];
  check(`${k}: rule + ::after`, rules.length, 2);
  const body = rules.join(' ');
  ok(`${k}: ::after glyph is ${glyph}`, body.includes(`content: '${glyph}'`));
  ok(`${k}: has a gradient`, /gradient\(/.test(body));
  ok(`${k}: border colour set`, /border(-color)?:/.test(body));
  ok(`${k}: no box-shadow`, !/box-shadow/.test(body));
  ok(`${k}: no side borders`, !/border-(left|right)/.test(body));
  for (const hex of body.match(/#[0-9a-f]{3,6}\b/gi) || []) {
    const h = hex.length === 4 ? hex.slice(1).split('').map(c => c + c).join('') : hex.slice(1);
    const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
    const grey = Math.max(r, g, b) - Math.min(r, g, b) <= 24;
    const red = g <= 16 && b <= 16;
    ok(`${k}: ${hex} is black/grey/bone/red`, grey || red);
  }
  ok(`${k}: emoji glyph desaturated`, /filter: grayscale\(1\)/.test(rules[1] || ''));
}
ok('no box-shadow anywhere', !/box-shadow/.test(src));

/* ── Emote sets ─────────────────────────────────────────────────────── */
const sig = (set) => [...set.images].sort().join('|');
for (const k of NOVEMBER_EMOTE) {
  const set = MM.EMOTE_SETS[k];
  check(`${k}: 10 emotes`, set.images.length, 10);
  check(`${k}: an alt per emote`, set.alts.length, set.images.length);
  check(`${k}: no duplicate emotes`, new Set(set.images).size, set.images.length);
  ok(`${k}: all Twitch channel emote URLs`, set.images.every(u => /^https:\/\/static-cdn\.jtvnw\.net\/emoticons\/v2\/[\w]+\/default\/light\/3\.0$/.test(u)));
  for (const [other, os] of Object.entries(MM.EMOTE_SETS)) {
    if (other !== k) ok(`${k} differs from ${other}`, sig(os) !== sig(set));
  }
}

/* ── Reload path ────────────────────────────────────────────────────── */
const owned = [
  ...Object.keys(NOVEMBER_CB).map(k => ({ id: 'cardback-' + MM.CARD_BACKS[k].name.toLowerCase().replace(/ /g, '-'), type: 'cardback', name: MM.CARD_BACKS[k].name })),
  { id: 'cardback-cobweb-card-back', type: 'cardback', name: 'Cobweb Card Back' },
];
const ownedE = NOVEMBER_EMOTE.map(k => ({ id: 'emote-pack-' + k + '-emote-pack', type: 'emote-pack', name: MM.EMOTE_SETS[k].name }));
for (const item of owned) {
  const key = MM.getCosmeticId(item, 'cb');
  check(`reload by id ${item.id}`, MM.resolveEquipped(owned, item.id, 'cb'), { itemId: item.id, key });
  check(`reload by legacy key ${key}`, MM.resolveEquipped(owned, key, 'cb'), { itemId: item.id, key });
}
for (const item of ownedE) {
  const key = MM.getCosmeticId(item, 'emote');
  check(`reload emote by id ${item.id}`, MM.resolveEquipped(ownedE, item.id, 'emote'), { itemId: item.id, key });
  check(`reload emote by legacy key ${key}`, MM.resolveEquipped(ownedE, key, 'emote'), { itemId: item.id, key });
}
check('unowned November card back ignored', MM.resolveEquipped(owned.slice(4), 'cardback-hollow-moon-card-back', 'cb'), null);

if (failures.length) {
  console.error(`\n✗ ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`✓ all ${passed} memory match cosmetics checks passed`);
