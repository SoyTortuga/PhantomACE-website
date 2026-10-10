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

/* ── TEST-ALERT SAMPLES ────────────────────────────────────────────────────
   One representative event per ONE-SHOT overlay alert type describe() handles,
   for previewing/positioning on the overlay. Each is a FACTORY returning a
   fresh object, pushed through the SAME pushOverlayEvent path real events use —
   so they render identically and self-clear identically (nothing is left on the
   overlay). Obvious fake data ("TestReaper", round sample counts) makes it
   clear on stream that it is a test.

   The prediction entry fires the RESOLVED end state on purpose: the prediction
   panel is a standing panel that only hides on end, so an end-state sample
   shows the winner reveal and then auto-hides (~8s, PRED_REVEAL_MS in
   overlay.js) rather than leaving a panel stuck. Live show/lock of the
   prediction panel stays EventSub-driven (Bot Control), per the plan. */
const TEST_ALERT_SAMPLES = {
  sub:        () => ({ type: 'sub', who: 'TestReaper' }),
  giftsub:    () => ({ type: 'giftsub', who: 'TestReaper', count: 10 }),
  raid:       () => ({ type: 'raid', who: 'TestRaider', viewers: 42 }),
  follow:     () => ({ type: 'follow', user: 'TestFollower' }),
  cheer:      () => ({ type: 'cheer', user: 'TestCheerer', bits: 500, message: 'Test cheer message!' }),
  'hype-level': () => ({ type: 'hype-level', level: 15 }),
  drop:       () => ({ type: 'drop', code: 'TEST-CODE-1234', rarity: 'rare', entries: 15 }),
  'dino-hatch': () => ({
    type: 'dino-hatch', who: 'TestReaper', count: 1, top: 'legendary', more: 0,
    results: [{ rarity: 'legendary', name: 'Test Rex', speciesId: 'therizo', mutation: null, portrait: '', icon: '' }],
  }),
  'giveaway-spin': () => ({
    type: 'giveaway-spin', rarity: 'mythic', who: 'TestReaper', winnerIndex: 1,
    entrants: [{ username: 'TestOne' }, { username: 'TestReaper' }, { username: 'TestTwo' }, { username: 'TestThree' }],
  }),
  prediction: () => ({
    type: 'prediction', state: 'end', status: 'RESOLVED', title: 'Test: who wins this game?',
    winningOutcomeId: 'o1', locksAt: null,
    outcomes: [
      { id: 'o1', title: 'TestReaper', points: 18400, users: 34, color: 'BLUE' },
      { id: 'o2', title: 'The Other One', points: 7150, users: 12, color: 'PINK' },
    ],
  }),
  'pham-checkin': () => ({ type: 'pham-checkin', sound: true }),
  'bingo-call': () => ({ type: 'bingo-call', label: 'Someone scoops early', called: 12, total: 68 }),
  'bingo-win':  () => ({ type: 'bingo-win', who: 'TestReaper', rarity: 'mythic', entries: 50 }),
  'mtgbbb-pull': () => ({
    type: 'mtgbbb-pull', rarity: 'mythic', card: 'Test Mythic Rare', image: '',
    holders: 3, players: 62, treatments: ['Foil', 'Borderless'],
  }),
  'mtgbbb-bingo': () => ({ type: 'mtgbbb-bingo', who: 'TestReaper', pattern: 'Blackout', points: 25 }),
  'egg-video': () => ({ type: 'egg-video', rarity: 'mythic', mutation: false }),
};

/** The types the test suite can fire, for the dashboard to build its buttons. */
export const TEST_ALERT_TYPES = Object.keys(TEST_ALERT_SAMPLES);

function getSession(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)pham_session=([^;]+)/);
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

  /* Per-alert on/off, resolved to a full map (default ON) for the dashboard's
     "Alerts on/off" card. */
  const { TOGGLEABLE_ALERT_TYPES } = await import('../overlay/events.js');
  const rawToggles = await env.MARKETPLACE.get('alert_toggles', 'json') || {};
  const alertToggles = {};
  TOGGLEABLE_ALERT_TYPES.forEach(function (t) { alertToggles[t] = rawToggles[t] !== false; });

  return json({ log, checkinReminder, alertVolume, hatchConfig, alertToggles });
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

  /* Turn one alert type on or off. Enforced centrally in pushOverlayEvent, so a
     disabled type never reaches the overlay by ANY path (webhook, milestone or
     test-fire). Default is on; this only writes the exceptions. */
  if (body.action === 'alert-toggle') {
    const { TOGGLEABLE_ALERT_TYPES, invalidateAlertTogglesCache } = await import('../overlay/events.js');
    const type = String(body.type || '');
    if (TOGGLEABLE_ALERT_TYPES.indexOf(type) === -1) return json({ error: `Unknown alert type "${type}".` }, 400);
    const enabled = !!body.enabled;
    await env.MARKETPLACE.mutate('alert_toggles', (c) => ({ ...(c || {}), [type]: enabled }));
    invalidateAlertTogglesCache(env);
    return json({ success: true, type, enabled });
  }

  /* Fire a representative sample of one alert type onto the overlay, to preview
     and position it. Goes through the ordinary overlay event path, so it queues,
     shows and self-clears exactly like the real thing — and respects the
     per-alert toggle above, so a disabled type's test does not show either. */
  if (body.action === 'test-alert') {
    const type = String(body.type || '');
    const sample = TEST_ALERT_SAMPLES[type];
    if (!sample) return json({ error: `Unknown test alert type "${type}".` }, 400);
    const { pushOverlayEvent } = await import('../overlay/events.js');
    await pushOverlayEvent(env, sample());
    return json({ success: true, type });
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
    /* No TTL: the key is a singleton in the registry, which pins expiry to
       'none', so a passed TTL was silently ignored. Leaving it there reads as
       if the broadcaster's timer setting lapses after a day. It does not. */
    await env.MARKETPLACE.mutate('checkin_reminder', (c) => ({
      ...(c || {}), enabled, intervalMin,
    }));
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
