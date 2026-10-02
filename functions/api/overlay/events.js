/* ══════════════════════════════════════════════
   OVERLAY EVENT FEED

   Drives the on-stream alert window (an OBS browser source). Everything that
   happens — a code drop, a sub, a raid, a hype train level — gets pushed
   here, and the overlay polls for anything it has not seen.

   WHY POLLING AND NOT WEBSOCKETS/SSE

   One client. OBS opens this page once and holds it. A 1-second poll from a
   single browser is nothing, and it keeps the whole thing inside the
   architecture that already exists — no new transport, no connection state
   to lose, no reconnect logic to get wrong while a stream is live. The
   adapter that turns handler Responses into Node responses has never had to
   stream, and making it do so for one consumer is the wrong trade.

   SEQUENCE NUMBERS, NOT TIMESTAMPS

   The overlay asks for "everything after N". A clock-based cursor would
   replay or skip alerts whenever the two machines disagreed, and OBS runs on
   the streaming PC rather than the server.

   RELOADING FROM HERE. An OBS browser source holds a page open for days,
   so a change to overlay.html or its scripts does not reach the stream
   until somebody walks to the streaming PC and refreshes the source. This
   feed is already polled every second, so it carries a reload token: the
   page remembers the token it started with, and reloads when it changes.
   One button in the control panel, and nobody touches OBS.

   A FIRST LOAD REPLAYS NOTHING. Opening the overlay — or OBS reloading the
   source mid-stream, which it does — returns the current position and no
   backlog. Without that, restarting a source would dump every alert of the
   last hour onto the stream at once.
   ══════════════════════════════════════════════ */

const KEY = 'overlay_events';
const KEYFILE = 'overlay_key';
const MAX_EVENTS = 60;

/* ── Per-alert enable/disable ──────────────────────────────────────────────
   The broadcaster can switch any one-shot ALERT type on or off from the Overlay
   Dashboard. Enforcement is CENTRAL, here: a disabled alert type is never even
   enqueued, so it can never reach the overlay however it was triggered
   (webhook, milestone, test-fire). Default is ALL ENABLED — a missing key means
   on. Control/panel events (reload, mana-clash, checkin nudge, layout, …) are
   NOT in this set and always pass; only the celebratory one-shot alerts are
   toggleable. */
const ALERT_TOGGLES_KEY = 'alert_toggles';
export const TOGGLEABLE_ALERT_TYPES = [
  'sub', 'giftsub', 'raid', 'hype-level', 'follow', 'cheer', 'drop',
  'dino-hatch', 'giveaway-spin', 'prediction', 'bingo-call', 'bingo-win',
  'mtgbbb-pull', 'mtgbbb-bingo',
];

/* A short per-env cache so a gift-sub bomb (twenty pushes in a second) does not
   read the config twenty times. Keyed by env (WeakMap) so tests with separate
   fake envs never see each other's config, and single-instance prod shares one
   entry. The dashboard's setter calls invalidateAlertTogglesCache(env) so a
   change applies immediately rather than after the TTL. */
const TOGGLES_TTL_MS = 3000;
const _togglesCache = new WeakMap();

async function alertTogglesConfig(env) {
  const cached = _togglesCache.get(env);
  const now = Date.now();
  if (cached && now - cached.at < TOGGLES_TTL_MS) return cached.cfg;
  let rec = null;
  try { rec = await env.MARKETPLACE.get(ALERT_TOGGLES_KEY, 'json'); } catch (e) { /* default on */ }
  const cfg = (rec && typeof rec === 'object') ? rec : {};
  _togglesCache.set(env, { cfg, at: now });
  return cfg;
}

export function invalidateAlertTogglesCache(env) {
  if (env) _togglesCache.delete(env);
}

/** True only for a toggleable alert type the broadcaster has switched OFF. */
async function isAlertDisabled(env, type) {
  if (TOGGLEABLE_ALERT_TYPES.indexOf(type) === -1) return false;   // control events always pass
  const cfg = await alertTogglesConfig(env);
  return cfg[type] === false;                                       // missing/true = enabled
}

/**
 * Whether an alert type may fire — the same check pushOverlayEvent gates on,
 * exported so webhook handlers can ALSO skip the activity-feed entry for a
 * disabled type (disabled = no overlay alert AND no feed row). A non-toggleable
 * type (a control event, or a feed category that is not an alert) is always
 * "enabled", so unrelated activity is never suppressed.
 */
export async function isAlertEnabled(env, type) {
  return !(await isAlertDisabled(env, type));
}

