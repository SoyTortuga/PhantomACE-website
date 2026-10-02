#!/usr/bin/env node
/* ══════════════════════════════════════════════
   INVENTORY EQUIP — test suite

     node server/scripts/test-inventory-equip.js

   - Unequip ('none') succeeds for every caller: the profile page, Memory
     Match's and Skull Clicker's "Default" options. It used to look the item
     up first, so 'none' 404'd everywhere.
   - An item only fits the slot(s) its type belongs to: a badge cannot be
     worn as a banner or name effect. Unknown game/slot → 400.
   - Card backs / emote packs equip by the owned item's real id, persist
     (the GET returns that id and Memory Match's own resolver maps it back to
     its card-back key), and older slug-based calls ('cobweb') still resolve.
   - Skull Clicker ids are per-type ('void' is a skin AND a click effect);
     each slot picks the item of its own type.
   ══════════════════════════════════════════════ */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { onRequestGet, onRequestPost, EQUIP_SLOTS } from '../../functions/api/inventory.js';

const here = dirname(fileURLToPath(import.meta.url));

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), x = JSON.stringify(expected);
  if (a === x) { passed++; return; }
  failures.push(`${label}\n      expected ${x}\n      got      ${a}`);
}

function makeEnv(store) {
  let writes = 0;
  return {
    get writes() { return writes; },
    MARKETPLACE: {
      async get(key) { return key in store ? JSON.parse(JSON.stringify(store[key])) : null; },
      async put(key, val) { writes++; store[key] = JSON.parse(val); },
    },
  };
}

const cookie = (uid) => 'pham_session=' + encodeURIComponent(JSON.stringify({ user_id: uid, display_name: 'T' }));

async function equip(env, uid, game, slot, itemId) {
  const res = await onRequestPost({ env, request: new Request('http://localhost/api/inventory', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie(uid) },
    body: JSON.stringify({ action: 'equip', game, slot, itemId }),
  }) });
  return { status: res.status, body: await res.json() };
}

async function read(env, uid, game) {
  const res = await onRequestGet({ env, request: new Request(`http://localhost/api/inventory?game=${game}`, {
    headers: { Cookie: cookie(uid) },
  }) });
  return res.json();
}

function freshStore() {
  return {
    inv_1: {
      userId: '1',
      items: [
        { id: 'badge-1', game: 'profile', type: 'badge', name: 'Raid Badge', rarity: 'rare' },
        { id: 'banner-1', game: 'profile', type: 'banner', name: 'Profile Banner', rarity: 'mythic', meta: { theme: 'halloween' } },
        { id: 'fx-1', game: 'profile', type: 'name-effect', name: 'Name Effect', rarity: 'rare' },
        { id: 'title-1', game: 'profile', type: 'title', name: 'Night Owl', rarity: 'common' },
        { id: 'cardback-cobweb-card-back', game: 'memory-match', type: 'cardback', name: 'Cobweb Card Back', rarity: 'common' },
        { id: '10_follower_cardback_common', game: 'memory-match', type: 'cardback', name: 'Crypt Card Back', rarity: 'uncommon' },
        { id: 'emote-pack-haunted-emote-pack', game: 'memory-match', type: 'emote-pack', name: 'Haunted Emote Pack', rarity: 'rare' },
        { id: 'void', game: 'skull-clicker', type: 'skull-skin', name: 'Dark Altar Skull', rarity: 'rare' },
        { id: 'void', game: 'skull-clicker', type: 'click-effect', name: 'Void Click', rarity: 'rare' },
        { id: 'reapermoon', game: 'skull-clicker', type: 'skull-skin', name: 'Reaper Moon Skull', rarity: 'mythic' },
        { id: '40_cosmetic_rare', game: 'skull-clicker', type: 'cosmetic', name: 'Blood Skull Skin', rarity: 'rare' },
        { id: 'crimson', game: 'mana-clash', type: 'dice', name: 'Crimson Dice', rarity: 'rare' },
      ],
      equips: { profile: { badge: 'badge-1', banner: 'banner-1', badgeShowcase: ['badge-1'] } },
    },
  };
}

/* ── Slot map shape ─────────────────────────────────────────────────── */
check('profile slots', Object.keys(EQUIP_SLOTS.profile), ['badge', 'title', 'banner', 'name-effect', 'skull-image']);
check('memory-match slots', EQUIP_SLOTS['memory-match'], { 'card-back': ['cardback'], 'emote-set': ['emote-pack'] });

