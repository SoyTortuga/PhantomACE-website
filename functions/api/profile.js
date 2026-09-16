/* ══════════════════════════════════════════════
   PUBLIC PROFILE

     GET /api/profile?u=<login>
     GET /api/profile?id=<userId>

   Everything a page needs to render somebody who is not the viewer.

   PUBLIC BY DESIGN, AND NARROW BY DESIGN. It returns what a person has
   chosen to display — their showcase, what they have equipped, where they
   stand on boards that are already public — and never their inventory.
   Owning something and showing it are different decisions, and the
   showcase is where that decision is made.

   A LOGIN IS NOT AN IDENTITY. Twitch lets people change their login, and
   frees the old one for somebody else. The record is keyed by user id,
   which is stable; loginidx_ only points at one. The pointer is verified
   against the record it lands on, so a login that has moved resolves to
   nothing rather than to whoever holds it now.
   ══════════════════════════════════════════════ */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

/** The boards a profile reports a placing on, and what each one counts. */
const BOARDS = [
  { key: 'sc_leaderboard',     game: 'skull-clicker',    label: 'Skull Clicker', unit: 'High Score' },
  { key: 'lb_mana_clash',      game: 'mana-clash',       label: 'Mana Clash',    unit: 'High Score' },
  { key: 'lb_mana_clash_wins', game: 'mana-clash-wins',  label: 'Mana Clash',    unit: 'Wins' },
  { key: 'lb_mtgbbb',          game: 'mtgbbb',           label: 'MTGBBB',        unit: 'Points' },
  { key: 'lb_shell_shock',     game: 'pham-shock',       label: 'PhamShock',     unit: 'Wins' },
  { key: 'lb_bingo',           game: 'commander-bingo',  label: 'Commander Bingo', unit: 'Bingos' },
  { key: 'lb_memory_match',    game: 'memory-match',     label: 'Memory Match',  unit: 'Best Moves', asc: true },
];

async function resolveUserId(env, url) {
  const id = (url.searchParams.get('id') || '').trim();
  if (id) return /^[0-9]+$/.test(id) ? id : null;

  const login = (url.searchParams.get('u') || '').trim().toLowerCase();
  /* Twitch logins are 4-25 characters of letters, digits and underscore.
     Checked before it reaches the store so a malformed one is a 400 rather
     than a lookup. */
  if (!/^[a-z0-9_]{1,30}$/.test(login)) return null;

  const mapped = await env.MARKETPLACE.get(`loginidx_${login}`);
  return mapped ? String(mapped).trim() : null;
}

