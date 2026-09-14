/* ══════════════════════════════════════════════
   MONTHLY COMMUNITY LEADERBOARD

   Three boards, all for the CURRENT month, all read-only:

     entries  — this month's giveaway ledger
     hours    — Phamily Time watch hours this month
     streak   — consecutive-stream check-in streaks

   Public on purpose. The whole reason these systems feel worth engaging
   with is that the standings are visible; a ledger only the broadcaster can
   see is a spreadsheet, not a game.

   WHAT IS DELIBERATELY NOT HERE: user ids. The boards show display names
   and positions only. The ids are how every authorisation check in the site
   identifies a person, and there is no reason a public page needs to hand
   out a directory of them.

   Cached for a minute. This is three full-table reads, and it is linked
   from the nav — without the cache, a page refresh is a scan per visitor.
   ══════════════════════════════════════════════ */

const CACHE_KEY = 'community_leaderboard_cache';
const CACHE_MS = 60000;
const TOP_N = 10;

function monthKey(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/* A name we are willing to print. Anyone with no display name recorded
   shows as Anonymous rather than leaking the id we chose not to publish. */
function displayName(value, fallback) {
  const n = (value || '').trim();
  return n || fallback || 'Anonymous';
}

function topBy(rows, valueOf, nameOf) {
  return rows
    .map(r => ({ name: nameOf(r), value: valueOf(r) }))
    .filter(r => Number.isFinite(r.value) && r.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, TOP_N)
    .map((r, i) => ({ rank: i + 1, name: r.name, value: r.value }));
}

export async function onRequestGet(context) {
  const { env } = context;

  const cached = await env.MARKETPLACE.get(CACHE_KEY, 'json');
  if (cached && cached.builtAt > Date.now() - CACHE_MS) {
    return Response.json(cached.boards, { headers: { 'Cache-Control': 'public, max-age=60' } });
  }

  const month = monthKey();

  const [entryRows, phamilyRows, checkinRows] = await Promise.all([
    env.MARKETPLACE.listValues({ prefix: 'gwe_' }),
    env.MARKETPLACE.listValues({ prefix: 'pt_' }),
    env.MARKETPLACE.listValues({ prefix: 'ci_' }),
  ]);

  const entries = topBy(
    entryRows.map(r => r.value).filter(v => v && v.month === month),
    v => Math.floor(Number(v.entries) || 0),
    v => displayName(v.username)
  );

  /* pt_ covers BOTH pt_{id}_{month} and pt_alltime_{id}; the all-time rows
     have no `month`, so filtering on the current month excludes them without
     needing to know the key shape here. */
  const hours = topBy(
    phamilyRows.map(r => r.value).filter(v => v && v.month === month),
    v => Math.round((Number(v.hours) || 0) * 10) / 10,
    v => displayName(v.username, v.displayName)
  );

  const streaks = topBy(
    checkinRows.map(r => r.value).filter(Boolean),
    v => Math.floor(Number(v.streak) || 0),
    v => displayName(v.username)
  );

  const boards = { month, entries, hours, streaks, builtAt: Date.now() };

  await env.MARKETPLACE.put(CACHE_KEY, JSON.stringify({ boards, builtAt: Date.now() }), { expirationTtl: 120 });

  return Response.json(boards, { headers: { 'Cache-Control': 'public, max-age=60' } });
}
