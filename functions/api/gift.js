/* ══════════════════════════════════════════════
   COSMETIC GIFTING  (Community C4 slice)

   Transfer a genuine DUPLICATE monthly cosmetic from one member to another.

   SAFE BY CONSTRUCTION, mirroring the marketplace's two-sided settlement
   (functions/api/marketplace.js): there is no shared transaction across two
   inv_ rows, so the move is removal-first. One copy is taken out of the
   sender under THEIR row's lock — that single mutate() is what decides every
   race — then delivered to the recipient under theirs, and put back on the
   sender if delivery is refused or throws. A crash between the two leaves the
   copy with the sender, never duped and never vanished.

     ONLY A DUPLICATE MOVES. The sender must hold ≥2 copies (same id+type);
     the last copy can never leave. Two concurrent gifts of the same duplicate
     serialise on the sender's lock — the first takes count 2→1, the second
     sees 1 and is refused — so a duplicate can be gifted exactly once.

     ITEM COMES FROM THE SERVER, NEVER THE BODY. The delivered item is built
     from the sender's own stored entry; the request carries only which item
     and to whom, exactly as item-codes.js grants only what the code stored.

   KV touched: inv_<userId> (shared inventory) and gift_inbox_<userId> (a
   small, capped, self-expiring per-user notice list the recipient's next
   page load raises through the client bell).
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

/* The eligible set: monthly COSMETIC types only, every one non-consumable.
   Consumables (eggs, wildcards, bonus cards, giveaway entries) are excluded
   outright — they stack by quantity and "gifting a charge" is a different
   feature — as is room-slot, which is an account capacity unlock rather than
   a cosmetic you wear. Everything here is granted non-consumable by
   phamily-time.js REWARD_ITEM_MAP / import-badges / the reward grants. */
const GIFTABLE_TYPES = new Set([
  'badge', 'title', 'banner', 'name-effect',
  'cardback', 'emote-pack',
  'skull-skin', 'click-effect', 'cosmetic',
  'dice',
  'room-piece', 'room-set',
]);

const INBOX_KEEP = 25;
const INBOX_TTL = 30 * 24 * 60 * 60;   // 30 days — the bell is a courtesy; the item is already delivered

const inventoryKey = (userId) => `inv_${userId}`;
const giftInboxKey = (userId) => `gift_inbox_${userId}`;

function asInventory(cur, userId) {
  const inv = cur && typeof cur === 'object' ? cur : { userId, items: [], equips: {} };
  if (!Array.isArray(inv.items)) inv.items = [];
  if (!inv.equips || typeof inv.equips !== 'object') inv.equips = {};
  return inv;
}

const sameUser = (a, b) => String(a) === String(b);

/* How many copies of one cosmetic a person holds. Non-consumable cosmetics
   are one array entry per copy (item-codes.js / phamily-time.js refuse to
   merge non-consumables), so a duplicate is two matching entries. */
function copiesOf(items, id, type) {
  return items.filter(i => i && i.id === id && i.type === type && !i.consumable).length;
}

/* Resolve a recipient login to a real account, the same way profile.js does:
   loginidx_ points at a user id, and the pointer is verified against the
   record it lands on so a login that has since moved resolves to nobody. */
async function resolveRecipient(env, login) {
  const l = String(login || '').trim().toLowerCase();
  if (!/^[a-z0-9_]{1,30}$/.test(l)) return null;
  const mapped = await env.MARKETPLACE.get(`loginidx_${l}`);
  if (!mapped) return null;
  const userId = String(mapped).trim();
  const profile = await env.MARKETPLACE.get(`profile_${userId}`, 'json');
  if (!profile) return null;
  if (String(profile.login || '').toLowerCase() !== l) return null;   // stale pointer
  return { userId, login: profile.login, displayName: profile.displayName || profile.login };
}

/* ── GET — the recipient's pending gift notices ──
   Read-and-clear (claim), like marketplace earnings: the row is the bell
   queue, not durable state, so handing it over and deleting it keeps it tiny.
   The client dedupes by key, so a notice announces once even if two tabs
   race to read it and only one wins the claim. */
export async function onRequestGet(context) {
  const { env, request } = context;
  const session = getSession(request);
  if (!session) return json({ error: 'Not logged in' }, 401);

  let inbox = null;
  try { inbox = await env.MARKETPLACE.claim(giftInboxKey(session.user_id)); } catch { inbox = null; }
  const gifts = Array.isArray(inbox) ? inbox : [];
  return json({ gifts });
}