/** The shared secret in the OBS URL. Generated once, then stable. */
export async function getOverlayKey(env) {
  const existing = await env.MARKETPLACE.get(KEYFILE);
  if (existing) return existing;
  const key = crypto.randomUUID().replace(/-/g, '');
  await env.MARKETPLACE.put(KEYFILE, key);
  return key;
}

/* TEARDOWN EVENTS BYPASS THE TOGGLE. A standing panel that a toggleable event
   opened must still be told to close: switching predictions off mid-prediction
   used to swallow the 'end', leaving the panel up for good and blocking the
   overlay's idle self-reload. A teardown for a disabled type is still sent,
   but marked `quiet` — the overlay closes the panel without the reveal. */
function isTeardownEvent(event) {
  return event.type === 'prediction' && event.state === 'end';
}

/* LOW-VALUE EVENTS ARE EVICTED FIRST. The buffer is shared, so a follow-bot
   wave (or anything spammy) arriving while the overlay is behind would push
   the sub that landed just before it out of the window. When over the cap,
   the oldest of these goes first; only when none is left does the oldest
   event overall. */
function isEvictFirst(e) {
  return e && (e.type === 'follow' || (e.type === 'prediction' && e.state === 'progress'));
}

/**
 * Append an event. Never throws — an overlay problem must not take down the
 * webhook or the drop that triggered it. A missed alert is a cosmetic loss;
 * a 500 back to Twitch risks the subscription itself.
 *
 * opts.replace(e) — optional predicate: buffered events it matches are removed
 * before this one is appended, so a high-frequency state snapshot (prediction
 * progress) occupies ONE slot instead of flooding the shared buffer. The new
 * event still takes a fresh seq, so a client that already saw the old one
 * still receives the update.
 */
export async function pushOverlayEvent(env, event, opts) {
  if (!event || !event.type) return;
  const replace = opts && typeof opts.replace === 'function' ? opts.replace : null;
  try {
    /* Central enable/disable gate: a toggled-off alert type is dropped before
       it is ever enqueued, so it cannot reach the overlay by any path — except
       a teardown, which goes through quietly (see isTeardownEvent). */
    if (await isAlertDisabled(env, event.type)) {
      if (!isTeardownEvent(event)) return;
      event = { ...event, quiet: true };
    }
    await env.MARKETPLACE.mutate(KEY, (current) => {
      const rec = current && Array.isArray(current.events)
        ? current
        : { events: [], seq: 0 };
      if (replace) rec.events = rec.events.filter(e => !replace(e));
      rec.seq = (Number(rec.seq) || 0) + 1;
      rec.events.push({ ...event, seq: rec.seq, at: Date.now() });
      while (rec.events.length > MAX_EVENTS) {
        const i = rec.events.findIndex(isEvictFirst);
        rec.events.splice(i === -1 ? 0 : i, 1);
      }
      return rec;
    });
  } catch (err) {
    console.error('[overlay] could not record event:', err.message);
  }
}

const RELOAD_KEY = 'overlay_reload';

/** The current reload token. Absent until somebody has asked for one. */
async function reloadToken(env) {
  const rec = await env.MARKETPLACE.get(RELOAD_KEY, 'json');
  return (rec && rec.token) ? String(rec.token) : '';
}

/* ── PANIC CONTROLS — Clear / Skip ──────────────────────────────────────────
   The dashboard's panic buttons ride this same feed. Clear wipes every alert
   and the off-queue panels (check-in, hatch, prediction) off the overlay NOW;
   Skip dismisses the alert currently on screen. Carried like the reload token:
   the overlay records its FIRST sighting without acting (so a command issued
   before a source opened is never replayed onto it) and applies each later
   change exactly once. Only the latest command is held — panic semantics, where
   the most recent press is the one that matters. */
const CONTROL_KEY = 'overlay_control';
const CONTROL_ACTIONS = ['clear', 'skip'];

async function overlayControl(env) {
  const rec = await env.MARKETPLACE.get(CONTROL_KEY, 'json');
  return (rec && rec.token) ? { cmd: String(rec.cmd || ''), token: String(rec.token) } : null;
}

/* AUDIO LEADER — one overlay plays sound, however many are open.
   Each overlay source is its own page with its own audio element, so a
   check-in chime plays once PER open source and OBS mixes them all onto the
   stream (three sources = three chimes, at slightly different poll timings).
   Every source sends a random instance id on each poll; this keeps a short-
   lived heartbeat registry and names the lowest live id the audio leader.
   Only that source plays the chime; the rest stay silent. A muted source
   (?muted=1) sends no id, so it never competes and never plays. */