/* ── 1. Unequip succeeds ────────────────────────────────────────────── */
{
  const store = freshStore();
  const env = makeEnv(store);

  const r = await equip(env, '1', 'profile', 'banner', 'none');
  check('profile unequip → 200', r.status, 200);
  check('profile unequip → success', r.body.success, true);
  check('banner slot cleared', 'banner' in store.inv_1.equips.profile, false);
  check('other slots untouched', store.inv_1.equips.profile.badge, 'badge-1');
  check('showcase untouched', store.inv_1.equips.profile.badgeShowcase, ['badge-1']);

  const again = await equip(env, '1', 'profile', 'banner', 'none');
  check('unequip an empty slot is still fine', again.status, 200);

  const mm = await equip(env, '1', 'memory-match', 'card-back', 'none');
  check('Memory Match "Default" card back → 200', mm.status, 200);
  check('no equips for that game → {}', mm.body.equips, {});

  const sc = await equip(env, '1', 'skull-clicker', 'skull-theme', 'none');
  check('Skull Clicker "Default" theme → 200', sc.status, 200);

  const img = await equip(env, '1', 'profile', 'skull-image', 'none');
  check('Skull Clicker "Default" loyalty skull → 200', img.status, 200);

  const bogus = await equip(env, '1', 'profile', 'cape', 'none');
  check('unequip an unknown slot → 400', bogus.status, 400);
}

/* ── 2. Type must fit the slot ──────────────────────────────────────── */
{
  const store = freshStore();
  const env = makeEnv(store);

  const asBanner = await equip(env, '1', 'profile', 'banner', 'badge-1');
  check('badge as banner → 400', asBanner.status, 400);
  check('banner left as it was', store.inv_1.equips.profile.banner, 'banner-1');

  const asFx = await equip(env, '1', 'profile', 'name-effect', 'badge-1');
  check('badge as name effect → 400', asFx.status, 400);
  check('name effect stayed empty', 'name-effect' in store.inv_1.equips.profile, false);

  const titleAsBadge = await equip(env, '1', 'profile', 'badge', 'title-1');
  check('title as badge → 400', titleAsBadge.status, 400);

  const okBanner = await equip(env, '1', 'profile', 'banner', 'banner-1');
  check('banner as banner → 200', okBanner.status, 200);
  const okFx = await equip(env, '1', 'profile', 'name-effect', 'fx-1');
  check('name effect as name effect → 200', okFx.status, 200);
  const loyalty = await equip(env, '1', 'profile', 'skull-image', 'badge-1');
  check('badge as loyalty skull → 200', loyalty.status, 200);
  const bannerAsSkull = await equip(env, '1', 'profile', 'skull-image', 'banner-1');
  check('banner as loyalty skull → 400', bannerAsSkull.status, 400);

  const crossGame = await equip(env, '1', 'memory-match', 'card-back', 'badge-1');
  check('profile badge as card back → 404 (not this game)', crossGame.status, 404);

  const unknownSlot = await equip(env, '1', 'profile', 'cape', 'badge-1');
  check('unknown slot → 400', unknownSlot.status, 400);
  const unknownGame = await equip(env, '1', 'nope', 'banner', 'banner-1');
  check('unknown game → 400', unknownGame.status, 400);
  const proto = await equip(env, '1', 'profile', '__proto__', 'banner-1');
  check('__proto__ slot → 400', proto.status, 400);
  const missing = await equip(env, '1', 'profile', 'banner', 'not-owned');
  check('unowned item → 404', missing.status, 404);
}

/* ── 3. Card backs / emote packs by owned id, persisted ──────────────── */
function extractMM() {
  const src = readFileSync(join(here, '../../games/memory-match/index.html'), 'utf8');
  const parts = [];
  for (const n of ['getCosmeticId', 'resolveEquipped']) {
    const start = src.indexOf('function ' + n + '(');
    if (start === -1) throw new Error(`memory-match: ${n} not found`);
    let depth = 0, i = src.indexOf('{', start);
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) break;
    }
    parts.push(src.slice(start, i + 1));
  }
  // eslint-disable-next-line no-eval
  return (0, eval)('(function(){' + parts.join('\n') + '\nreturn { getCosmeticId, resolveEquipped };})()');
}
const MM = extractMM();

