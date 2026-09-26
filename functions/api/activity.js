/* ══════════════════════════════════════════════
   ACTIVITY FEED — a persisted log of stream events, viewable after the fact.

   The overlay and the bot fire on events and forget them; nothing kept the
   payload, so "who gifted those subs an hour ago?" had no answer. This records
   each celebration/redemption event WITH its raw payload into one capped feed
   the broadcaster and mods can review later.

   Storage is a single capped array under `activity_feed` (newest first, hard
   cap FEED_MAX), written through the DAL's atomic `mutate` so a gift bomb's
   many near-simultaneous events can't clobber each other. recordActivity is
   best-effort and never throws — an EventSub webhook must never fail because a
   log write did.
   ══════════════════════════════════════════════ */

const FEED_KEY = 'activity_feed';
const FEED_MAX = 200;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function getSession(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/pham_session=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match[1])); } catch { return null; }
}

/**
 * Append an event to the feed. Best-effort and swallowing: callers are webhook
 * handlers that must return 200 to Twitch regardless of whether this succeeds.
 *
 * @param {object} entry { category, type, summary, payload }
 */
export async function recordActivity(env, entry) {
  try {
    const record = {
      id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
      at: Date.now(),
      category: entry.category || 'event',
      type: entry.type || 'unknown',
      summary: entry.summary || '',
      payload: entry.payload == null ? null : entry.payload,
    };
    await env.MARKETPLACE.mutate(FEED_KEY, (current) => {
      const list = Array.isArray(current) ? current : [];
      list.unshift(record);
      if (list.length > FEED_MAX) list.length = FEED_MAX;
      return list;
    });
  } catch (err) {
    console.error('[activity] record failed:', err && err.message);
  }
}

export async function getActivityFeed(env) {
  return (await env.MARKETPLACE.get(FEED_KEY, 'json')) || [];
}

/* ── GET — the feed, broadcaster/mods only ─────── */

export async function onRequestGet(context) {
  const { env, request } = context;
  const session = getSession(request);

  const { isModerator } = await import('./admin/moderators.js');
  if (!(await isModerator(env, session))) {
    return json({ error: 'You need broadcaster or moderator access for this.' }, 403);
  }

  const url = new URL(request.url);
  const category = url.searchParams.get('category');
  const limit = Math.min(FEED_MAX, Math.max(1, parseInt(url.searchParams.get('limit'), 10) || 100));

  let feed = await getActivityFeed(env);
  if (category && category !== 'all') feed = feed.filter((e) => e.category === category);

  return json({ events: feed.slice(0, limit) });
}
