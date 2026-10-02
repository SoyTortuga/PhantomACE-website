#!/usr/bin/env node
/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   SKULL CLICKER COSMETICS â€” test suite

     node server/scripts/test-skull-cosmetics.js

   - Every skull skin and click effect resolves to its own look, by owned
     item id AND by name keyword (getCosmeticThemeId), with no keyword of
     one cosmetic swallowing another's name.
   - Equip state stored as the real id, or as a legacy theme key, resolves
     through normalizeEquipped / equippedThemeKey; unowned â†’ default.
   - Each look has its CSS rule; new rules stay black/grey/red/white, carry
     no box-shadow or side borders, and animations have a reduced-motion
     guard.
   - The server equips/unequips the new items by id and by legacy key.
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { onRequestPost } from '../../functions/api/inventory.js';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '../../games/skull-clicker/index.html'), 'utf8');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), x = JSON.stringify(expected);
  if (a === x) { passed++; return; }
  failures.push(`${label}\n      expected ${x}\n      got      ${a}`);
}

function block(startToken) {
  const start = src.indexOf(startToken);
  if (start === -1) throw new Error('not found: ' + startToken);
  let depth = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) break;
  }
  return src.slice(start, i + 1);
}

const code = [
  block('const SKULL_THEMES = {') + ';',
  block('const CLICK_EFFECTS = {') + ';',
  block('function ownedForSlot('),
  block('function normalizeEquipped('),
  block('function equippedThemeKey('),
  block('function getCosmeticThemeId('),
].join('\n');
// eslint-disable-next-line no-eval
const G = (0, eval)(`(function(){
  let ownedCosmetics = [];
  let equippedCosmetics = { 'skull-theme': 'default', 'click-effect': 'default' };
  ${code}
  return {
    SKULL_THEMES, CLICK_EFFECTS, ownedForSlot, normalizeEquipped, equippedThemeKey, getCosmeticThemeId,
    setOwned(v) { ownedCosmetics = v; },
    equip(slot, id) { equippedCosmetics[slot] = id; },
  };
})()`);

const NEW_SKINS = {
  hollowmoon: 'Hollow Moon Skull',
  chaff: 'Chaff Field Skull',
  crowfeather: 'Crowfeather Skull',
};
const NEW_EFFECTS = { bonesickle: 'Bone Sickle Slash' };
const OLD_KEYWORDS = ['blood', 'crimson', 'void', 'chaos', 'eternal', 'darkness', 'bonewhite', 'graveash', 'reaper', 'wraith', 'wisp'];

