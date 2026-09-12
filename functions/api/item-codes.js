/* ══════════════════════════════════════════════
   ITEM CODE API
   Create, activate, and redeem item drop codes
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

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

/* ── Dino Park egg items ───────────────────────────
   Site-wide rarity (stored on the item, shown on the
   redemption UI's border/color) maps deterministically
   onto Dino Park's own 5-tier scale. Dino Park has no
   "mythic" tier, so a mythic code coin-flips between its
   two top tiers at redeem time — the flip result is what
   actually gets granted and what the player is told. ── */

const SITE_RARITIES = ['mythic', 'rare', 'uncommon', 'common'];
const DINO_TIER_MAP = { common: 'common', uncommon: 'uncommon', rare: 'rare' };

function rollDinoEggTier(siteRarity) {
  if (siteRarity === 'mythic') {
    return Math.random() < 0.5 ? 'epic' : 'legendary';
  }
  return DINO_TIER_MAP[siteRarity] || 'common';
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function validateItemShape(item) {
  if (!item || !item.id || !item.game || !item.type || !item.name) {
    return 'Invalid item — requires id, game, type, name';
  }
  if (item.game === 'dino-park' && item.type === 'egg' && !SITE_RARITIES.includes(item.rarity)) {
    return `Dino Park egg items require rarity to be one of: ${SITE_RARITIES.join(', ')}`;
  }
  return null;
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

async function getQueue(env) {
  return await env.MARKETPLACE.get('item_code_queue', 'json') || [];
}

async function saveQueue(env, queue) {
  await env.MARKETPLACE.put('item_code_queue', JSON.stringify(queue));
}

async function getCodeRecord(env, code) {
  return await env.MARKETPLACE.get(`item_code_${code}`, 'json');
}

async function saveCodeRecord(env, code, record) {
  await env.MARKETPLACE.put(`item_code_${code}`, JSON.stringify(record));
}

/* ── Exported functions for twitch-bot ────────── */

export async function activateItemCode(env, code, durationSeconds = 300) {
  const record = await getCodeRecord(env, code);
  if (!record) return null;
  if (record.active) return record;

  const now = Date.now();
  record.active = true;
  record.activatedAt = now;
  record.expiresAt = now + (durationSeconds * 1000);
  await saveCodeRecord(env, code, record);
  return record;
}

export async function activateNextItemCode(env, durationSeconds = 300) {
  const queue = await getQueue(env);
  if (queue.length === 0) return null;

  const code = queue.shift();
  await saveQueue(env, queue);
  return await activateItemCode(env, code, durationSeconds);
}

/* ── GET — list pending/active codes ──────────── */

export async function onRequestGet(context) {
  const { env, request } = context;
  const session = getSession(request);
  if (!session) return json({ error: 'Not logged in' }, 401);

  const url = new URL(request.url);
  const action = url.searchParams.get('action');

  if (action === 'queue') {
    if (session.role !== 'broadcaster' && session.role !== 'moderator') {
      return json({ error: 'Unauthorized' }, 403);
    }

    const queue = await getQueue(env);
    const now = Date.now();
    const pending = [];
    const active = [];

    for (const code of queue) {
      const record = await getCodeRecord(env, code);
      if (record) pending.push({ code: record.code, item: record.item });
    }

    const allKeys = await env.MARKETPLACE.list({ prefix: 'item_code_' });
    for (const key of allKeys.keys) {
      if (key.name === 'item_code_queue') continue;
      const record = await env.MARKETPLACE.get(key.name, 'json');
      if (record && record.active && record.expiresAt > now) {
        active.push({ code: record.code, item: record.item, expiresAt: record.expiresAt });
      }
    }

    return json({ pending, active });
  }

  return json({ error: 'Invalid action' }, 400);
}

/* ── POST — create / redeem codes ─────────────── */

export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);
  if (!session) return json({ error: 'Not logged in' }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  if (body.action === 'create') {
    return await handleCreate(env, session, body);
  }

  if (body.action === 'redeem') {
    return await handleRedeem(env, session, body);
  }

  return json({ error: 'Invalid action' }, 400);
}

/* ── Exported for server-to-server callers (e.g. monthly leaderboard
   awards in leaderboards.js) — bypasses the HTTP session/role check
   since the caller already knows it's an authorized, internal grant. ── */
export async function createItemCode(env, item) {
  const invalidReason = validateItemShape(item);
  if (invalidReason) throw new Error(invalidReason);

  const code = generateCode();
  const record = {
    code,
    item: {
      id: item.id,
      game: item.game,
      type: item.type,
      name: item.name,
      rarity: item.rarity || 'common',
      consumable: item.consumable || false,
      quantity: item.quantity || 1,
    },
    active: false,
    createdAt: Date.now(),
    activatedAt: null,
    expiresAt: null,
    redeemedBy: [],
  };

  await saveCodeRecord(env, code, record);
  return record;
}

async function handleCreate(env, session, body) {
  if (session.role !== 'broadcaster' && session.role !== 'moderator') {
    return json({ error: 'Unauthorized' }, 403);
  }

  const item = body.item;
  const invalidReason = validateItemShape(item);
  if (invalidReason) return json({ error: invalidReason }, 400);

  const record = await createItemCode(env, item);

  const queue = await getQueue(env);
  queue.push(record.code);
  await saveQueue(env, queue);

  return json({ success: true, code: record.code, item: record.item });
}

async function handleRedeem(env, session, body) {
  const code = (body.code || '').trim().toUpperCase();
  if (!code) return json({ error: 'No code provided' }, 400);

  const record = await getCodeRecord(env, code);
  if (!record) return json({ error: 'Invalid code' }, 404);

  if (!record.active) return json({ error: 'Code is not active' }, 400);

  if (Date.now() >= record.expiresAt) {
    return json({ error: 'Code has expired' }, 410);
  }

  const userId = session.user_id;
  if (record.redeemedBy.includes(userId)) {
    return json({ error: 'Already redeemed' }, 409);
  }

  if (record.item.game === 'dino-park' && record.item.type === 'egg') {
    return await redeemDinoEgg(env, record, code, userId);
  }

  record.redeemedBy.push(userId);
  await saveCodeRecord(env, code, record);

  const inv = await getInventory(env, userId);
  const existing = inv.items.find(i => i.id === record.item.id && !i.consumable);
  if (!existing) {
    inv.items.push({
      id: record.item.id,
      game: record.item.game,
      type: record.item.type,
      name: record.item.name,
      rarity: record.item.rarity || 'common',
      consumable: record.item.consumable || false,
      quantity: record.item.quantity || 1,
      grantedAt: Date.now(),
      source: 'item-code',
    });
    await saveInventory(env, userId, inv);
  }

  return json({ success: true, item: record.item });
}

/* Dino Park eggs bypass the generic inventory grant path entirely — the
   item is granted straight through game-dino-park's own grantEgg(),
   using only the rarity stored server-side on the code record (never
   anything from the request body). A mythic code coin-flips epic vs.
   legendary here, at grant time, so the player is told the real tier
   that landed rather than the generic "mythic" label. Loaded via a
   dynamic import so a not-yet-deployed dino-park.js (this is a
   coordinated cross-agent feature) fails soft instead of breaking the
   rest of this module. */
async function redeemDinoEgg(env, record, code, userId) {
  const siteRarity = record.item.rarity || 'common';
  const dinoTier = rollDinoEggTier(siteRarity);

  let grantEgg;
  try {
    ({ grantEgg } = await import('./dino-park.js'));
  } catch {
    grantEgg = null;
  }

  if (typeof grantEgg !== 'function') {
    return json({ error: 'Dino Park egg redemption is not available right now. Try again later.' }, 503);
  }

  let result;
  try {
    result = await grantEgg(env, userId, dinoTier);
  } catch {
    return json({ error: 'Something went wrong granting your egg. Try again.' }, 500);
  }

  if (!result || !result.success) {
    /* Do NOT mark the code redeemed for this user — e.g. an incubator-full
       failure should let them free up space and retry the same code.
       Status 400 (not 409) so the redemption page shows this real error
       instead of the generic "already redeemed" message it shows for 409. */
    return json({ error: (result && result.error) || 'Could not grant your egg right now.' }, 400);
  }

  record.redeemedBy.push(userId);
  await saveCodeRecord(env, code, record);

  return json({
    success: true,
    item: {
      id: record.item.id,
      game: 'dino-park',
      type: 'egg',
      name: `${capitalize(dinoTier)} Dino Park Egg`,
      rarity: siteRarity,
      dinoTier,
      speciesId: result.egg && result.egg.speciesId,
      hatchTime: result.egg && result.egg.hatchTime,
    },
  });
}
