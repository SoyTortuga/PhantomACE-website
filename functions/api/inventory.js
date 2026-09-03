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

/* ── GET — fetch user inventory ───────────────── */

export async function onRequestGet(context) {
  const { env, request } = context;
  const session = getSession(request);
  if (!session) return json({ error: 'Not logged in' }, 401);

  const url = new URL(request.url);
  const game = url.searchParams.get('game');

  const inv = await getInventory(env, session.user_id);

  if (game) {
    const filtered = inv.items.filter(i => i.game === game);
    const equips = inv.equips[game] || {};
    return json({ items: filtered, equips });
  }

  return json(inv);
}

/* ── POST — grant, equip, use items ───────────── */

export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);
  if (!session) return json({ error: 'Not logged in' }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  if (body.action === 'grant') {
    return await handleGrant(env, session, body);
  }

  if (body.action === 'equip') {
    return await handleEquip(env, session, body);
  }

  if (body.action === 'use') {
    return await handleUse(env, session, body);
  }

  return json({ error: 'Invalid action' }, 400);
}

async function handleGrant(env, session, body) {
  if (!body.item || !body.item.game || !body.item.type || !body.item.id) {
    return json({ error: 'Invalid item' }, 400);
  }

  const inv = await getInventory(env, session.user_id);

  const existing = inv.items.find(i => i.id === body.item.id && !i.consumable);
  if (existing) return json({ success: true, duplicate: true });

  inv.items.push({
    id: body.item.id,
    game: body.item.game,
    type: body.item.type,
    name: body.item.name || body.item.id,
    rarity: body.item.rarity || 'common',
    consumable: body.item.consumable || false,
    quantity: body.item.quantity || 1,
    grantedAt: Date.now(),
    source: body.source || 'phamily-time',
  });

  await saveInventory(env, session.user_id, inv);
  return json({ success: true });
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
  return json({ success: true, item, remaining: item.quantity || 0 });
}
