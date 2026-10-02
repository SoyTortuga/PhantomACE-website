/* ══════════════════════════════════════════════
   BOT DASHBOARD — everything the control panel needs, in one call.

   Exists because the panel previously showed no state at all: you pressed
   Drop and found out afterwards whether it had worked. Most importantly it
   showed nothing about the code pools, so "no codes left in the common pool"
   was discovered mid-stream rather than before one.

   One endpoint rather than four, because the panel polls and four round
   trips per poll from a machine that is also running a stream is wasteful
   for no benefit.
   ══════════════════════════════════════════════ */

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

/* ── REVOKED SUBSCRIPTIONS ───────────────────────────────────────────────
   Twitch revokes a subscription when the authorising token loses a scope,
   the user is gone, or the callback failed too often — and then simply
   stops sending. The panel's "registered" list is a snapshot bot-setup wrote
   when the subscriptions were created, so a revoked one stayed green there
   forever. Every webhook route now records a revocation here, one row for
   the whole channel keyed by subscription type, and the panel shows each as
   a red banner until it is fixed.

   An entry clears two ways: that type delivers a notification again (the
   routes call clearEventSubRevocation), or Create Subscriptions re-registers
   the type after the revocation (judged here, from the createdAt bot-setup
   stamps — which also covers routes that cannot clear on notification).

   Exported from this route rather than a new library file: a handler-less
   module under functions/ has to be declared in server/router.js. */
export const REVOKED_KEY = 'eventsub_revoked';

let revokedTypesCache = { types: null, at: 0 };
const REVOKED_CACHE_MS = 60000;

export async function recordEventSubRevocation(env, body, route) {
  const sub = (body && body.subscription) || {};
  const type = String(sub.type || 'unknown');
  const entry = {
    type,
    reason: String(sub.status || 'unknown'),
    at: Date.now(),
    route: route || null,
  };
  console.warn(`[eventsub] ${type} subscription revoked: ${entry.reason}`);
  try {
    await env.MARKETPLACE.mutate(REVOKED_KEY, (current) => {
      const rec = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
      rec[type] = entry;
      return rec;
    });
    revokedTypesCache = { types: null, at: 0 };
  } catch (err) {
    console.error('[eventsub] could not record revocation:', err.message);
  }
}

/* Called on every notification, chat messages included, so the common case
   — nothing revoked — costs one read a minute, not one per message. */
export async function clearEventSubRevocation(env, type) {
  if (!type) return;
  try {
    const now = Date.now();
    if (!revokedTypesCache.types || now - revokedTypesCache.at > REVOKED_CACHE_MS) {
      const current = await env.MARKETPLACE.get(REVOKED_KEY, 'json');
      revokedTypesCache = {
        types: new Set(current && typeof current === 'object' ? Object.keys(current) : []),
        at: now,
      };
    }
    if (!revokedTypesCache.types.has(type)) return;
    await env.MARKETPLACE.mutate(REVOKED_KEY, (current) => {
      if (!current || !current[type]) return undefined;
      delete current[type];
      return current;
    });
    revokedTypesCache.types.delete(type);
  } catch (err) {
    console.error('[eventsub] could not clear revocation:', err.message);
  }
}

export function _resetRevokedCache() { revokedTypesCache = { types: null, at: 0 }; }

