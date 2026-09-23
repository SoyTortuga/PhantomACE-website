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
  if (item.guaranteedMutation && !(item.game === 'dino-park' && item.type === 'egg')) {
    return 'guaranteedMutation only applies to Dino Park egg items';
  }
  /* Artwork must be a path on this site. A code record is rendered in a
     viewer's browser, so an off-site URL here would be an image address of
     someone else's choosing loaded by everyone who redeems. */
  if (item.image !== undefined && item.image !== null) {
    if (typeof item.image !== 'string' || !item.image.startsWith('/') || item.image.startsWith('//')) {
      return 'item.image must be a site-relative path beginning with a single /';
    }
  }
  return null;
}

/* A raid kill-reward code (skull-raid.js awardRaidRewards): a per-raid,
   per-account badge id, in the skull-clicker game. These advance the raid
   kill-participation ladder rather than granting the code's own item. */
function isRaidKillCode(item) {
  return !!item && typeof item.id === 'string' && item.id.startsWith('raid_')
    && item.game === 'skull-clicker' && item.type === 'badge';
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

/* ── Redemption claiming ───────────────────────
   "Has this user redeemed?" and "mark them as having redeemed" used to be
   a check followed by a push-and-save. Two requests from the same account
   arriving together both saw themselves absent, both granted the item, and
   the second save overwrote the first — so a code good for one item handed
   out two. mutate() makes read and write one locked operation, and reports
   which caller actually added the id. */
async function claimRedemption(env, code, userId) {
  let claimed = false;
  await env.MARKETPLACE.mutate(`item_code_${code}`, (current) => {
    if (!current) return undefined;
    const list = current.redeemedBy || [];
    if (list.includes(userId)) return undefined;   // someone else got here first
    claimed = true;
    return { ...current, redeemedBy: [...list, userId] };
  });
  return claimed;
}

/* Undo a claim. Used only when granting fails after the claim succeeded —
   an incubator-full egg must leave the code redeemable so the player can
   make space and retry. */
async function releaseRedemption(env, code, userId) {
  await env.MARKETPLACE.mutate(`item_code_${code}`, (current) => {
    if (!current) return undefined;
    const list = current.redeemedBy || [];
    if (!list.includes(userId)) return undefined;
    return { ...current, redeemedBy: list.filter(id => id !== userId) };
  });
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

    /* One query instead of a list() plus a get() per code.
       The `item_code_queue` skip this loop used to need is gone: that key
       is a singleton and now lives in its own table, while item_code_* codes
       live in item_codes, so a prefix scan cannot pick the queue up. The
       registry resolves exact keys before prefixes precisely so that
       collision stops needing a hardcoded exception. */
    const rows = await env.MARKETPLACE.listValues({ prefix: 'item_code_' });
    for (const { value: record } of rows) {
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
/**
 * @param {object} item the reward
 * @param {object} [opts]
 * @param {string[]} [opts.restrictedTo] user ids allowed to redeem. Omit for
 *   a public code. Present = nobody else can redeem it even knowing the
 *   string, which is what makes a code safe to hand to a named person.
 */
export async function createItemCode(env, item, opts = {}) {
  const invalidReason = validateItemShape(item);
  if (invalidReason) throw new Error(invalidReason);

  const code = generateCode();
  const record = {
    code,
    /* Fields are picked explicitly rather than spread, so a typo in a caller
       cannot smuggle an unexpected field into a stored reward. Anything new
       has to be added here deliberately — which is why guaranteedMutation
       appears below. */
    item: {
      id: item.id,
      game: item.game,
      type: item.type,
      name: item.name,
      rarity: item.rarity || 'common',
      consumable: item.consumable || false,
      quantity: item.quantity || 1,
      guaranteedMutation: item.guaranteedMutation || false,
      /* Carried explicitly, like every other field here. Badges are the only
         items with art of their own, and without this a badge redeemed from
         a code lands in the inventory with nothing to draw — it falls back
         to the slot emoji and reads as a missing asset. */
      image: item.image || null,
    },
    active: false,
    createdAt: Date.now(),
    activatedAt: null,
    expiresAt: null,
    redeemedBy: [],
    /* null means public. An array means only these accounts may redeem,
       regardless of who learns the code. */
    restrictedTo: Array.isArray(opts.restrictedTo) && opts.restrictedTo.length
      ? opts.restrictedTo.map(String)
      : null,
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

  /* Account restriction, checked before anything is granted. A restricted
     code is useless to anyone outside the list even if the string leaks —
     which is the whole point, given 171 public giveaway codes were
     downloadable from the site until recently.

     Deliberately the same "Invalid code" wording as an unknown code: telling
     a stranger that a code is real but not theirs invites them to go looking
     for whose it is. */
  if (Array.isArray(record.restrictedTo) && !record.restrictedTo.includes(String(userId))) {
    return json({ error: 'Invalid code' }, 404);
  }

  if (record.redeemedBy.includes(userId)) {
    return json({ error: 'Already redeemed' }, 409);
  }

  if (record.item.game === 'dino-park' && record.item.type === 'egg') {
    return await redeemDinoEgg(env, record, code, userId);
  }

  if (!(await claimRedemption(env, code, userId))) {
    return json({ error: 'Already redeemed' }, 409);
  }

  /* Raid kill-reward codes ("<boss> Raider/Slayer", minted in skull-raid.js
     with an id like raid_<raidId>_u_<uid>) don't grant a one-off badge — that
     was the bug, an art-less unique badge per raid. Each one instead advances
     the kill-participation ladder by one, whose count grants the Undead
     Executioner tier badges (1/10/25/50/100), separate from the summon ladder. */
  if (isRaidKillCode(record.item)) {
    let grantedTiers = [];
    try {
      const { recordRaidKill } = await import('./raid-badges.js');
      grantedTiers = await recordRaidKill(env, userId);
    } catch (err) {
      console.error('[item-codes] raid-kill grant failed:', err.message);
    }
    return json({ success: true, item: record.item, raidKill: true, grantedTiers });
  }

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
      /* meta is where the inventory looks for artwork, matching imported
         Twitch badges. Omitted entirely when there is none, so items without
         art keep the shape they have always had. */
      ...(record.item.image ? { meta: { image: record.item.image } } : {}),
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

  /* Claim BEFORE granting. Claiming afterwards cannot prevent the problem
     it exists to prevent — two simultaneous requests would each grant an
     egg and only then discover they had collided, by which point two eggs
     are already in the incubator. Every failure path below releases the
     claim, which is what preserves "incubator full, free up space and
     retry the same code". */
  if (!(await claimRedemption(env, code, userId))) {
    return json({ error: 'Already redeemed' }, 409);
  }

  let result;
  try {
    result = await grantEgg(env, userId, dinoTier, {
      guaranteedMutation: !!record.item.guaranteedMutation,
    });
  } catch {
    await releaseRedemption(env, code, userId);
    return json({ error: 'Something went wrong granting your egg. Try again.' }, 500);
  }

  /* INCUBATOR FULL IS NOT A FAILURE ANY MORE — the egg goes to the player's
     inventory instead, which the Eggs tab already surfaces as "N egg(s) —
     click to use!" and which useInventoryEgg() moves into the incubator when
     a slot frees. The inventory is effectively the idle-egg area.

     Three things this fixes at once:
       - Twelve compensation codes can all be redeemed immediately, rather
         than three at a time across several sessions.
       - Nobody has to retry a code later and wonder if it was consumed.
       - The inventory lives under inv_{userId}, a key the Dino Park client
         never blindly overwrites — unlike dino_park_{userId}, where a
         server-granted egg can still be clobbered by the client's next
         full-state save.

     meta carries the EXACT tier: useInventoryEgg re-rolls rarity from
     weights unless meta.guaranteed is set, so without it a mythic egg would
     silently degrade into a mostly-common roll. */
  if (result && !result.success && result.error === 'Incubator full') {
    const inv = await getInventory(env, userId);
    inv.items.push({
      id: record.item.id,
      game: 'dino-park',
      type: 'egg',
      name: record.item.name || `${capitalize(dinoTier)} Dino Park Egg`,
      rarity: siteRarity,
      consumable: true,
      quantity: 1,
      grantedAt: Date.now(),
      source: 'item-code',
      meta: {
        guaranteed: true,
        rarity: dinoTier,
        guaranteedMutation: !!record.item.guaranteedMutation,
      },
    });
    await saveInventory(env, userId, inv);

    return json({
      success: true,
      placed: 'inventory',
      message: 'Incubator was full — the egg is waiting in your inventory.',
      item: {
        id: record.item.id,
        game: 'dino-park',
        type: 'egg',
        name: `${capitalize(dinoTier)} Dino Park Egg`,
        rarity: siteRarity,
        dinoTier,
      },
    });
  }

  if (!result || !result.success) {
    /* Any OTHER failure releases the claim so the code stays redeemable.
       Status 400 (not 409) so the redemption page shows this real error
       instead of the generic "already redeemed" message it shows for 409. */
    await releaseRedemption(env, code, userId);
    return json({ error: (result && result.error) || 'Could not grant your egg right now.' }, 400);
  }

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
