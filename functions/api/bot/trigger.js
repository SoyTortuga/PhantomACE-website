/* ══════════════════════════════════════════════
   BOT TRIGGER
   Broadcaster-only control panel endpoint.
   Fires the same actions as chat commands
   (see commands.js) without needing to type in chat.
   ══════════════════════════════════════════════ */

import { dropCodeAction, dropItemAction, dropEggAction, announceAction, getBotActionLog } from './send-chat.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function getSession(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/pham_session=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match[1])); } catch { return null; }
}

/* ── GET — recent action log for the control panel ── */

export async function onRequestGet(context) {
  const { env, request } = context;
  const session = getSession(request);
  /* Moderators may drop codes. Checked against the allowlist rather than
     the cookie's role field, so removing someone takes effect immediately
     instead of when their session happens to expire. */
  const { isModerator } = await import('../admin/moderators.js');
  if (!(await isModerator(env, session))) {
    return json({ error: 'You need broadcaster or moderator access for this.' }, 403);
  }

  const log = await getBotActionLog(env);
  const cr = await env.MARKETPLACE.get('checkin_reminder', 'json');
  /* Default off at 15 minutes until the broadcaster sets it, so the panel
     shows a sane state on first load. */
  const checkinReminder = {
    enabled: !!(cr && cr.enabled),
    intervalMin: (cr && cr.intervalMin) || 15,
  };
  const vol = await env.MARKETPLACE.get('overlay_alert_volume');
  const alertVolume = vol == null ? 35 : Math.max(0, Math.min(100, parseInt(vol, 10) || 0));
  /* The overlay dino-hatch minigame's on/off, so the panel can show and toggle
     it. On by default (dino-hatch.js). */
  const { getHatchConfig } = await import('../dino-hatch.js');
  const hatchConfig = await getHatchConfig(env);
  return json({ log, checkinReminder, alertVolume, hatchConfig });
}

/* ── POST — fire a drop or announcement ────────── */

export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);
  /* Moderators may drop codes. Checked against the allowlist rather than
     the cookie's role field, so removing someone takes effect immediately
     instead of when their session happens to expire. */
  const { isModerator } = await import('../admin/moderators.js');
  if (!(await isModerator(env, session))) {
    return json({ error: 'You need broadcaster or moderator access for this.' }, 403);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  const actor = session.display_name || 'broadcaster';

  if (body.action === 'drop') {
    const result = await dropCodeAction(env, body.rarity, actor, { count: body.count });
    return json(result, result.success ? 200 : 400);
  }

  if (body.action === 'dropitem') {
    const result = await dropItemAction(env, body.code || null, actor);
    return json(result, result.success ? 200 : 400);
  }

  if (body.action === 'dropegg') {
    const result = await dropEggAction(env, body.rarity, actor, { mutation: !!body.mutation });
    return json(result, result.success ? 200 : 400);
  }

  if (body.action === 'milestone-config') {
    const { setMilestoneConfig } = await import('../milestones.js');
    const result = await setMilestoneConfig(env, body);
    return json(result, result.error ? 400 : 200);
  }

  /* Turn the overlay dino-hatch minigame on or off. The three triggers (gift
     sub, 300-bit Power-up, 30,000 channel points) all check this flag. */
  if (body.action === 'hatch-config') {
    const { setHatchConfig } = await import('../dino-hatch.js');
    const result = await setHatchConfig(env, body);
    return json(result, result.error ? 400 : 200);
  }

  if (body.action === 'announce') {
    const result = await announceAction(env, body.message, actor);
    return json(result, result.success ? 200 : 400);
  }

  /* ── Pham Check-In reminder ───────────────────────────────────────────
     A small corner nudge on the overlay telling viewers to redeem their
     check-in — not a chat post, not a stage alert. `sound: true` because a
     moderator pressed it by hand; the timer version (server/index.js) fires
     the same event silently so a periodic nudge never loops audio. */
  if (body.action === 'checkin-alert') {
    const { pushOverlayEvent } = await import('../overlay/events.js');
    await pushOverlayEvent(env, { type: 'pham-checkin', sound: true });
    return json({ success: true });
  }

  /* Turn the automatic timer on/off and set its interval. The rig's minute
     tick reads this and fires the (silent) nudge on schedule while live —
     see the checkin-reminder block in server/index.js. */
  if (body.action === 'checkin-reminder-config') {
    const enabled = !!body.enabled;
    const intervalMin = Math.min(120, Math.max(1, Math.floor(Number(body.intervalMin) || 15)));
    await env.MARKETPLACE.mutate('checkin_reminder', (c) => ({
      ...(c || {}), enabled, intervalMin,
    }), { expirationTtl: 86400 });
    return json({ success: true, enabled, intervalMin });
  }

  /* Overlay audio-alert volume (0-100). The overlay reads it off its event
     poll, so a change lands within a second — no reload. */
  if (body.action === 'alert-volume') {
    const volume = Math.max(0, Math.min(100, Math.round(Number(body.volume))));
    if (!Number.isFinite(volume)) return json({ error: 'Volume must be 0-100.' }, 400);
    await env.MARKETPLACE.put('overlay_alert_volume', String(volume));
    return json({ success: true, volume });
  }

  return json({ error: 'Invalid action' }, 400);
}
