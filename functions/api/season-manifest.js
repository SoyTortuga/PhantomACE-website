/* ══════════════════════════════════════════════
   SEASON MANIFEST — what cosmetics belong to a month's set

   The Seasonal Grimoire (and anything else that wants a "collection set" for a
   month) needs ONE answer to: which collectible cosmetics does month <mk> pay,
   and does a given inventory own each one? That answer is derived here from the
   existing reward tables (phamily-rewards.js), so there is no second copy of the
   month data to drift from the pass.

   This is the deliberate seam the full season registry (roadmap #6) will later
   implement behind the SAME two exports — setForMonth() and ownsSetItem() — so
   the Grimoire never has to be rewritten when that lands.

   Library, not a route: declared in NON_ROUTE_MODULES.

   COLLECTIBLE vs not. A "set" is the persistent, show-in-a-collection cosmetics:
   card backs, emote packs, dice, skull skins, click effects, room pieces/sets,
   and the milestone badges, titles, banners and name effects. It deliberately
   EXCLUDES things that are not a kept cosmetic: giveaway entries (not an item),
   eggs and bingo/wildcard cards (consumed), and room slots (capacity, not art).
   ══════════════════════════════════════════════ */

import { rewardTablesFor, nameKeyedItemId } from './phamily-rewards.js';
import { monthKey } from './season-time.js';

/* Reward-table type -> stored inventory item type, where they differ
   (see REWARD_ITEM_MAP in phamily-time.js). */
const STORED_TYPE = { emote: 'emote-pack', nameeffect: 'name-effect' };
export function storedTypeFor(type) { return STORED_TYPE[type] || type; }

/* Track-reward types that are kept cosmetics. */
const TRACK_COLLECTIBLE = new Set([
  'cardback', 'emote', 'dice', 'skull-skin', 'click-effect', 'room-piece', 'room-set',
]);
/* Milestone bonus types that are kept cosmetics (badge + title are added for
   every milestone regardless; these are the extras that also count). */
const MILESTONE_BONUS_COLLECTIBLE = new Set(['banner', 'nameeffect', 'dice', 'cardback']);

/**
 * The exact inventory item id a granted set entry carries, mirroring
 * phamily-time.js's REWARD_ITEM_MAP and the milestone grant ids. This is the
 * unambiguous ownership key — matching on it avoids guessing from names.
 */
function expectedItemId(entry) {
  const { type, name, cosmeticId, level, mk, source } = entry;
  if (source === 'milestone' && (type === 'badge' || type === 'title' || type === 'banner' || type === 'nameeffect')) {
    /* Milestone badge/title/banner/name-effect ids are month-stamped
       (ms_<level>_<type>_<mk>); dice bonuses fall through to the id-keyed branch
       below because their mapper overrides the id with the cosmetic id. */
    return `ms_${level}_${type}_${mk}`;
  }
  if (type === 'dice' || type === 'skull-skin' || type === 'click-effect') return cosmeticId || null;
  if (type === 'room-piece') return cosmeticId ? `room-piece-${cosmeticId}` : null;
  if (type === 'room-set') return cosmeticId ? `room-set-${cosmeticId}` : null;
  if (type === 'cardback') return nameKeyedItemId('cardback', name);
  if (type === 'emote') return nameKeyedItemId('emote-pack', name);
  return null;
}

function entryFrom(reward, track, source) {
  const e = {
    source,                       // 'track' | 'milestone'
    track,                        // 'follower' | 'phamily' | null (milestone shared)
    type: reward.type,
    storedType: storedTypeFor(reward.type),
    name: reward.name || reward.type,
    rarity: reward.rarity || 'common',
    cosmeticId: reward.cosmeticId || null,
    theme: (reward.meta && reward.meta.theme) || null,
    level: reward.level,
    mk: reward.mk,
  };
  e.itemId = expectedItemId(e);
  return e;
}

/**
 * The collectible cosmetic set for a month.
 *
 * @param {string} [mk]  'YYYY-MM' (Pacific); defaults to the current month.
 * @returns {Array<{source, track, type, storedType, name, rarity, cosmeticId,
 *                  theme, level, mk, itemId}>}  deduped by itemId.
 */
export function setForMonth(mk = monthKey()) {
  const month = String(mk);
  const t = rewardTablesFor(month);
  const out = [];
  const seen = new Set();
  const add = (e) => {
    if (!e.itemId || seen.has(e.itemId)) return;
    seen.add(e.itemId);
    out.push(e);
  };

  for (const [track, list] of [['follower', t.follower], ['phamily', t.phamily]]) {
    for (const reward of list) {
      if (!TRACK_COLLECTIBLE.has(reward.type)) continue;
      add(entryFrom({ ...reward, mk: month }, track, 'track'));
    }
  }

  for (const m of t.milestones) {
    const rank = m.title;
    const rarity = m.level >= 120 ? 'mythic' : m.level >= 60 ? 'rare' : 'uncommon';
    /* Every milestone grants a badge and a title (see phamily-time.js). */
    add(entryFrom({ type: 'badge', name: `${rank} Badge`, rarity, level: m.level, mk: month }, null, 'milestone'));
    add(entryFrom({ type: 'title', name: rank, rarity, level: m.level, mk: month }, null, 'milestone'));
    for (const b of (m.bonusItems || [])) {
      if (!MILESTONE_BONUS_COLLECTIBLE.has(b.type)) continue;
      add(entryFrom({
        type: b.type, name: b.name || b.type, rarity: b.rarity || 'common',
        cosmeticId: b.cosmeticId, meta: b.meta, level: m.level, mk: month,
      }, null, 'milestone'));
    }
  }

  return out;
}

/** Does this inventory (array of items) own the given set entry? */
export function ownsSetItem(items, entry) {
  if (!entry || !entry.itemId) return false;
  const list = Array.isArray(items) ? items : [];
  return list.some(it => it && it.id === entry.itemId);
}

/**
 * Owned / missing / completion for a month, given an inventory's items.
 * `scope` picks which track's set counts toward completion: 'all' (default),
 * 'follower' (follower track + milestones), or 'phamily' (phamily + milestones).
 */
export function collectionForMonth(items, mk = monthKey(), scope = 'all') {
  const set = setForMonth(mk).filter(e =>
    scope === 'all' || e.source === 'milestone' || e.track === scope);
  const owned = [];
  const missing = [];
  for (const e of set) (ownsSetItem(items, e) ? owned : missing).push(e);
  return { month: String(mk), scope, total: set.length, owned, missing, complete: set.length > 0 && missing.length === 0 };
}

/** The set-completion badge id a finished month grants. */
export function setBadgeId(mk) { return `grimoire-${String(mk)}`; }
