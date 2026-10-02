/* ══════════════════════════════════════════════
   MEMBER DIRECTORY

     GET /api/members?page=<n>&q=<term>&sort=joined|name

   A public, paged roll of everyone who has ever signed in — the companion to
   /api/profile, which renders one person. It shows only what a profile already
   shows the world: display name, avatar, role, join date, and the title and
   badge they have equipped. Never an inventory, never bio prose beyond what a
   card can hold.

   TWO SCANS, NEVER N+1. The whole directory is built from exactly two reads:
   one listValues() over profile_ rows, and — for the sliced page only — one
   listValues() over inv_ rows to resolve equipped cosmetics. A row never
   fetches its own inventory, which is the N+1 that made the cosmetic
   leaderboard ~80 serial reads before resolveEquippedCosmetics batched it.
   ══════════════════════════════════════════════ */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export const PER_PAGE = 24;

const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic', 'exclusive'];
const normRarity = (r) => (RARITIES.includes(r) ? r : 'common');

/* firstSeen may be an ISO string (what auth writes) or, for an older record,
   a number of milliseconds. Anything unparseable sinks to the bottom of a
   newest-first sort rather than jumping to the top as a 1970 date. */
function joinedTs(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') { const t = Date.parse(v); return Number.isFinite(t) ? t : 0; }
  return 0;
}

function badgeImage(i) {
  return (i && i.meta && (i.meta.image || i.meta.imageUrl2x || i.meta.imageUrl1x)) || null;
}

/** The equipped title + badge a directory card shows, from one inventory. */
function equippedFrom(inv) {
  if (!inv || typeof inv !== 'object') return { title: null, badge: null };
  const items = Array.isArray(inv.items) ? inv.items : [];
  const eq = (inv.equips && inv.equips.profile) || {};
  const byId = (id) => (id ? items.find((i) => i && i.id === id) || null : null);
  const t = byId(eq.title);
  const b = byId(eq.badge);
  return {
    title: t && t.type === 'title' ? { name: String(t.name || ''), rarity: normRarity(t.rarity) } : null,
    badge: b && b.type === 'badge'
      ? { name: String(b.name || ''), rarity: normRarity(b.rarity), image: badgeImage(b) }
      : null,
  };
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);

  /* The search term is matched as a literal substring, never a pattern, and
     the charset is kept tight so it could never become one if this moved into
     SQL. An over-long or malformed term is treated as no search. */
  const rawQ = (url.searchParams.get('q') || '').trim().toLowerCase();
  const q = /^[a-z0-9_]{2,30}$/.test(rawQ) ? rawQ : '';

  const sort = url.searchParams.get('sort') === 'name' ? 'name' : 'joined';

  let page = parseInt(url.searchParams.get('page') || '1', 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  page = Math.min(page, 100000);

  /* SCAN ONE: every profile row, in a single query. */
  const rows = await env.MARKETPLACE.listValues({ prefix: 'profile_' });

  const members = [];
  for (const row of rows) {
    const p = row.value;
    if (!p || typeof p !== 'object' || !p.login) continue;      // skip malformed / stale rows
    const login = String(p.login);
    const displayName = String(p.displayName || p.login);
    if (q && login.toLowerCase().indexOf(q) === -1 && displayName.toLowerCase().indexOf(q) === -1) {
      continue;
    }
    members.push({
      userId: String(row.name).slice('profile_'.length),
      login,
      displayName,
      avatar: typeof p.avatar === 'string' ? p.avatar : '',
      role: p.role || 'viewer',
      firstSeen: p.firstSeen || null,
      _ts: joinedTs(p.firstSeen),
    });
  }

  if (sort === 'name') {
    members.sort((a, b) =>
      a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase()) ||
      a.login.localeCompare(b.login));
  } else {
    members.sort((a, b) =>
      b._ts - a._ts ||
      a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase()));
  }

  const total = members.length;
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  const start = (page - 1) * PER_PAGE;
  const pageMembers = members.slice(start, start + PER_PAGE).map((m) => ({
    userId: m.userId,
    login: m.login,
    displayName: m.displayName,
    avatar: m.avatar,
    role: m.role,
    firstSeen: m.firstSeen,
    title: null,
    badge: null,
  }));

  /* SCAN TWO: equipped cosmetics for the page, from one inventory scan. The
     page is small, so the map is filtered to the ids it needs; no row makes
     its own get(). */
  if (pageMembers.length) {
    const want = new Set(pageMembers.map((m) => `inv_${m.userId}`));
    const invRows = await env.MARKETPLACE.listValues({ prefix: 'inv_' });
    const invByKey = new Map();
    for (const r of invRows) if (want.has(r.name)) invByKey.set(r.name, r.value);
    for (const m of pageMembers) {
      const eq = equippedFrom(invByKey.get(`inv_${m.userId}`));
      m.title = eq.title;
      m.badge = eq.badge;
    }
  }

  return json({ members: pageMembers, total, page, pages, perPage: PER_PAGE, q, sort });
}
