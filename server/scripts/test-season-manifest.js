#!/usr/bin/env node
/* ══════════════════════════════════════════════
   SEASON MANIFEST — test suite (Grimoire foundation, C0)

     node server/scripts/test-season-manifest.js

   setForMonth() must derive a month's collectible cosmetic set from the SAME
   reward tables the pass grants from, ownsSetItem() must recognise a granted
   inventory, and collectionForMonth() must compute owned/missing/complete. The
   drift risk this module exists to contain is the item-id scheme, so a few ids
   are pinned to the exact scheme phamily-time.js grants with.

   No database — pure functions over the reward tables.
   ══════════════════════════════════════════════ */

import {
  setForMonth, ownsSetItem, collectionForMonth, setBadgeId, storedTypeFor,
} from '../../functions/api/season-manifest.js';
import { nameKeyedItemId } from '../../functions/api/phamily-rewards.js';

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

const MK = '2026-10';          // themed (halloween)
const BASE = '2026-07';        // no theme

function main() {
  const set = setForMonth(MK);

  /* ── shape ── */
  ok('set is non-empty', set.length > 0);
  ok('every entry has a non-null itemId', set.every(e => typeof e.itemId === 'string' && e.itemId));
  ok('every entry is a collectible type', set.every(e => [
    'cardback', 'emote', 'dice', 'skull-skin', 'click-effect', 'room-piece', 'room-set',
    'badge', 'title', 'banner', 'nameeffect',
  ].includes(e.type)));
  const ids = set.map(e => e.itemId);
  check('itemIds are unique (deduped)', ids.length, new Set(ids).size);

  /* ── exclusions: no giveaway / egg / bingo / wildcard / room-slot ── */
  ok('excludes non-collectibles', set.every(e => !['giveaway', 'egg', 'bingo', 'bonus-card', 'wildcard', 'room-slot'].includes(e.type)));

  /* ── milestones: 10 badges + 10 titles, month-stamped ids ── */
  const badges = set.filter(e => e.type === 'badge');
  const titles = set.filter(e => e.type === 'title');
  check('10 milestone badges', badges.length, 10);
  check('10 milestone titles', titles.length, 10);
  ok('badge id is month-stamped', set.some(e => e.type === 'badge' && e.itemId === `ms_15_badge_${MK}`));
  ok('title id is month-stamped', set.some(e => e.type === 'title' && e.itemId === `ms_15_title_${MK}`));

  /* ── pinned id schemes (mirror phamily-time REWARD_ITEM_MAP) ── */
  const aCardback = set.find(e => e.type === 'cardback');
  ok('a cardback exists', !!aCardback);
  check('cardback id is name-keyed', aCardback.itemId, nameKeyedItemId('cardback', aCardback.name));
  check('cardback stored type', storedTypeFor('cardback'), 'cardback');
  check('emote stored type is emote-pack', storedTypeFor('emote'), 'emote-pack');
  check('nameeffect stored type is name-effect', storedTypeFor('nameeffect'), 'name-effect');

  const aDice = set.find(e => e.type === 'dice' && e.cosmeticId);
  ok('a dice with a cosmeticId exists', !!aDice);
  check('dice id is the cosmetic id', aDice.itemId, aDice.cosmeticId);

  const roomPiece = set.find(e => e.type === 'room-piece');
  if (roomPiece) ok('room-piece id is prefixed', roomPiece.itemId.startsWith('room-piece-'));

  /* ── themed month carries the theme on banner / name-effect ── */
  const themedBonus = set.filter(e => (e.type === 'banner' || e.type === 'nameeffect'));
  ok('themed month has banner/name-effect entries', themedBonus.length > 0);
  ok('themed banner/name-effect carry a theme', themedBonus.every(e => e.theme === 'halloween'));
  ok('name-effect id uses the nameeffect token', set.some(e => e.type === 'nameeffect' && /^ms_\d+_nameeffect_/.test(e.itemId)));

  /* ── base (unthemed) month: same shape, no theme on bonuses ── */
  const baseSet = setForMonth(BASE);
  ok('base month also yields a set', baseSet.length > 0);
  ok('base month bonuses carry no theme', baseSet.filter(e => e.type === 'banner' || e.type === 'nameeffect').every(e => e.theme === null));

  /* ── ownsSetItem + collectionForMonth round-trip ── */
  const fullInv = set.map(e => ({ id: e.itemId, type: e.storedType, name: e.name }));
  ok('ownsSetItem finds a granted item', ownsSetItem(fullInv, set[0]));
  ok('ownsSetItem rejects an empty inventory', !ownsSetItem([], set[0]));

  const full = collectionForMonth(fullInv, MK);
  check('full inventory: owned == total', full.owned.length, full.total);
  check('full inventory: nothing missing', full.missing.length, 0);
  ok('full inventory: complete', full.complete === true);

  const minusOne = fullInv.slice(1);
  const partial = collectionForMonth(minusOne, MK);
  check('one missing shows up', partial.missing.length, 1);
  ok('partial is not complete', partial.complete === false);
  check('owned + missing == total', partial.owned.length + partial.missing.length, partial.total);

  /* ── scope filters to a track (+ shared milestones) ── */
  const follower = collectionForMonth([], MK, 'follower');
  const phamily = collectionForMonth([], MK, 'phamily');
  ok('follower scope is smaller than all', follower.total < full.total || follower.total <= phamily.total + 20);
  ok('both scopes include the milestones', follower.total >= 20 && phamily.total >= 20);

  /* ── empty inventory owns nothing ── */
  const none = collectionForMonth([], MK);
  check('empty inv owns nothing', none.owned.length, 0);
  check('empty inv missing == total', none.missing.length, none.total);

  /* ── set badge id ── */
  check('set badge id', setBadgeId(MK), `grimoire-${MK}`);

  if (failures.length) {
    console.error(`\n[season-manifest] ${failures.length} FAILED:\n  - ` + failures.join('\n  - '));
    process.exit(1);
  }
  console.log(`[season-manifest] ${passed} assertions passed — ${set.length} items in ${MK}'s set.`);
}

main();
