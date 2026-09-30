/* ══════════════════════════════════════════════
   SHARED COSMETICS RESOLVER (server)

   The server-side companion to js/cosmetic-variants.js. It resolves which
   name-effect and banner variant a set of users has EQUIPPED, so any surface
   that lists people — leaderboards now, chat next — can show their cosmetics
   without each row fetching its own inventory.

   The variant mapping is a deliberate mirror of variantOf() in
   js/cosmetic-variants.js: that file is a browser <script> and can't be
   imported here, so the two carry the same logic and
   server/scripts/test-cosmetics.js asserts they never drift.

   THE CONTRACT chat-system will reuse:

     import { resolveEquippedCosmetics } from './cosmetics.js';
     const map = await resolveEquippedCosmetics(env, userIds);
     // map[userId] === { nameEffect: 'rare'|'mythic'|'exclusive'|null,
     //                   banner:     'rare'|'mythic'|'exclusive'|null }

   - userIds may contain duplicates and guest_ ids; the result has one entry
     per requested id.
   - Guests (guest_*) and users with no inventory resolve to { null, null }.
   - It is BATCHED: ids are de-duplicated and each real inventory is read once,
     never once per rendered name.
   ══════════════════════════════════════════════ */

/* Keep this identical to variantOf() in js/cosmetic-variants.js. */
export function nameEffectVariant(item) {
  if (!item) return null;
  const meta = item.meta || {};
  const effect = meta.effect || item.effect || '';
  const name = String(item.name || '');
  if (effect === 'exclusive' || /exclusive/i.test(name)) return 'exclusive';
  if (effect === 'mythic') return 'mythic';
  if (effect === 'rare') return 'rare';
  if (item.rarity === 'mythic') return 'mythic';
  return 'rare';
}

/* Name effects and banners map the same way — one core, two names so the
   contract reads clearly at each call site. */
export const bannerVariant = nameEffectVariant;

export function bannerPath(variant) {
  return variant ? `/assets/banners/banner-${variant}.png` : null;
}

/**
 * Resolve the equipped name-effect and banner variant for each user id.
 *
 * @param {*} env  the Worker env (needs env.MARKETPLACE.get)
 * @param {string[]} userIds  ids to resolve (dupes and guests allowed)
 * @returns {Promise<Object<string,{nameEffect:string|null,banner:string|null}>>}
 */
export async function resolveEquippedCosmetics(env, userIds) {
  const out = {};
  const requested = Array.isArray(userIds) ? userIds.map(String) : [];

  /* Every requested id gets an answer, guests included. */
  for (const id of requested) out[id] = { nameEffect: null, banner: null };

  /* One read per unique real user — dedupe, drop guests. */
  const unique = [...new Set(requested)].filter(id => id && !id.startsWith('guest_'));

  for (const id of unique) {
    let inv = null;
    try {
      inv = await env.MARKETPLACE.get(`inv_${id}`, 'json');
    } catch {
      inv = null;                       // one unreadable inventory must not fail the batch
    }
    if (!inv) continue;

    const equips = (inv.equips && inv.equips.profile) || {};
    const items = Array.isArray(inv.items) ? inv.items : [];
    const byId = (iid) => (iid ? items.find(i => i.id === iid) || null : null);

    out[id] = {
      nameEffect: nameEffectVariant(byId(equips['name-effect'])),
      banner: bannerVariant(byId(equips.banner)),
    };
  }

  return out;
}
