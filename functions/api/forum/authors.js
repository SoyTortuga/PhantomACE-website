/* ══════════════════════════════════════════════
   FORUM — who wrote it

   A page of posts names its authors once each, not once per post: twenty
   replies by six people cost six lookups, done in parallel, and arrive as
   one map keyed by user id. The client joins them.

   What an author shows is what /api/profile shows — avatar, display name,
   equipped title and badge — read from the same profile_ and inv_ records,
   so a name on a post and a name on a profile can never disagree. Each
   author also carries `nameEffect` (the equipped name-effect variant, or
   null), resolved once for the whole page through the shared cosmetics
   resolver so the client can glow the name without a per-name lookup.

   Library, not a route: declared in NON_ROUTE_MODULES.
   ══════════════════════════════════════════════ */

import { resolveEquippedCosmetics } from '../cosmetics.js';

const MAX_AUTHORS = 80;

const UNKNOWN = (id) => ({ userId: id, login: '', displayName: 'Someone', avatar: '', title: null, badge: null, nameEffect: null });

function equippedItem(items, equips, slot, type) {
  const it = items.find(i => i && i.id === equips[slot] && i.type === type);
  if (!it) return null;
  const m = it.meta || {};
  return {
    name: it.name || '',
    rarity: it.rarity || 'common',
    image: m.image || m.imageUrl2x || m.imageUrl1x || null,
    founder: !!m.founder,
  };
}

async function identity(env, id) {
  const p = await env.MARKETPLACE.get(`profile_${id}`, 'json');
  if (!p) return UNKNOWN(id);
  const inv = await env.MARKETPLACE.get(`inv_${id}`, 'json');
  const items = inv && Array.isArray(inv.items) ? inv.items : [];
  const equips = (inv && inv.equips && inv.equips.profile) || {};
  return {
    userId: id,
    login: p.login || '',
    displayName: p.displayName || p.login || 'Someone',
    avatar: p.avatar || '',
    title: equippedItem(items, equips, 'title', 'title'),
    badge: equippedItem(items, equips, 'badge', 'badge'),
  };
}

/** { [userId]: identity } for every id given. One missing record must not
    cost the page the others, so each failure becomes an anonymous entry.
    Name-effect variants are resolved for the whole set in one batched call
    (one KV read per unique real id) and stapled on as `nameEffect`. */
export async function authorsFor(env, userIds) {
  const ids = [...new Set((userIds || []).filter(Boolean).map(String))].slice(0, MAX_AUTHORS);
  const out = {};
  const [, fx] = await Promise.all([
    Promise.all(ids.map(async (id) => {
      try { out[id] = await identity(env, id); }
      catch { out[id] = UNKNOWN(id); }
    })),
    resolveEquippedCosmetics(env, ids).catch(() => ({})),
  ]);
  for (const id of ids) out[id].nameEffect = (fx[id] && fx[id].nameEffect) || null;
  return out;
}
