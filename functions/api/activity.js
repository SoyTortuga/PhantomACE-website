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
  const match = cookie.match(/(?:^|;\s*)pham_session=([^;]+)/);
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

/**
 * Rebuild the overlay ALERT event a stored activity row represents, so a
 * moderator can re-fire it on stream from the feed. Reads only the row's
 * category and raw payload — the same fields the live webhooks build their
 * alerts from — so a replay is byte-for-byte the alert that first fired.
 *
 * Returns null for rows that are not a replayable on-screen alert (a bot action,
 * a prediction state change, a redemption with no celebratory alert). Pure —
 * exported for tests.
 */
export function overlayEventFromActivity(row) {
  if (!row) return null;
  const p = (row.payload && typeof row.payload === 'object') ? row.payload : {};
  switch (row.category) {
    case 'sub': {
      const who = p.user_name || p.user_login || 'someone';
      return { type: 'sub', who, tier: p.tier || null };
    }
    case 'resub': {
      const who = p.user_name || p.user_login || 'someone';
      return {
        type: 'resub', who,
        months: Number(p.cumulative_months) || Number(p.duration_months) || 1,
        streak: Number(p.streak_months) || 0,
        message: (p.message && p.message.text) ? String(p.message.text) : '',
        tier: p.tier || null,
      };
    }
    case 'giftsub': {
      const who = p.is_anonymous ? 'An anonymous gifter' : (p.user_name || p.user_login || 'Someone');
      return { type: 'giftsub', who, count: Number(p.total) || 1 };
    }
    case 'raid': {
      const who = p.from_broadcaster_user_name || 'A raider';
      return { type: 'raid', who, viewers: Number(p.viewers) || 0 };
    }
    case 'follow': {
      const who = p.user_name || p.user_login || 'someone';
      return { type: 'follow', user: who };
    }
    case 'cheer': {
      const who = p.is_anonymous ? 'An anonymous cheerer' : (p.user_name || p.user_login || 'Someone');
      return { type: 'cheer', user: who, bits: Number(p.bits) || 0, message: p.message ? String(p.message) : '' };
    }
    case 'hype': {
      if (row.type !== 'hype-level') return null;
      return { type: 'hype-level', level: Number(p.level) || 1, total: Number(p.total) || 0, goal: Number(p.goal) || 0 };
    }
    default:
      return null;
  }
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

/* ── POST — replay an alert, broadcaster/mods only ───
   Re-fires a stored feed row's alert on the overlay by re-pushing the event it
   represents. Moderator-gated like the GET. */
export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);

  const { isModerator } = await import('./admin/moderators.js');
  if (!(await isModerator(env, session))) {
    return json({ error: 'You need broadcaster or moderator access for this.' }, 403);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  if (!body || body.action !== 'replay') return json({ error: 'Invalid action' }, 400);

  const id = String(body.id || '');
  if (!id) return json({ error: 'Which event?' }, 400);

  const feed = await getActivityFeed(env);
  const row = feed.find((e) => e.id === id);
  if (!row) return json({ error: 'No such event in the feed.' }, 404);

  const ev = overlayEventFromActivity(row);
  if (!ev) return json({ error: 'This event cannot be replayed on the overlay.' }, 400);

  const { pushOverlayEvent } = await import('./overlay/events.js');
  await pushOverlayEvent(env, ev);

  return json({ success: true, type: ev.type });
}
