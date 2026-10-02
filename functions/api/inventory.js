/* ══════════════════════════════════════════════
   SHARED INVENTORY API
   Central item storage across all games
   ══════════════════════════════════════════════ */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function getSession(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/pham_session=([^;]+)/);
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

async function handleEquip(env, session, body) {
  if (!body.game || !body.slot || !body.itemId) {
    return json({ error: 'Missing game, slot, or itemId' }, 400);
  }

  const inv = await getInventory(env, session.user_id);
  const item = inv.items.find(i => i.id === body.itemId && i.game === body.game);
  if (!item) return json({ error: 'Item not found' }, 404);

  if (!inv.equips[body.game]) inv.equips[body.game] = {};

  if (body.itemId === 'none') {
    delete inv.equips[body.game][body.slot];
  } else {
    inv.equips[body.game][body.slot] = body.itemId;
  }

  await saveInventory(env, session.user_id, inv);
  return json({ success: true, equips: inv.equips[body.game] });
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