/** Where someone sits on one board, or null if they are not on it. */
function placingIn(rows, userId, board) {
  if (!Array.isArray(rows)) return null;
  const sorted = [...rows].sort((a, b) =>
    board.asc ? (a.score - b.score) : (b.score - a.score));
  const i = sorted.findIndex(r => String(r.id ?? r.userId) === String(userId));
  if (i === -1) return null;
  return {
    game: board.label,
    unit: board.unit,
    rank: i + 1,
    of: sorted.length,
    score: sorted[i].score,
  };
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);

  const userId = await resolveUserId(env, url);
  if (!userId) return json({ error: 'No such profile' }, 404);

  const profile = await env.MARKETPLACE.get(`profile_${userId}`, 'json');
  if (!profile) return json({ error: 'No such profile' }, 404);

  /* THE STALE-LOGIN CHECK. loginidx_ is rewritten on every login, so an
     entry can outlive the person who owned that name. If the record it
     points at no longer carries that login, the pointer is stale and the
     honest answer is that nobody is there. */
  const asked = (url.searchParams.get('u') || '').trim().toLowerCase();
  if (asked && String(profile.login || '').toLowerCase() !== asked) {
    return json({ error: 'No such profile' }, 404);
  }

  const inv = await env.MARKETPLACE.get(`inv_${userId}`, 'json') || { items: [], equips: {} };
  const items = Array.isArray(inv.items) ? inv.items : [];
  const equips = (inv.equips && inv.equips.profile) || {};

  const publicItem = (i) => ({
    id: i.id,
    name: i.name,
    rarity: i.rarity || 'common',
    type: i.type,
    image: (i.meta && (i.meta.image || i.meta.imageUrl4x || i.meta.imageUrl2x || i.meta.imageUrl1x)) || null,
    months: (i.meta && i.meta.monthThreshold) || null,
    founder: !!(i.meta && i.meta.founder),
  });

  const byId = (id) => items.find(i => i.id === id) || null;

  /* What they chose to show, in the order they chose. A showcase slot whose
     item has since gone is skipped rather than rendered as a hole. */
  const showcase = ((equips.badgeShowcase) || [])
    .map(id => items.find(i => i.id === id && i.type === 'badge'))
    .filter(Boolean)
    .map(publicItem);

  const equipped = {};
  for (const slot of ['badge', 'title', 'banner', 'name-effect']) {
    const item = byId(equips[slot]);
    equipped[slot] = item ? publicItem(item) : null;
  }

  /* Counts, not contents. How much someone has collected is a fair thing to
     show; what is in it is theirs. */
  const collection = {};
  for (const i of items) {
    if (i.game !== 'profile') continue;
    collection[i.type] = (collection[i.type] || 0) + 1;
  }

  /* Subscriber tenure, from the badge they wear in chat — the only place
     Twitch exposes cumulative months. Absent for anyone who has not spoken
     since it began being recorded, and for the broadcaster, who cannot
     subscribe to themselves. */
  let tenure = null;
  try {
    const seen = await env.MARKETPLACE.get(`sub_months_${userId}`, 'json');
    if (seen) {
      tenure = {
        months: Number(seen.months) || 0,
        tier: Number(seen.tier) || 1,
        founder: !!seen.founder,
      };
    }
  } catch { /* the store cannot answer; a profile without tenure still renders */ }

  /* Phamily Time: this month's watch level. */
  let phamilyTime = null;
  try {
    const { monthKey } = await import('./giveaway-entries.js');
    const pt = await env.MARKETPLACE.get(`pt_${userId}_${monthKey()}`, 'json');
    if (pt) {
      phamilyTime = {
        level: Number(pt.level) || 0,
        minutes: Number(pt.minutes) || 0,
        month: monthKey(),
      };
    }
  } catch { /* optional */ }

  /* Their favourite dino, if they have chosen one. Already sanitised when
     the park was saved — see dino-park.js — so it is echoed rather than
     re-checked here. The nickname is player-authored and is escaped at
     render like any other. */
  let favoriteDino = null;
  try {
    const park = await env.MARKETPLACE.get(`dino_park_${userId}`, 'json');
    const fav = park && park.state && park.state.favorite;
    if (fav && fav.specId && fav.src) {
      favoriteDino = {
        specId: fav.specId,
        mutation: fav.mutation || '',
        nickname: fav.nickname || '',
        src: fav.src,
        filter: fav.filter || '',
      };
    }
  } catch { /* a profile without a dino still renders */ }

  /* Standings, only on boards they actually appear on. */
  const standings = [];
  for (const board of BOARDS) {
    try {
      const rows = await env.MARKETPLACE.get(board.key, 'json');
      const placing = placingIn(rows, userId, board);
      if (placing) standings.push(placing);
    } catch { /* one missing board must not cost the others */ }
  }
  standings.sort((a, b) => a.rank - b.rank);

  return json({
    userId: String(userId),
    login: profile.login || '',
    displayName: profile.displayName || profile.login || '',
    avatar: profile.avatar || '',
    role: profile.role || 'viewer',
    firstSeen: profile.firstSeen || null,
    showcase,
    equipped,
    collection,
    tenure,
    phamilyTime,
    standings,
    favoriteDino,
  });
}