const INSTANCE_STALE_MS = 6000;
async function electAudioLeader(env, iid) {
  if (!iid) return null;
  const now = Date.now();
  let reg = {};
  await env.MARKETPLACE.mutate('overlay_instances', (cur) => {
    reg = (cur && typeof cur === 'object') ? { ...cur } : {};
    for (const k of Object.keys(reg)) {
      if (now - (Number(reg[k]) || 0) > INSTANCE_STALE_MS) delete reg[k];
    }
    reg[iid] = now;
    return reg;
  }, { expirationTtl: 30 });
  const live = Object.keys(reg).filter(k => now - (Number(reg[k]) || 0) <= INSTANCE_STALE_MS).sort();
  return live.length ? live[0] : iid;
}

function getSession(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)pham_session=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match[1])); } catch { return null; }
}

/**
 * Ask every open overlay to reload.
 *
 * Moderator only, and deliberately not reachable with the overlay key: the
 * key is in an OBS URL and travels wherever that URL does, so it proves
 * "this is the overlay", not "this person may act".
 */
export async function onRequestPost(context) {
  const { env, request } = context;

  const { isModerator } = await import('../admin/moderators.js');
  const session = getSession(request);
  if (!(await isModerator(env, session))) {
    return new Response(JSON.stringify({ error: 'You need broadcaster or moderator access for this.' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  let body;
  try { body = await request.json(); } catch { body = {}; }
  const action = body && body.action;
  if (action !== 'reload' && CONTROL_ACTIONS.indexOf(action) === -1) {
    return new Response(JSON.stringify({ error: 'Invalid action' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  /* The clock, not a counter. Two moderators pressing a button a second apart
     should produce two different tokens without either having read the other's.
     A random suffix keeps two presses inside the same millisecond distinct. */
  const token = String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8);

  if (action === 'reload') {
    await env.MARKETPLACE.put(RELOAD_KEY, JSON.stringify({
      token, at: Date.now(), by: (session && session.display_name) || '',
    }));
  } else {
    /* Clear / Skip — the latest command, applied once by every open overlay. */
    await env.MARKETPLACE.put(CONTROL_KEY, JSON.stringify({
      cmd: action, token, at: Date.now(), by: (session && session.display_name) || '',
    }));
  }

  return new Response(JSON.stringify({ success: true, token }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);

  /* Key in the query string because an OBS browser source is a URL and
     nothing else — it cannot send a header or hold a cookie. */
  const key = await getOverlayKey(env);
  if (url.searchParams.get('key') !== key) {
    return new Response(JSON.stringify({ error: 'Bad or missing key' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  const rec = await env.MARKETPLACE.get(KEY, 'json');
  const events = rec && Array.isArray(rec.events) ? rec.events : [];
  const latestSeq = Number(rec && rec.seq) || 0;

  /* Alert volume (0-100), set from the control panel and applied by the
     overlay to its audio. Defaults to 100 until the broadcaster sets it. */
  const volRec = await env.MARKETPLACE.get('overlay_alert_volume');
  const alertVolume = volRec == null ? 35 : Math.max(0, Math.min(100, parseInt(volRec, 10) || 0));

  /* Which single open overlay may play the check-in chime — see electAudioLeader. */
  const audioLeader = await electAudioLeader(env, url.searchParams.get('iid'));

  /* Whether the dino-hatch stings are on. Muted by default (dino-hatch.js), so
     the overlay stays silent for hatches until the broadcaster flips it — read
     each poll, so it changes live with no reload. */
  const hcfg = await env.MARKETPLACE.get('dino_hatch_config', 'json');
  const hatchSound = !!(hcfg && hcfg.sound === true);

  const sinceRaw = url.searchParams.get('since');
  /* No cursor means "just tell me where we are". See the header: a reloaded
     source must not replay an hour of alerts onto the stream. */
  const since = sinceRaw === null || sinceRaw === '' ? null : parseInt(sinceRaw, 10);

  const fresh = since === null || Number.isNaN(since)
    ? []
    : events.filter(e => e.seq > since);

  return new Response(JSON.stringify({
    events: fresh,
    latestSeq,
    /* Sent on every poll, including the first. The page stores what it saw
       on load and reloads only when this differs — so pressing the button
       once reloads every open overlay exactly once, and a page opened
       afterwards does not reload on its first poll. */
    reloadToken: await reloadToken(env),
    /* The latest panic command (Clear/Skip), or null. The overlay records its
       first sighting and applies each later change once — see overlay.js. */
    control: await overlayControl(env),
    alertVolume: alertVolume,
    audioLeader: audioLeader,
    hatchSound: hatchSound,
    serverNow: Date.now(),
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