/* ── POST — gift a duplicate ─────────────────── */
export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);
  if (!session) return json({ error: 'Log in with Twitch to gift a cosmetic.' }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }
  if (!body || body.action !== 'gift') return json({ error: 'Unknown action' }, 400);

  const itemId = typeof body.itemId === 'string' ? body.itemId : '';
  const type = typeof body.type === 'string' ? body.type : '';
  const toLogin = typeof body.toLogin === 'string' ? body.toLogin : '';
  if (!itemId || !type) return json({ error: 'Missing item.' }, 400);
  if (!toLogin) return json({ error: 'Choose who to gift it to.' }, 400);
  if (!GIFTABLE_TYPES.has(type)) return json({ error: "That kind of item can't be gifted." }, 400);

  const senderId = session.user_id;

  const recipient = await resolveRecipient(env, toLogin);
  if (!recipient) return json({ error: 'No member by that name.' }, 404);
  if (sameUser(recipient.userId, senderId)) return json({ error: "You can't gift to yourself." }, 400);

  /* Step 1 — take ONE copy from the sender, under the sender's row lock.
     This mutate is the authority on ownership and on the duplicate rule. */
  let removed = null;
  let giftItem = null;
  let step1 = { ok: false, status: 400, error: 'Could not gift that item.' };
  await env.MARKETPLACE.mutate(inventoryKey(senderId), (cur) => {
    const inv = asInventory(cur, senderId);
    const matches = inv.items.filter(i => i && i.id === itemId && i.type === type && !i.consumable);
    if (matches.length === 0) { step1 = { ok: false, status: 404, error: "You don't own that cosmetic." }; return undefined; }
    if (matches.length < 2) {
      step1 = { ok: false, status: 400, error: 'You can only gift a duplicate — this is your only copy.' };
      return undefined;
    }
    const idx = inv.items.indexOf(matches[0]);
    removed = inv.items[idx];
    inv.items.splice(idx, 1);
    /* Built field-by-field from the stored entry, never the request: id, name,
       rarity and artwork are whatever the SENDER actually owned. */
    giftItem = {
      id: removed.id,
      game: removed.game,
      type: removed.type,
      name: removed.name,
      rarity: removed.rarity || 'common',
      consumable: false,
      quantity: 1,
      grantedAt: Date.now(),
      source: 'gift',
      giftedFrom: String(senderId),
      giftedFromName: session.display_name || '',
      ...(removed.meta && typeof removed.meta === 'object' ? { meta: { ...removed.meta } } : {}),
    };
    step1 = { ok: true };
    return inv;
  });
  if (!step1.ok) return json({ error: step1.error }, step1.status);

  /* Step 2 — deliver to the recipient, under THEIR row lock. Refuse if they
     already own it (checked here, inside the lock, so two gifts of the same
     cosmetic to the same person can't both land). */
  let step2 = { ok: false, status: 400, error: 'Could not deliver the gift.' };
  try {
    await env.MARKETPLACE.mutate(inventoryKey(recipient.userId), (cur) => {
      const inv = asInventory(cur, recipient.userId);
      const owns = inv.items.some(i => i && i.id === giftItem.id && i.game === giftItem.game && i.type === giftItem.type && !i.consumable);
      if (owns) { step2 = { ok: false, status: 409, error: `${recipient.displayName} already has that cosmetic.` }; return undefined; }
      inv.items.push(giftItem);
      step2 = { ok: true };
      return inv;
    });
  } catch (err) {
    step2 = { ok: false, status: 500, error: 'Could not deliver the gift. Try again.' };
    console.error('[gift] delivery threw:', err && err.message);
  }

  /* Put the copy back if delivery did not happen. Losing the copy AND the
     delivery is the one outcome worse than either alone. */
  if (!step2.ok) {
    try {
      await env.MARKETPLACE.mutate(inventoryKey(senderId), (cur) => {
        const inv = asInventory(cur, senderId);
        inv.items.push(removed);
        return inv;
      });
    } catch (err) {
      console.error('[gift] refund after failed delivery threw:', err && err.message);
    }
    return json({ error: step2.error }, step2.status);
  }

  /* The bell. Durable, capped, self-expiring; the recipient's next inventory
     load claims it and raises window.addNotification. Its failure must not
     undo a completed transfer, so it is best-effort. */
  try {
    await env.MARKETPLACE.mutate(giftInboxKey(recipient.userId), (cur) => {
      const list = Array.isArray(cur) ? cur : [];
      list.unshift({
        id: 'gift_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        fromName: session.display_name || 'Someone',
        item: { name: giftItem.name, rarity: giftItem.rarity },
        at: Date.now(),
      });
      return list.slice(0, INBOX_KEEP);
    }, { expirationTtl: INBOX_TTL });
  } catch (err) {
    console.error('[gift] inbox note failed (gift still delivered):', err && err.message);
  }

  return json({
    success: true,
    item: { id: giftItem.id, name: giftItem.name, rarity: giftItem.rarity, type: giftItem.type },
    to: { login: recipient.login, displayName: recipient.displayName },
  });
}
