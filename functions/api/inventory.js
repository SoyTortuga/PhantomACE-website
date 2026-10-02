/* ══════════════════════════════════════════════
   SHARED INVENTORY API
   Central item storage across all games
   ══════════════════════════════════════════════ */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function getSession(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)pham_session=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match[1])); } catch { return null; }
}

function inventoryKey(userId) {
  return `inv_${userId}`;
}

async function getInventory(env, userId) {
  const data = await env.MARKETPLACE.get(inventoryKey(userId), 'json');
  return data || { userId, items: [], equips: {} };
}

async function saveInventory(env, userId, inv) {
  await env.MARKETPLACE.put(inventoryKey(userId), JSON.stringify(inv));
}

/* Every rarity an inv_ item is actually written with: the cosmetic ladder
   (common → mythic, exclusive above it) plus Dino Park's epic/legendary,
   which dino-hatch.js stores on overflow eggs. Rarity reaches other people's
   screens as a class name, so anything outside this set is reported as
   'common' rather than passed through. */
export const RARITIES = Object.freeze(['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic', 'exclusive']);

export function normalizeRarity(r) {
  return RARITIES.includes(r) ? r : 'common';
}

function publicItem(item) {
  return item && typeof item === 'object' ? { ...item, rarity: normalizeRarity(item.rarity) } : item;
}

/**
 * Spend one consumable of a given game+type, under the inventory's lock.
 *
 * FOR GAME SERVERS, NOT FOR CLIENTS. The generic `use` action below trusts
 * the caller about which item was spent and leaves the effect entirely
 * client-side — which is how the bingo wildcard shipped consuming the item
 * while the stamp itself evaporated on the next poll. A game endpoint that
 * grants an effect must take the item itself, in the same breath as
 * recording the effect, so "spent but nothing happened" stops being a
 * reachable state.
 *
 * mutate(), not get/save: two tabs spending the last wildcard must not
 * both succeed off the same read.
 *
 * Returns { ok: true, remaining } or { ok: false }.
 */
export async function consumeConsumable(env, userId, { game, type }) {
  let outcome = { ok: false };
  await env.MARKETPLACE.mutate(inventoryKey(userId), (inv) => {
    const cur = inv || { userId, items: [], equips: {} };
    const idx = (cur.items || []).findIndex(i =>
      i.game === game && i.type === type && i.consumable && (i.quantity || 1) > 0);
    if (idx === -1) { outcome = { ok: false }; return undefined; }   /* no write */

    const item = cur.items[idx];
    if ((item.quantity || 1) <= 1) cur.items.splice(idx, 1);
    else item.quantity--;

    outcome = { ok: true, remaining: item.quantity || 0 };
    return cur;
  });
  return outcome;
}

/**
 * Best-effort refund when the effect's own write failed after the item was
 * already taken. Losing the item AND the effect is the one outcome worse
 * than either failure alone.
 */
export async function refundConsumable(env, userId, { game, type, name }) {
  await env.MARKETPLACE.mutate(inventoryKey(userId), (inv) => {
    const cur = inv || { userId, items: [], equips: {} };
    const existing = (cur.items || []).find(i => i.game === game && i.type === type && i.consumable);
    if (existing) existing.quantity = (existing.quantity || 1) + 1;
    else cur.items.push({ id: `${type}_refund_${Date.now()}`, game, type, name: name || type, consumable: true, quantity: 1 });
    return cur;
  });
}

/* ── GET — fetch user inventory ───────────────── */

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const action = url.searchParams.get('action');

  /* Public — no session required. Returns ONLY each requested user's
     chosen showcase badges (name/rarity), never their full inventory.
     Used by games/leaderboards/forums to show badges next to OTHER
     people's names, not just your own. */
  if (action === 'showcase') {
    const idsParam = url.searchParams.get('userIds') || url.searchParams.get('userId') || '';
    const userIds = idsParam.split(',').map(s => s.trim()).filter(Boolean).slice(0, 50);
    const result = {};

    for (const uid of userIds) {
      const inv = await getInventory(env, uid);
      const showcaseIds = (inv.equips.profile && inv.equips.profile.badgeShowcase) || [];
      result[uid] = showcaseIds
        .map(id => inv.items.find(i => i.id === id && i.type === 'badge'))
        .filter(Boolean)
        /* Artwork included so a surface showing someone's showcase can draw
           the badge rather than a rarity glyph. It was already stored for
           every imported Twitch badge and returned to nobody. */
        .map(i => ({
          id: i.id,
          name: i.name,
          rarity: normalizeRarity(i.rarity),
          image: (i.meta && (i.meta.image || i.meta.imageUrl2x || i.meta.imageUrl1x)) || null,
        }));
    }

    return json(result);
  }

  const session = getSession(request);
  if (!session) return json({ error: 'Not logged in' }, 401);

  const game = url.searchParams.get('game');

  const inv = await getInventory(env, session.user_id);

  if (game) {
    const filtered = inv.items.filter(i => i.game === game).map(publicItem);
    const equips = inv.equips[game] || {};
    return json({ items: filtered, equips });
  }

  return json({ ...inv, items: (inv.items || []).map(publicItem) });
}

/* ── POST — equip, use items ──────────────────────
   There is deliberately no client-facing grant. Items are minted only by
   server code (phamily-time, item-codes, channel-points, raid-badges, …);
   a 'grant' action that took the item from the request body let any
   signed-in user hand themselves anything. */

export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);
  if (!session) return json({ error: 'Not logged in' }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  if (body.action === 'equip') {
    return await handleEquip(env, session, body);
  }

  if (body.action === 'use') {
    return await handleUse(env, session, body);
  }

  if (body.action === 'set-showcase') {
    return await handleSetShowcase(env, session, body);
  }

  return json({ error: 'Unknown action' }, 400);
}

