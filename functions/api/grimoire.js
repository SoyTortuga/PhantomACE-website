/* ══════════════════════════════════════════════
   THE SEASONAL GRIMOIRE

     GET /api/grimoire?u=<login>
     GET /api/grimoire?id=<userId>

   A per-month collection log for a profile: for each season month, which of
   that month's collectible cosmetics the person owns and which they are still
   missing, plus whether the set is complete.

   PUBLIC, LIKE /api/profile. Viewing a grimoire needs no login — it reports a
   set defined server-side (season-manifest.js) measured against a public
   inventory, never the raw inventory. The month's set is the SAME one the
   Phamily Time pass grants from, so there is no second copy of the month data
   to drift.

   THE SET BADGE IS GRANTED ON YOUR OWN PROFILE ONLY. When the viewer is the
   person whose grimoire this is, and a month is complete, and they do not yet
   own that month's `grimoire-<mk>` badge, it is granted here inside the
   inventory mutate — idempotent, so a second view is a no-op. Viewing somebody
   else's complete grimoire never grants anything, to anyone.
   ══════════════════════════════════════════════ */

import { setForMonth, collectionForMonth, setBadgeId } from './season-manifest.js';
import { THEMED_MONTHS, ROOM_DRIP_MONTHS, themeKeyFor } from './phamily-rewards.js';
import { bannerVariant, bannerPath } from './cosmetics.js';
import { monthKey } from './season-time.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

/* Anchored so a cookie whose name merely ENDS in pham_session cannot be read
   as the session — the same regex profile-adjacent handlers use. */
function getSession(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)pham_session=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match[1])); } catch { return null; }
}

/* Reused from profile.js: resolve ?id= or ?u= to a stable user id, charset
   checked before it reaches the store. The caller still verifies a ?u= lookup
   against the record it lands on, so a moved login resolves to nothing. */
async function resolveUserId(env, url) {
  const id = (url.searchParams.get('id') || '').trim();
  if (id) return /^[0-9]+$/.test(id) ? id : null;

  const login = (url.searchParams.get('u') || '').trim().toLowerCase();
  if (!/^[a-z0-9_]{1,30}$/.test(login)) return null;

  const mapped = await env.MARKETPLACE.get(`loginidx_${login}`);
  return mapped ? String(mapped).trim() : null;
}

/* "2026-10" -> "October 2026", from the string alone so it never crosses a
   timezone boundary turning a Date back into a month. */
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
function monthLabelOf(mk) {
  const [y, m] = String(mk).split('-').map(Number);
  const name = MONTH_NAMES[m - 1];
  return name ? `${name} ${y}` : String(mk);
}

/* Every month the Grimoire lists: the themed months, the room-drip months, and
   the current one — then narrowed to those that actually pay a collectible set.
   Newest first, because the current season is what a visitor came to see. */
function seasonMonths() {
  const months = new Set([...THEMED_MONTHS, ...ROOM_DRIP_MONTHS, monthKey()]);
  return [...months]
    .filter(mk => setForMonth(mk).length > 0)
    .sort()
    .reverse();
}

/* A derivable image for a set entry, on the same terms as profile.js's
   publicItem: a path where one can be built, otherwise null so the client
   falls back to the rarity glyph. Milestone badges point at per-level art
   (themed when the month is themed); milestone banners resolve through the
   shared banner variant mapping. Everything else has no single canonical
   image here and renders as its glyph. */
function entryImage(entry, mk) {
  if (entry.type === 'badge' && entry.source === 'milestone') {
    const theme = themeKeyFor(mk);
    return theme
      ? `/assets/badges/milestones/ms-${theme}-${entry.level}.png`
      : `/assets/badges/milestones/ms-${entry.level}.png`;
  }
  if (entry.type === 'banner') {
    return bannerPath(bannerVariant({ rarity: entry.rarity, theme: entry.theme }));
  }
  return null;
}

/* What a set entry looks like on the page — never the raw inventory item, just
   what a collection log shows: name, type, rarity, theme, where it came from,
   and an image where one is derivable. */
