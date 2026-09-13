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
     anyone get that?" — which nothing previously reported. */
  const drops = await env.MARKETPLACE.get('hype_train_drops', 'json') || [];
  const now = Date.now();
  const activeDrops = [];
  for (const d of drops.filter(x => x.expiresAt > now)) {
    const codes = [];
    for (const code of (d.codes || [])) {
      const rec = await env.MARKETPLACE.get(`gwc_${String(code).toUpperCase()}`, 'json');
      codes.push({
        code,
        claims: rec ? (rec.redeemedBy || []).length : 0,
        /* A live code with no record means it expired from the drop-code
           table while the drop record itself is still within its window.
           Worth surfacing rather than showing a silent zero. */
        registered: !!rec,
      });
    }
    activeDrops.push({
      level: d.level, rarity: d.rarity, entries: d.entries,
      expiresAt: d.expiresAt, codes,
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
    recentActions: log.slice(-15).reverse(),
  });
}
