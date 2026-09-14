/* ══════════════════════════════════════════════
   ROTATING CHAT ANNOUNCEMENTS

   A list of messages the bot posts to chat on a timer, one at a time, in
   order. The kind of thing every stream ends up wanting: "follow for...",
   "the giveaway ends...", "redeem codes at...".

   TWO RULES THAT MATTER MORE THAN THE FEATURE

   1. It only posts WHILE THE CHANNEL IS LIVE. A bot talking to an empty
      offline chat every fifteen minutes, forever, is how a channel ends up
      muting its own bot. Being offline is not a pause anyone has to
      remember to press.

   2. The timer lives in the server process, not in a browser. Driving it
      from the open control panel would mean announcements stop the moment
      the broadcaster closes the tab — and appear twice if they open two.
      The site already requires a single server instance (Mana Clash and
      PhamShock advance round timers in-process), so one interval there is
      safe by the same argument.

   The rotation cursor is stored, not derived from the clock, so the order
   survives restarts and does not jump when an entry is added or removed.
   ══════════════════════════════════════════════ */

const KEY = 'announcements';
const MIN_INTERVAL_MINUTES = 5;
const MAX_ITEMS = 20;
const MAX_LENGTH = 450;

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

const empty = () => ({ items: [], intervalMinutes: 15, enabled: false, cursor: 0, lastPostedAt: 0 });

export async function getAnnouncements(env) {
  const rec = await env.MARKETPLACE.get(KEY, 'json');
  if (!rec) return empty();
  return {
    items: Array.isArray(rec.items) ? rec.items : [],
    intervalMinutes: Math.max(MIN_INTERVAL_MINUTES, Number(rec.intervalMinutes) || 15),
    enabled: !!rec.enabled,
    cursor: Number(rec.cursor) || 0,
    lastPostedAt: Number(rec.lastPostedAt) || 0,
  };
}

/**
 * Post the next announcement if it is time. Called by the server's interval.
 *
 * @returns {Promise<{posted:boolean, reason?:string, text?:string}>}
 *   Always reports WHY it did nothing. A rotation that silently does not run
 *   is indistinguishable from one that is working but has nothing to say,
 *   and that is the state you end up staring at when it breaks.
 */
export async function tickAnnouncements(env) {
  const rec = await getAnnouncements(env);
  if (!rec.enabled) return { posted: false, reason: 'disabled' };

  const active = rec.items.filter(i => i && i.enabled !== false && i.text);
  if (!active.length) return { posted: false, reason: 'no active announcements' };

  const dueAt = rec.lastPostedAt + rec.intervalMinutes * 60000;
  if (Date.now() < dueAt) return { posted: false, reason: 'not due yet' };

  const { getStreamInfo } = await import('../stream-info.js');
  if (!(await getStreamInfo(env)).live) {
    /* Deliberately does NOT advance lastPostedAt. Going live should produce
       an announcement promptly rather than after a full interval of dead
       air, and offline time should not consume the rotation. */
    return { posted: false, reason: 'channel is offline' };
  }

  const idx = rec.cursor % active.length;
  const item = active[idx];

  const { sendChatMessage } = await import('./send-chat.js');
  const sent = await sendChatMessage(env, item.text);

  /* The cursor and the clock advance even when Twitch refused to post.
     Otherwise a message the link filter blocks is retried every minute
     forever, and the rotation never reaches the messages that would work. */
  await env.MARKETPLACE.mutate(KEY, (current) => ({
    ...(current || empty()),
    cursor: (Number((current || {}).cursor) || 0) + 1,
    lastPostedAt: Date.now(),
  }));

  const { logBotAction } = await import('./send-chat.js');
  await logBotAction(env, { type: 'announce', message: item.text, actor: 'auto-rotation', sent });

  return { posted: true, text: item.text, sent };
}

/* ── GET ─────────────────────────────────────── */

export async function onRequestGet(context) {
  const { env, request } = context;
  const session = getSession(request);

  const { isModerator } = await import('../admin/moderators.js');
  if (!(await isModerator(env, session))) {
    return json({ error: 'You need broadcaster or moderator access for this.' }, 403);
  }

  const rec = await getAnnouncements(env);
  const active = rec.items.filter(i => i && i.enabled !== false && i.text).length;
  return json({
    ...rec,
    activeCount: active,
    nextDueAt: rec.enabled && active ? rec.lastPostedAt + rec.intervalMinutes * 60000 : null,
    minIntervalMinutes: MIN_INTERVAL_MINUTES,
    maxItems: MAX_ITEMS,
    maxLength: MAX_LENGTH,
  });
}

/* ── POST ────────────────────────────────────── */

export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);

  const { isModerator } = await import('../admin/moderators.js');
  if (!(await isModerator(env, session))) {
    return json({ error: 'You need broadcaster or moderator access for this.' }, 403);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  const action = body.action;

  if (action === 'post-now') {
    const rec = await getAnnouncements(env);
    const item = rec.items.find(i => i.id === body.id);
    if (!item) return json({ error: 'No such announcement.' }, 404);
    const { announceAction } = await import('./send-chat.js');
    const result = await announceAction(env, item.text, session.display_name || 'moderator');
    return json(result, result.success ? 200 : 400);
  }

  let error = null;
  await env.MARKETPLACE.mutate(KEY, (current) => {
    const rec = {
      ...empty(),
      ...(current || {}),
      items: Array.isArray((current || {}).items) ? [...current.items] : [],
    };

    if (action === 'add') {
      const text = String(body.text || '').trim();
      if (!text) { error = 'Message is empty.'; return undefined; }
      if (text.length > MAX_LENGTH) { error = `Message too long (max ${MAX_LENGTH}).`; return undefined; }
      if (rec.items.length >= MAX_ITEMS) { error = `That is the limit (${MAX_ITEMS}).`; return undefined; }
      rec.items.push({
        id: 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        text, enabled: true,
        addedBy: session.display_name || 'moderator',
        addedAt: Date.now(),
      });
    } else if (action === 'remove') {
      const i = rec.items.findIndex(x => x.id === body.id);
      if (i === -1) { error = 'No such announcement.'; return undefined; }
      rec.items.splice(i, 1);
    } else if (action === 'toggle-item') {
      const it = rec.items.find(x => x.id === body.id);
      if (!it) { error = 'No such announcement.'; return undefined; }
      it.enabled = !it.enabled;
    } else if (action === 'set-interval') {
      const n = Math.floor(Number(body.intervalMinutes));
      if (!Number.isFinite(n) || n < MIN_INTERVAL_MINUTES) {
        /* A floor, not a suggestion. Twitch rate-limits the bot, and a
           two-minute rotation in a quiet chat reads as spam to viewers long
           before it does to Twitch. */
        error = `Interval must be at least ${MIN_INTERVAL_MINUTES} minutes.`;
        return undefined;
      }
      rec.intervalMinutes = n;
    } else if (action === 'toggle') {
      rec.enabled = !rec.enabled;
      /* Turning it on should not fire immediately if one just went out, but
         should not wait a full interval after a long pause either. */
      if (rec.enabled) rec.lastPostedAt = Math.max(rec.lastPostedAt, Date.now() - rec.intervalMinutes * 60000);
    } else {
      error = 'Invalid action';
      return undefined;
    }

    return rec;
  });

  if (error) return json({ error }, 400);

  const rec = await getAnnouncements(env);
  return json({ success: true, ...rec });
}