/** Revocations still standing: not since re-created by Create Subscriptions. */
export function activeRevocations(revoked, subs) {
  const rec = revoked && typeof revoked === 'object' && !Array.isArray(revoked) ? revoked : {};
  const created = new Map();
  for (const s of Array.isArray(subs) ? subs : []) {
    const t = String(s && s.type || '');
    const at = Number(s && s.createdAt) || 0;
    if (!created.has(t) || created.get(t) < at) created.set(t, at);
  }
  return Object.values(rec)
    .filter(r => r && r.type && !(created.get(r.type) > (Number(r.at) || 0)))
    .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0))
    .map(r => ({ type: r.type, reason: r.reason || 'unknown', at: r.at || null }));
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const session = getSession(request);

  const { isModerator, isBroadcaster } = await import('../admin/moderators.js');
  if (!(await isModerator(env, session))) {
    return json({ error: 'You need broadcaster or moderator access for this.' }, 403);
  }

  /* ── Code pools ──────────────────────────────────────────────────────
     The number that matters. An empty pool does not produce a failed drop,
     it produces NO drop: hype-train.js returns before posting to chat, with
     no error and no log line. The panel should never be the last to know. */
  let pools = null;
  try {
    pools = await env.MARKETPLACE.giveawayPoolLevels();
  } catch (err) {
    pools = { error: err.message };
  }

  /* ── Live drops, with how many people actually claimed each code ──────
     Answers the question a broadcaster genuinely has mid-stream — "did
     anyone get that?" — which nothing previously reported.

     Reads the unified live feed, so a code dropped from THIS panel shows up
     here too. It used to read hype_train_drops, written only by the hype
     train handler — so pressing a tier button on this very page produced no
     row, and the card silently reported on one drop path out of four. */
  const { getLiveDrops } = await import('../giveaway-entries.js');
  const live = await getLiveDrops(env);
  const activeDrops = [];
  for (const d of live) {
    let claims = 0;
    let registered = true;
    if (d.kind === 'entries') {
      const rec = await env.MARKETPLACE.get(`gwc_${String(d.code).toUpperCase()}`, 'json');
      /* A live code with no record expired from the drop-code table while
         the feed entry is still inside its window. Worth surfacing rather
         than showing a silent zero, which reads as "nobody claimed it". */
      registered = !!rec;
      claims = rec ? (rec.redeemedBy || []).length : 0;
    } else {
      const rec = await env.MARKETPLACE.get(`item_code_${String(d.code).toUpperCase()}`, 'json');
      registered = !!rec;
      claims = rec ? (rec.redeemedBy || []).length : 0;
    }
    activeDrops.push({
      kind: d.kind, source: d.source, level: d.level || null,
      rarity: d.rarity, entries: d.entries || null, itemName: d.itemName || null,
      expiresAt: d.expiresAt,
      codes: [{ code: d.code, claims, registered }],
    });
  }

  /* ── This month's giveaway ───────────────────────────────────────── */
  const { getGiveawaySummary } = await import('../giveaway-entries.js');
  const giveaway = await getGiveawaySummary(env, null);

  /* ── Hype train state, and whether the feed is even connected ─────── */
  const hype = await env.MARKETPLACE.get('hype_train_site', 'json');
  const subs = await env.MARKETPLACE.get('eventsub_subscriptions', 'json') || [];
  const subTypes = Array.isArray(subs) ? subs.map(s => String(s.type || '')) : [];
  const hasHypeTrainSub = subTypes.some(t => t.startsWith('channel.hype_train'));

  /* Which EventSub subscriptions are registered. The activity feed and every
     milestone/drop reaction only fire for events whose subscription exists, so
     the panel surfaces this rather than leaving a silent gap to discover live.
     Read from the stored list bot-setup writes; a live Twitch re-check lives on
     the bot-setup page. */
  let revoked = [];
  try {
    revoked = activeRevocations(await env.MARKETPLACE.get(REVOKED_KEY, 'json'), subs);
  } catch (err) {
    console.error('[dashboard] could not read revocations:', err.message);
  }
  const isRevoked = (pred) => revoked.some(r => pred(r.type));

  const subscriptions = {
    subs: subTypes.includes('channel.subscribe'),
    giftSubs: subTypes.includes('channel.subscription.gift'),
    raids: subTypes.includes('channel.raid'),
    redemptions: subTypes.includes('channel.channel_points_custom_reward_redemption.add'),
    hypeTrain: hasHypeTrainSub,
    chat: subTypes.includes('channel.chat.message'),
    total: subTypes.length,
    /* Per-row: a snapshot "registered" can still be dead at Twitch. */
    revokedRows: {
      subs: isRevoked(t => t === 'channel.subscribe'),
      giftSubs: isRevoked(t => t === 'channel.subscription.gift'),
      raids: isRevoked(t => t === 'channel.raid'),
      redemptions: isRevoked(t => t === 'channel.channel_points_custom_reward_redemption.add'),
      hypeTrain: isRevoked(t => t.startsWith('channel.hype_train')),
      chat: isRevoked(t => t === 'channel.chat.message'),
    },
    revoked,
  };

  /* ── Pham Check-ins for the broadcast on air ──────────────────────────
     Only shown when the stored stream id matches the one currently live —
     the row survives past the end of a stream, and yesterday's attendance
     presented as today's is worse than showing none. */
  const { getStreamInfo } = await import('../stream-info.js');
  const stream = await getStreamInfo(env);
  const stored = await env.MARKETPLACE.get('checkin_current', 'json');
  const current = stored && stream.streamId && stored.streamId === stream.streamId ? stored : null;

  const checkins = {
    live: stream.live,
    streamStartedAt: stream.startedAt,
    count: current ? current.checkins.length : 0,
    /* Most recent first — mid-stream the question is who just arrived. */
    recent: current ? current.checkins.slice(-25).reverse() : [],
    stale: !!(stored && !current),
    /* Check-ins waiting for Twitch to say which broadcast they belong to —
       settled within about a minute (checkin-rewards.js). */
    pending: stored && Array.isArray(stored.pending) ? stored.pending.length : 0,
  };

  /* The OBS browser-source URL, key included, so it can be copied rather
     than assembled by hand. Broadcaster only: the key is what stops anyone
     from loading the alert feed, so it does not belong in a moderator's
     view of the panel. */
  let overlayUrl = null;
  if (isBroadcaster(env, session)) {
    const { getOverlayKey } = await import('../overlay/events.js');
    const origin = env.PUBLIC_ORIGIN || new URL(request.url).origin;
    overlayUrl = `${origin}/overlay?key=${await getOverlayKey(env)}`;
  }

  const log = await env.MARKETPLACE.get('bot_action_log', 'json') || [];

  return json({
    you: { userId: session.user_id, displayName: session.display_name, role: session.role },
    isBroadcaster: isBroadcaster(env, session),
    pools,
    activeDrops,
    giveaway: {
      month: giveaway.month,
      endsAt: giveaway.endsAt,
      totalEntries: giveaway.totalEntries,
      participants: giveaway.participants,
    },
    hypeTrain: {
      active: !!(hype && hype.status === 'active'),
      level: hype ? hype.level : null,
      /* Surfaced on purpose. Hype train drops cannot fire without this
         subscription, and the failure is completely silent — no error, no
         log, nothing in chat. Better to show it as a standing warning in
         the panel than to discover it during a hype train. */
      subscribed: hasHypeTrainSub,
    },
    checkins,
    subscriptions,
    overlayUrl,
    recentActions: log.slice(-15).reverse(),
  });
}