/* Every equip slot, per game, and the item type(s) it accepts. Slot names
   are what each caller sends (inventory.js PROFILE_SLOTS, Skull Clicker,
   Memory Match, Mana Clash); types are what the granters write (phamily-time
   REWARD_ITEM_MAP, import-badges, raid/check-in badges). Skull Clicker's
   'cosmetic' is the pre-fix type its old rewards were granted under. A
   game/slot absent here cannot be equipped at all. */
export const EQUIP_SLOTS = Object.freeze({
  profile: {
    badge: ['badge'],
    title: ['title'],
    banner: ['banner'],
    'name-effect': ['name-effect'],
    'skull-image': ['badge'],
  },
  'memory-match': {
    'card-back': ['cardback'],
    'emote-set': ['emote-pack'],
  },
  'skull-clicker': {
    'skull-theme': ['skull-skin', 'cosmetic'],
    'click-effect': ['click-effect', 'cosmetic'],
  },
  'mana-clash': {
    dice: ['dice'],
  },
});

const LEGACY_SLUG_GAMES = ['memory-match', 'skull-clicker'];

function slotTypes(game, slot) {
  const g = Object.prototype.hasOwnProperty.call(EQUIP_SLOTS, game) ? EQUIP_SLOTS[game] : null;
  return g && Object.prototype.hasOwnProperty.call(g, slot) ? g[slot] : null;
}

function nameSlug(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/* The owned item an equip refers to. The real inventory id wins. Older game
   builds sent their own short key instead ('cobweb', 'reapermoon') — the
   word the game derives from the item's name — so as a fallback a bare
   lowercase word is matched against the words of an owned item's name
   (or the run of them, for 'reapermoon' ← "Reaper Moon Skull"). Only items
   of this game AND an accepted type are ever candidates. */
export function resolveEquipItem(items, game, types, itemId) {
  const candidates = (Array.isArray(items) ? items : [])
    .filter(i => i && i.game === game && types.includes(i.type));
  const exact = candidates.find(i => i.id === itemId);
  if (exact) return exact;
  if (!LEGACY_SLUG_GAMES.includes(game)) return null;

  const key = String(itemId);
  if (!/^[a-z0-9]{2,40}$/.test(key)) return null;
  return candidates.find(i => {
    const slug = nameSlug(i.name);
    return slug.split('-').includes(key) || slug.replace(/-/g, '').startsWith(key);
  }) || null;
}

async function handleEquip(env, session, body) {
  if (!body.game || !body.slot || !body.itemId) {
    return json({ error: 'Missing game, slot, or itemId' }, 400);
  }
  if (typeof body.game !== 'string' || typeof body.slot !== 'string' || typeof body.itemId !== 'string') {
    return json({ error: 'Invalid game, slot, or itemId' }, 400);
  }

  const types = slotTypes(body.game, body.slot);
  if (!types) return json({ error: 'Unknown equip slot' }, 400);

  const inv = await getInventory(env, session.user_id);
  if (!Array.isArray(inv.items)) inv.items = [];
  if (!inv.equips || typeof inv.equips !== 'object') inv.equips = {};

  if (body.itemId === 'none') {
    if (inv.equips[body.game]) delete inv.equips[body.game][body.slot];
    await saveInventory(env, session.user_id, inv);
    return json({ success: true, equips: inv.equips[body.game] || {} });
  }

  /* Ids are only unique per type ('void' is both a skull skin and a click
     effect), so an id held under the wrong type is refused only when no item
     of an accepted type answers to it. */
  const item = resolveEquipItem(inv.items, body.game, types, body.itemId);
  if (!item) {
    const wrongType = inv.items.find(i => i && i.id === body.itemId && i.game === body.game);
    if (wrongType) return json({ error: `That item can't be equipped as ${body.slot}` }, 400);
    return json({ error: 'Item not found' }, 404);
  }

  if (!inv.equips[body.game]) inv.equips[body.game] = {};
  inv.equips[body.game][body.slot] = item.id;

  await saveInventory(env, session.user_id, inv);
  return json({ success: true, itemId: item.id, equips: inv.equips[body.game] });
}

const SHOWCASE_MAX = 5;

async function handleSetShowcase(env, session, body) {
  const badgeIds = Array.isArray(body.badgeIds) ? body.badgeIds : null;
  if (!badgeIds) return json({ error: 'badgeIds must be an array' }, 400);
  if (badgeIds.length > SHOWCASE_MAX) {
    return json({ error: `Choose at most ${SHOWCASE_MAX} badges` }, 400);
  }

  const inv = await getInventory(env, session.user_id);

  const valid = badgeIds.filter(id => inv.items.some(i => i.id === id && i.type === 'badge'));
  if (valid.length !== badgeIds.length) {
    return json({ error: 'One or more badges are not in your inventory' }, 400);
  }

  if (!inv.equips.profile) inv.equips.profile = {};
  inv.equips.profile.badgeShowcase = valid;

  await saveInventory(env, session.user_id, inv);
  return json({ success: true, badgeShowcase: valid });
}

async function handleUse(env, session, body) {
  if (!body.itemId) return json({ error: 'Missing itemId' }, 400);

  const inv = await getInventory(env, session.user_id);
  const idx = inv.items.findIndex(i => i.id === body.itemId && i.consumable);
  if (idx === -1) return json({ error: 'Consumable not found' }, 404);

  const item = inv.items[idx];
  if (item.quantity <= 1) {
    inv.items.splice(idx, 1);
  } else {
    item.quantity--;
  }

  await saveInventory(env, session.user_id, inv);
  return json({ success: true, item: publicItem(item), remaining: item.quantity || 0 });
}