/* â”€â”€ Definitions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
for (const [id, name] of Object.entries(NEW_SKINS)) {
  check(`skin ${id} defined`, G.SKULL_THEMES[id] && G.SKULL_THEMES[id].name, name);
  check(`skin ${id} cssClass`, G.SKULL_THEMES[id].cssClass, 'theme-' + id);
}
for (const [id, name] of Object.entries(NEW_EFFECTS)) {
  check(`effect ${id} defined`, G.CLICK_EFFECTS[id] && G.CLICK_EFFECTS[id].name, name);
  check(`effect ${id} cssClass`, G.CLICK_EFFECTS[id].cssClass, 'click-effect-' + id);
}
for (const name of [...Object.values(NEW_SKINS), ...Object.values(NEW_EFFECTS)]) {
  const hit = OLD_KEYWORDS.filter(k => name.toLowerCase().includes(k));
  check(`"${name}" carries no existing keyword`, hit, []);
}
for (const name of Object.values(NEW_EFFECTS)) {
  check(`"${name}" is not caught by the skin-name fallback`,
    ['skin', 'skull', 'theme'].some(w => name.toLowerCase().includes(w)), false);
}
for (const name of Object.values(NEW_SKINS)) {
  check(`"${name}" is not caught by the effect-name fallback`,
    ['effect', 'click', 'wisp'].some(w => name.toLowerCase().includes(w)), false);
}

/* â”€â”€ Every key resolves to itself, by name and by id â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
for (const [table, type] of [[G.SKULL_THEMES, 'skull-skin'], [G.CLICK_EFFECTS, 'click-effect']]) {
  for (const [key, def] of Object.entries(table)) {
    if (key === 'default') continue;
    check(`${type} "${def.name}" by name â†’ ${key}`, G.getCosmeticThemeId({ id: 'reward-xyz', name: def.name }), key);
    check(`${type} id ${key} (unrecognised name) â†’ ${key}`, G.getCosmeticThemeId({ id: key, name: 'Nameless' }), key);
    check(`${type} id ${key} with its own name â†’ ${key}`, G.getCosmeticThemeId({ id: key, name: def.name }), key);
  }
}
const skinClasses = Object.values(G.SKULL_THEMES).map(t => t.cssClass);
check('skin classes unique', new Set(skinClasses).size, skinClasses.length);
const fxClasses = Object.values(G.CLICK_EFFECTS).map(t => t.cssClass);
check('effect classes unique', new Set(fxClasses).size, fxClasses.length);

/* â”€â”€ Equip resolution through the game's own code â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
const inv = [
  { id: 'reapermoon', type: 'skull-skin', name: 'Reaper Moon Skull' },
  { id: 'hollowmoon', type: 'skull-skin', name: 'Hollow Moon Skull' },
  { id: 'chaff', type: 'skull-skin', name: 'Chaff Field Skull' },
  { id: 'crowfeather', type: 'skull-skin', name: 'Crowfeather Skull' },
  { id: 'wraith', type: 'click-effect', name: 'Wraith Wisp' },
  { id: 'bonesickle', type: 'click-effect', name: 'Bone Sickle Slash' },
  { id: '200_skull-skin_rare', type: 'skull-skin', name: 'Hollow Moon Skull' },
  { id: '201_cosmetic_rare', type: 'cosmetic', name: 'Crowfeather Skull' },
];
G.setOwned(inv);
check('skin slot lists new skins', G.ownedForSlot('skull-theme').map(i => i.id),
  ['reapermoon', 'hollowmoon', 'chaff', 'crowfeather', '200_skull-skin_rare', '201_cosmetic_rare']);
check('effect slot lists new effect, no skins', G.ownedForSlot('click-effect').map(i => i.id), ['wraith', 'bonesickle']);

for (const id of Object.keys(NEW_SKINS)) {
  const norm = G.normalizeEquipped('skull-theme', id);
  check(`stored "${id}" normalizes to itself`, norm, id);
  G.equip('skull-theme', norm);
  check(`equipped ${id} draws ${id}`, G.equippedThemeKey('skull-theme'), id);
  check(`equipped ${id} css`, G.SKULL_THEMES[G.equippedThemeKey('skull-theme')].cssClass, 'theme-' + id);
}
G.equip('skull-theme', '200_skull-skin_rare');
check('reward-key id named "Hollow Moon Skull" draws hollowmoon', G.equippedThemeKey('skull-theme'), 'hollowmoon');
G.equip('skull-theme', '201_cosmetic_rare');
check('legacy type:cosmetic "Crowfeather Skull" draws crowfeather', G.equippedThemeKey('skull-theme'), 'crowfeather');
G.equip('skull-theme', 'default');
check('unequip â†’ default', G.equippedThemeKey('skull-theme'), 'default');

check('bonesickle normalizes', G.normalizeEquipped('click-effect', 'bonesickle'), 'bonesickle');
G.equip('click-effect', 'bonesickle');
check('equipped bonesickle draws bonesickle', G.equippedThemeKey('click-effect'), 'bonesickle');
check('bonesickle css', G.CLICK_EFFECTS[G.equippedThemeKey('click-effect')].cssClass, 'click-effect-bonesickle');
check('bonesickle is not a skin', G.normalizeEquipped('skull-theme', 'bonesickle'), 'default');
check('a skin is not a click effect', G.normalizeEquipped('click-effect', 'chaff'), 'default');
G.equip('click-effect', 'default');
check('click effect unequip â†’ default', G.equippedThemeKey('click-effect'), 'default');

G.setOwned(inv.filter(i => i.id !== 'chaff'));
check('unowned chaff â†’ default', G.normalizeEquipped('skull-theme', 'chaff'), 'default');
G.equip('skull-theme', 'chaff');
check('stale equip of unowned chaff draws default', G.equippedThemeKey('skull-theme'), 'default');
G.setOwned(inv);

/* â”€â”€ CSS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
const style = src.slice(src.indexOf('<style>'), src.indexOf('</style>'));
function rulesFor(sel) {
  const out = [];
  let at = 0;
  while ((at = style.indexOf(sel, at)) !== -1) {
    const open = style.indexOf('{', at), close = style.indexOf('}', open);
    out.push(style.slice(open + 1, close));
    at = close;
  }
  return out.join('\n');
}
function keyframes(name) {
  const at = style.indexOf('@keyframes ' + name);
  if (at === -1) return '';
  let depth = 0, i = style.indexOf('{', at);
  for (; i < style.length; i++) {
    if (style[i] === '{') depth++;
    else if (style[i] === '}' && --depth === 0) break;
  }
  return style.slice(at, i + 1);
}
function hexesOK(css) {
  const bad = [];
  for (const m of css.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)) {
    let h = m[1];
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const [r, g, b] = [0, 2, 4].map(o => parseInt(h.slice(o, o + 2), 16));
    const grey = r === g && g === b;
    const red = g === b && r > g;
    if (!grey && !red) bad.push('#' + m[1]);
  }
  for (const m of css.matchAll(/rgba?\(([^)]+)\)/g)) {
    const [r, g, b] = m[1].split(',').map(s => parseFloat(s));
    if (!(r === g && g === b) && !(g === b && r > g)) bad.push(m[0]);
  }
  return bad;
}

const newCss = [];
for (const id of Object.keys(NEW_SKINS)) {
  const css = rulesFor('.skull-btn.theme-' + id + ' {');
  check(`.theme-${id} rule present`, css.length > 0, true);
  newCss.push(css);
}
const sickleCss = rulesFor('.click-effect-bonesickle .click-pop {');
check('.click-effect-bonesickle rule present', sickleCss.length > 0, true);
newCss.push(sickleCss, keyframes('crowfeather-beat'), keyframes('sickle-reap'), keyframes('sickle-fade'));
const all = newCss.join('\n');
check('new rules: palette black/grey/red/white only', hexesOK(all), []);
check('new rules: no box-shadow', /box-shadow/.test(all), false);
check('new rules: no side borders', /border-(left|right)/.test(all), false);
check('new rules: no blur', /blur\(|backdrop-filter/.test(all), false);
check('crowfeather animation has reduced-motion guard',
  /prefers-reduced-motion: reduce\)\s*\{\s*\.skull-btn\.theme-crowfeather\s*\{\s*animation:\s*none/.test(style), true);
check('bonesickle animation has reduced-motion guard',
  /prefers-reduced-motion: reduce\)\s*\{\s*\.click-effect-bonesickle \.click-pop\s*\{\s*animation:\s*sickle-fade/.test(style), true);
check('reduced-motion fallback is opacity-only', /transform/.test(keyframes('sickle-fade')), false);
check('static skins carry no animation',
  /animation/.test(rulesFor('.skull-btn.theme-hollowmoon {') + rulesFor('.skull-btn.theme-chaff {')), false);

/* â”€â”€ Server equip / unequip of the new items â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
const store = {
  inv_1: {
    userId: '1',
    items: [
      { id: 'hollowmoon', game: 'skull-clicker', type: 'skull-skin', name: 'Hollow Moon Skull', rarity: 'rare' },
      { id: 'chaff', game: 'skull-clicker', type: 'skull-skin', name: 'Chaff Field Skull', rarity: 'rare' },
      { id: 'crowfeather', game: 'skull-clicker', type: 'skull-skin', name: 'Crowfeather Skull', rarity: 'mythic' },
      { id: 'bonesickle', game: 'skull-clicker', type: 'click-effect', name: 'Bone Sickle Slash', rarity: 'rare' },
      { id: 'reapermoon', game: 'skull-clicker', type: 'skull-skin', name: 'Reaper Moon Skull', rarity: 'mythic' },
    ],
    equips: {},
  },
};
const env = {
  MARKETPLACE: {
    async get(k) { return k in store ? JSON.parse(JSON.stringify(store[k])) : null; },
    async put(k, v) { store[k] = JSON.parse(v); },
  },
};
const cookie = 'pham_session=' + encodeURIComponent(JSON.stringify({ user_id: '1', display_name: 'T' }));
async function equip(slot, itemId) {
  const res = await onRequestPost({ env, request: new Request('http://localhost/api/inventory', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ action: 'equip', game: 'skull-clicker', slot, itemId }),
  }) });
  return { status: res.status, body: await res.json() };
}
const stored = (slot) => (store.inv_1.equips['skull-clicker'] || {})[slot];

for (const id of Object.keys(NEW_SKINS)) {
  const r = await equip('skull-theme', id);
  check(`server equip ${id} â†’ 200`, r.status, 200);
  check(`server stores ${id}`, stored('skull-theme'), id);
  G.setOwned(store.inv_1.items);
  check(`reload with ${id} draws ${id}`,
    G.SKULL_THEMES[(G.equip('skull-theme', G.normalizeEquipped('skull-theme', stored('skull-theme'))), G.equippedThemeKey('skull-theme'))].cssClass,
    'theme-' + id);
}
const fx = await equip('click-effect', 'bonesickle');
check('server equip bonesickle â†’ 200', fx.status, 200);
check('server stores bonesickle', stored('click-effect'), 'bonesickle');
check('server refuses bonesickle as skin', (await equip('skull-theme', 'bonesickle')).status, 400);
check('server refuses chaff as click effect', (await equip('click-effect', 'chaff')).status, 400);
check('skin left as it was after refusals', stored('skull-theme'), 'crowfeather');
check('server unequip skin â†’ 200', (await equip('skull-theme', 'none')).status, 200);
check('skin slot cleared', stored('skull-theme'), undefined);
check('click effect untouched by skin unequip', stored('click-effect'), 'bonesickle');
check('server unequip effect â†’ 200', (await equip('click-effect', 'none')).status, 200);
check('effect slot cleared', stored('click-effect'), undefined);

/* Legacy-key fallback on the server lands on the right item, never the
   older Reaper Moon. */
store.inv_1.items = store.inv_1.items.map(i => ({ ...i, id: 'reward_' + i.id }));
for (const [key, slot] of [['hollowmoon', 'skull-theme'], ['chaff', 'skull-theme'], ['crowfeather', 'skull-theme'], ['bonesickle', 'click-effect']]) {
  const r = await equip(slot, key);
  check(`server legacy key ${key} â†’ 200`, r.status, 200);
  check(`server legacy key ${key} â†’ its item`, stored(slot), 'reward_' + key);
}

if (failures.length) {
  console.error(`\nâœ— ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error('  âœ— ' + f);
  process.exit(1);
}
console.log(`âœ“ all ${passed} skull cosmetic checks passed`);