{
  const store = freshStore();
  const env = makeEnv(store);

  const r = await equip(env, '1', 'memory-match', 'card-back', 'cardback-cobweb-card-back');
  check('card back by owned id → 200', r.status, 200);
  check('stored as the real id', store.inv_1.equips['memory-match']['card-back'], 'cardback-cobweb-card-back');

  const legacyKeyed = await equip(env, '1', 'memory-match', 'card-back', '10_follower_cardback_common');
  check('reward-key-id card back by owned id → 200', legacyKeyed.status, 200);

  const e = await equip(env, '1', 'memory-match', 'emote-set', 'emote-pack-haunted-emote-pack');
  check('emote pack by owned id → 200', e.status, 200);

  /* "Reload": read back what Memory Match reads, and resolve it the way the
     game does on load. */
  const after = await read(env, '1', 'memory-match');
  check('GET returns the equipped card back id', after.equips['card-back'], '10_follower_cardback_common');
  const cards = after.items.filter(i => i.type === 'cardback');
  const emotes = after.items.filter(i => i.type === 'emote-pack');
  check('reload → Crypt card back drawn', MM.resolveEquipped(cards, after.equips['card-back'], 'cb'),
    { itemId: '10_follower_cardback_common', key: 'crypt' });
  check('reload → Haunted card set drawn', MM.resolveEquipped(emotes, after.equips['emote-set'], 'emote'),
    { itemId: 'emote-pack-haunted-emote-pack', key: 'haunted' });

  /* Older builds sent the game's own key. */
  const slug = await equip(env, '1', 'memory-match', 'card-back', 'cobweb');
  check('legacy slug "cobweb" → 200', slug.status, 200);
  check('legacy slug stored as the real id', store.inv_1.equips['memory-match']['card-back'], 'cardback-cobweb-card-back');
  check('response names the resolved id', slug.body.itemId, 'cardback-cobweb-card-back');
  const slugE = await equip(env, '1', 'memory-match', 'emote-set', 'haunted');
  check('legacy slug "haunted" → 200', slugE.status, 200);
  const slugMiss = await equip(env, '1', 'memory-match', 'card-back', 'ghost');
  check('legacy slug for an unowned card back → 404', slugMiss.status, 404);
  const slugWrongType = await equip(env, '1', 'memory-match', 'card-back', 'haunted');
  check('emote slug as card back → 404', slugWrongType.status, 404);

  /* A stored legacy key (pre-fix save) still resolves on the client. */
  check('client resolves a stored legacy key', MM.resolveEquipped(cards, 'cobweb', 'cb'),
    { itemId: 'cardback-cobweb-card-back', key: 'cobweb' });
  check('client ignores an equip it does not own', MM.resolveEquipped(cards, 'cardback-ghost-card-back', 'cb'), null);

  const off = await equip(env, '1', 'memory-match', 'card-back', 'none');
  check('back to Default → 200', off.status, 200);
  const cleared = await read(env, '1', 'memory-match');
  check('reload after Default → no card back', cleared.equips['card-back'], undefined);
}

/* ── Skull Clicker: per-type ids, legacy keys, Mana Clash dice ───────── */
{
  const store = freshStore();
  const env = makeEnv(store);

  const skin = await equip(env, '1', 'skull-clicker', 'skull-theme', 'void');
  check('"void" as skull theme → 200 (the skin, not the click effect)', skin.status, 200);
  const fx = await equip(env, '1', 'skull-clicker', 'click-effect', 'void');
  check('"void" as click effect → 200 (the click effect)', fx.status, 200);

  const moon = await equip(env, '1', 'skull-clicker', 'skull-theme', 'reapermoon');
  check('reapermoon by id → 200', moon.status, 200);

  const legacyCosmetic = await equip(env, '1', 'skull-clicker', 'skull-theme', '40_cosmetic_rare');
  check('legacy type:cosmetic skin by id → 200', legacyCosmetic.status, 200);
  const legacySlug = await equip(env, '1', 'skull-clicker', 'skull-theme', 'blood');
  check('legacy theme key "blood" → its owned item', store.inv_1.equips['skull-clicker']['skull-theme'], '40_cosmetic_rare');
  check('legacy theme key → 200', legacySlug.status, 200);

  const moonAsFx = await equip(env, '1', 'skull-clicker', 'click-effect', 'reapermoon');
  check('skull skin as click effect → 400', moonAsFx.status, 400);

  const dice = await equip(env, '1', 'mana-clash', 'dice', 'crimson');
  check('Mana Clash dice by id → 200', dice.status, 200);
  const diceSlug = await equip(env, '1', 'mana-clash', 'dice', 'nope');
  check('Mana Clash has no slug fallback → 404', diceSlug.status, 404);
}

/* ── Bad bodies ─────────────────────────────────────────────────────── */
{
  const env = makeEnv(freshStore());
  check('missing itemId → 400', (await equip(env, '1', 'profile', 'banner', '')).status, 400);
  check('object itemId → 400', (await equip(env, '1', 'profile', 'banner', { id: 'banner-1' })).status, 400);
  const anon = await onRequestPost({ env, request: new Request('http://localhost/api/inventory', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'equip', game: 'profile', slot: 'banner', itemId: 'none' }),
  }) });
  check('signed out → 401', anon.status, 401);
  check('no writes from refused requests', env.writes, 0);
}

if (failures.length) {
  console.error(`\n✗ ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`✓ all ${passed} inventory equip checks passed`);