function publicEntry(entry, mk) {
  return {
    itemId: entry.itemId,
    name: entry.name,
    type: entry.type,
    storedType: entry.storedType,
    rarity: entry.rarity || 'common',
    theme: entry.theme || null,
    source: entry.source,
    track: entry.track || null,
    level: entry.level || null,
    image: entryImage(entry, mk),
  };
}

/* The set-completion badge, as it is granted and as it is shown. One shape, so
   the grant below and the display agree. */
function setBadge(mk) {
  return {
    id: setBadgeId(mk),
    game: 'profile',
    type: 'badge',
    consumable: false,
    name: `${monthLabelOf(mk)} Grimoire`,
    rarity: 'exclusive',
    meta: { image: `/assets/badges/grimoire/${mk}.png`, grimoire: mk },
  };
}

/* Grant the set badge for a finished month, on the owner's own inventory only.
   Idempotent under the per-key lock: the dedupe lives inside the mutator so two
   concurrent views cannot both grant it, and a later view finds it present and
   writes nothing. Returns whether the badge is owned after this runs. */
async function grantSetBadge(env, userId, mk) {
  const badge = setBadge(mk);
  await env.MARKETPLACE.mutate(`inv_${userId}`, (cur) => {
    const inv = cur && typeof cur === 'object' ? cur : { userId, items: [], equips: {} };
    if (!Array.isArray(inv.items)) inv.items = [];
    if (!inv.equips || typeof inv.equips !== 'object') inv.equips = {};
    if (inv.items.find(i => i && i.id === badge.id && i.type === 'badge')) return undefined;
    inv.items.push({ ...badge, grantedAt: Date.now(), source: 'grimoire' });
    return inv;
  });
  return true;
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);

  const userId = await resolveUserId(env, url);
  if (!userId) return json({ error: 'No such profile' }, 404);

  const profile = await env.MARKETPLACE.get(`profile_${userId}`, 'json');
  if (!profile) return json({ error: 'No such profile' }, 404);

  /* The stale-login check, mirrored from profile.js: loginidx_ is rewritten on
     every login, so a ?u= pointer can outlive the name it points at. If the
     record no longer carries that login, nobody is there. */
  const asked = (url.searchParams.get('u') || '').trim().toLowerCase();
  if (asked && String(profile.login || '').toLowerCase() !== asked) {
    return json({ error: 'No such profile' }, 404);
  }

  const inv = await env.MARKETPLACE.get(`inv_${userId}`, 'json').catch(() => null);
  const items = inv && Array.isArray(inv.items) ? inv.items : [];

  /* Granting happens only when the viewer IS the person being viewed. A session
     for anyone else — or none — views without ever granting. */
  const session = getSession(request);
  const isOwner = !!(session && String(session.user_id) === String(userId));

  const months = [];
  for (const mk of seasonMonths()) {
    const col = collectionForMonth(items, mk);

    /* Owner + complete + not yet badged -> grant, then this month reads as
       earned. Re-read ownership from the set entry after the grant so the
       response reflects it without a second round-trip to the inventory. */
    let badgeEarned = items.some(i => i && i.id === setBadgeId(mk) && i.type === 'badge');
    if (isOwner && col.complete && !badgeEarned) {
      await grantSetBadge(env, userId, mk);
      badgeEarned = true;
    }

    const badge = setBadge(mk);
    months.push({
      month: mk,
      label: monthLabelOf(mk),
      theme: themeKeyFor(mk) || null,
      total: col.total,
      ownedCount: col.owned.length,
      missingCount: col.missing.length,
      complete: col.complete,
      badgeEarned,
      badge: { id: badge.id, name: badge.name, rarity: badge.rarity, image: badge.meta.image },
      owned: col.owned.map(e => publicEntry(e, mk)),
      missing: col.missing.map(e => publicEntry(e, mk)),
    });
  }

  return json({
    userId: String(userId),
    login: profile.login || '',
    displayName: profile.displayName || profile.login || '',
    isOwner,
    months,
  });
}
