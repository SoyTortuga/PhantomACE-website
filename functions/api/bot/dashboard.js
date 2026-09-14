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
  const match = cookie.match(/pham_session=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match[1])); } catch { return null; }
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
  const hasHypeTrainSub = Array.isArray(subs) &&
    subs.some(s => String(s.type || '').startsWith('channel.hype_train'));

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
    overlayUrl,
    recentActions: log.slice(-15).reverse(),
  });
}
