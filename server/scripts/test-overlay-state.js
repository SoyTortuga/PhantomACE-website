#!/usr/bin/env node
/* ══════════════════════════════════════════════
   OVERLAY STATE SNAPSHOT + RESUB + REPLAY + WHEEL — test suite

     node server/scripts/test-overlay-state.js

   Covers Overlay epic items #3, #1 and #5:

     #3  ONE STATE SNAPSHOT. prediction-events / hype-train / ad-break each write
         their slice into a single overlay_state record, and the overlay poll
         returns it so overlay.js reads prediction/hype/ad from one place. A
         freshly opened source rehydrates from it WITHOUT replaying — the same
         first-sighting-without-acting rule the reload/control tokens use.

     #1  RESUBS + ALERT SOUNDS. A channel.subscription.message payload produces a
         'resub' overlay alert carrying the month count. The alert box plays a
         sound through ONE reused Audio element, rate-limited and leader-gated.

     #5  REPLAY + WHEEL. A stored activity row re-fires its alert on the overlay,
         and the spin-the-wheel channel-point redemption actually spins the wheel.

   Server behaviour is driven for real (signed webhooks, the fake KV inspected);
   the overlay page's half is read out of source, since no server test can see it.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { signEventSub } from '../lib/eventsub.js';
import * as feed from '../../functions/api/overlay/events.js';
import * as activity from '../../functions/api/activity.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

const SECRET = 'a-test-eventsub-secret';
const BROADCASTER = '900';

function makeEnv(seed = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  const chains = new Map();
  return {
    TWITCH_EVENTSUB_SECRET: SECRET,
    TWITCH_BROADCASTER_ID: BROADCASTER,
    TWITCH_CLIENT_ID: 'client-id',
    MARKETPLACE: {
      async get(k, t) { if (!store.has(k)) return null; const r = store.get(k); return t === 'json' ? JSON.parse(r) : r; },
      async put(k, v) { store.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
      async delete(k) { store.delete(k); },
      async mutate(k, fn) {
        const prev = chains.get(k) || Promise.resolve();
        const run = prev.then(async () => {
          const cur = store.has(k) ? JSON.parse(store.get(k)) : null;
          const next = await fn(cur);
          if (next === undefined) return cur;
          store.set(k, JSON.stringify(next));
          return JSON.parse(store.get(k));
        });
        chains.set(k, run.then(() => {}, () => {}));
        return run;
      },
    },
    _store: store,
  };
}

const cookie = (userId) => `pham_session=${encodeURIComponent(JSON.stringify({ user_id: userId, display_name: 'u' + userId }))}`;

const pollState = async (env, key) => {
  const res = await feed.onRequestGet({ env, request: new Request('https://phantomace.tv/api/overlay/events?key=' + key) });
  return (await res.json()).overlayState;
};

async function signedPost(url, modPath, subType, event) {
  const raw = JSON.stringify({ subscription: { type: subType }, event });
  const messageId = 'mid-' + subType + '-' + Math.random().toString(36).slice(2);
  const ts = new Date().toISOString();
  return new Request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'twitch-eventsub-message-type': 'notification',
      'twitch-eventsub-message-id': messageId,
      'twitch-eventsub-message-timestamp': ts,
      'twitch-eventsub-message-signature': await signEventSub(SECRET, messageId, ts, raw),
    },
    body: raw,
  });
}

const overlayEvents = (env, type) => {
  const rec = env._store.get('overlay_events');
  const events = rec ? JSON.parse(rec).events : [];
  return type ? events.filter(e => e.type === type) : events;
};

/* ══ #3 — the snapshot aggregates prediction/hype/ad, returned on the poll ══ */
{
  const env = makeEnv({ overlay_key: 'K' });

  check('a fresh snapshot is null', await pollState(env, 'K'), null);

  await feed.writeOverlaySlice(env, 'prediction', { type: 'prediction', state: 'begin', title: 'Who?' });
  await feed.writeOverlaySlice(env, 'hype', { active: true, level: 3, total: 1200, goal: 2000 });
  await feed.writeOverlaySlice(env, 'ad', { endsAt: Date.now() + 60000, durationSeconds: 90 });

  const st = await pollState(env, 'K');
  check('the snapshot carries the prediction slice', st.prediction && st.prediction.state, 'begin');
  check('and the hype slice', st.hype && st.hype.level, 3);
  ok('and the ad slice', st.ad && st.ad.endsAt > Date.now());
  ok('each slice is stamped with the ver it was written at',
     st.prediction.ver < st.hype.ver && st.hype.ver < st.ad.ver);

  /* A slice cleared to null is reflected, and the ver still advances so the
     overlay re-applies (hides) it. */
  await feed.writeOverlaySlice(env, 'hype', null);
  const st2 = await pollState(env, 'K');
  check('a cleared slice reads null', st2.hype, null);
  ok('and the overall ver advanced', st2.ver > st.ver);
}

/* ══ #3 — prediction-events writes its slice end-to-end ════════════════════ */
{
  const env = makeEnv({ overlay_key: 'K' });
  const pe = await import('../../functions/api/prediction-events.js');
  const OUT = [{ id: 'o1', title: 'Yes', channel_points: 9000, users: 30 }, { id: 'o2', title: 'No', channel_points: 1000, users: 10 }];

  await pe.onRequestPost({ env, request: await signedPost('https://phantomace.tv/api/prediction-events', pe, 'channel.prediction.begin', { id: 'p1', title: 'Flip?', outcomes: OUT, locks_at: '2030-01-01T00:02:00Z' }) });
  let st = await pollState(env, 'K');
  check('a begun prediction lands in the snapshot', st.prediction && st.prediction.state, 'begin');

  await pe.onRequestPost({ env, request: await signedPost('https://phantomace.tv/api/prediction-events', pe, 'channel.prediction.end', { id: 'p1', title: 'Flip?', status: 'resolved', winning_outcome_id: 'o1', outcomes: OUT }) });
  st = await pollState(env, 'K');
  check('a resolved prediction updates the snapshot to end', st.prediction && st.prediction.state, 'end');
  check('and carries the winner for the reveal', st.prediction.winningOutcomeId, 'o1');
}

/* ══ #3 — the overlay rehydrates WITHOUT replaying (page half) ═════════════ */
{
  const src = read('js/pages/overlay.js');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '');

  ok('the overlay reads the state snapshot', /data\.overlayState/.test(code) && /function applyOverlayState\(/.test(code));
  ok('prediction/hype/ad are read from the one snapshot', /st\.prediction/.test(code) && /st\.hype/.test(code) && /st\.ad/.test(code));
  /* First-sighting-without-acting: a resolved prediction is restored hidden, not
     replayed, on the first snapshot a source sees. */
  ok('the first sighting is tracked', /seenOverlayState/.test(code) && /var first = !seenOverlayState/.test(code));
  ok('a resolved prediction is NOT replayed on first sight',
     /if \(first && p\.state === 'end'\) clearPrediction\(\)/.test(code));
  ok('a slice is re-applied only when its ver changed',
     /pv !== predSliceVer/.test(code) && /hv !== hypeSliceVer/.test(code) && /av !== adSliceVer/.test(code));
  /* The prediction no longer rides the alert queue — it is snapshot-driven. */
  ok('prediction events are no longer enqueued', /if \(ev\.type === 'prediction'\) continue;/.test(code));
  /* The ad countdown ticker is marathon-safe: bails while hidden. */
  ok('the ad ticker bails while hidden', /if \(panel\.hidden\) \{ clearAdTimer\(\); return; \}/.test(code));

  /* The snapshot writers are wired in all three server files. */
  ok('prediction-events writes its slice', /writeOverlaySlice\(env, 'prediction'/.test(read('functions/api/prediction-events.js')));
  const hype = read('functions/api/hype-train.js');
  ok('hype-train writes the hype slice', /writeOverlaySlice\(env, 'hype'/.test(hype));
  ok('and clears it when the train ends', /writeOverlaySlice\(env, 'hype', null\)/.test(hype));
  ok('ad-break writes the ad slice', /writeOverlaySlice\(env, 'ad'/.test(read('functions/api/ad-break.js')));
}

/* ══ #1 — a resub payload produces a 'resub' alert with months ═════════════ */
{
  const env = makeEnv();
  const milestones = await import('../../functions/api/milestones.js');
  await milestones.onRequestPost({ env, request: await signedPost('https://phantomace.tv/api/milestones', milestones, 'channel.subscription.message', {
    user_id: '55', user_name: 'nina', cumulative_months: 14, streak_months: 6, duration_months: 1,
    message: { text: 'love this channel' }, tier: '1000',
  }) });

  const ev = overlayEvents(env, 'resub');
  check('a resub pushes one overlay alert', ev.length, 1);
  check('carrying the subscriber name', ev[0].who, 'nina');
  check('the cumulative month count', ev[0].months, 14);
  check('the streak', ev[0].streak, 6);
  check('and the shared message', ev[0].message, 'love this channel');

  const rows = JSON.parse(env._store.get('activity_feed') || '[]');
  ok('it records an activity row', rows.some(r => r.category === 'resub' && /nina resubscribed/.test(r.summary)));

  /* A disabled resub alert is dropped before it is enqueued. */
  const off = makeEnv({ alert_toggles: JSON.stringify({ resub: false }) });
  await milestones.onRequestPost({ env: off, request: await signedPost('https://phantomace.tv/api/milestones', milestones, 'channel.subscription.message', {
    user_id: '56', user_name: 'omar', cumulative_months: 3, message: { text: 'hi' },
  }) });
  check('a disabled resub never reaches the overlay', overlayEvents(off, 'resub').length, 0);
}

/* ══ #1 — the alert sound is one reused element, gated and rate-limited ═════ */
{
  const src = read('js/pages/overlay.js');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '');

  ok('there is a default alert sound', /function playAlertSound\(/.test(code) && /ALERT_SOUND_SRC/.test(code));
  ok('it fires for the celebratory alert types', /SOUND_ALERT_TYPES = \{ sub: true, resub: true, giftsub: true, raid: true, follow: true, cheer: true \}/.test(code));
  ok('and is played when an alert renders', /playAlertSound\(ev\.type\)/.test(code));
  /* ONE reused element, restarted — never `new Audio()` per fire (the check-in
     duplicate/leak bug). */
  ok('a single reused Audio element, restarted', /if \(!alertSound\) alertSound = new Audio\(/.test(code) && /alertSound\.currentTime = 0/.test(code));
  ok('gated on mute and the audio leader', /if \(audioMuted \|\| !isAudioLeader\) return;/.test(code));
  ok('obeys the shared alert volume', /alertSound\.volume = alertVolume/.test(code));
  ok('and is rate-limited by a cooldown', /ALERT_SOUND_COOLDOWN_MS/.test(code) && /lastAlertSoundAt/.test(code));
  /* A missing file must never throw on air. */
  ok('a missing file fails silently', /alertSound\.play\(\)\.catch\(/.test(code));
}

/* ══ #5 — replay re-fires a stored event ═══════════════════════════════════ */
{
  /* The pure mapper first. */
  check('a sub row maps to a sub alert',
    activity.overlayEventFromActivity({ category: 'sub', payload: { user_name: 'pat' } }), { type: 'sub', who: 'pat', tier: null });
  check('a giftsub row keeps the count',
    activity.overlayEventFromActivity({ category: 'giftsub', payload: { user_name: 'q', total: 5 } }).count, 5);
  check('a hype row maps to hype-level',
    activity.overlayEventFromActivity({ category: 'hype', type: 'hype-level', payload: { level: 7, total: 3, goal: 9 } }).level, 7);
  check('a non-replayable row maps to null',
    activity.overlayEventFromActivity({ category: 'bot', type: 'x', payload: {} }), null);

  const env = makeEnv({
    activity_feed: JSON.stringify([
      { id: 'row-1', at: Date.now(), category: 'raid', type: 'channel.raid', summary: 'x raided', payload: { from_broadcaster_user_name: 'RaidLeader', viewers: 42 } },
    ]),
  });

  /* A viewer cannot replay. */
  const viewer = await activity.onRequestPost({ env, request: new Request('https://phantomace.tv/api/activity', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie('123') }, body: JSON.stringify({ action: 'replay', id: 'row-1' }) }) });
  check('a viewer cannot replay', viewer.status, 403);

  /* The broadcaster can, and it re-pushes the alert. */
  const res = await activity.onRequestPost({ env, request: new Request('https://phantomace.tv/api/activity', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie(BROADCASTER) }, body: JSON.stringify({ action: 'replay', id: 'row-1' }) }) });
  check('the broadcaster can replay', res.status, 200);
  const ev = overlayEvents(env, 'raid');
  check('and the raid alert is re-pushed', ev.length, 1);
  check('with the original raider and count', [ev[0].who, ev[0].viewers], ['RaidLeader', 42]);

  /* An unknown id is a 404; a non-replayable action is refused. */
  const missing = await activity.onRequestPost({ env, request: new Request('https://phantomace.tv/api/activity', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie(BROADCASTER) }, body: JSON.stringify({ action: 'replay', id: 'nope' }) }) });
  check('an unknown id is 404', missing.status, 404);

  /* The page half. */
  const ajs = read('js/pages/activity.js');
  ok('the activity page has a replay button per replayable row', /act-replay/.test(ajs) && /REPLAYABLE/.test(ajs));
  ok('and posts the replay action', /action: 'replay'/.test(ajs) && /fetch\('\/api\/activity'/.test(ajs));
}

/* ══ #5 — the spin-the-wheel redemption actually spins ═════════════════════ */
{
  const env = makeEnv({
    wheel_config: JSON.stringify({ segments: [
      { label: 'Alpha', weight: 1, color: 'crimson' },
      { label: 'Beta', weight: 1, color: 'gold' },
    ] }),
  });
  const cp = await import('../../functions/api/channel-points.js');

  await cp.onRequestPost({ env, request: await signedPost('https://phantomace.tv/api/channel-points', cp, 'channel.channel_points_custom_reward_redemption.add', {
    id: 'r1', user_id: '77', user_name: 'spinner', reward: { id: 'rw1', title: 'Spin the Wheel' }, user_input: '',
  }) });

  const ev = overlayEvents(env, 'wheel-spin');
  check('a spin-the-wheel redemption pushes a wheel-spin event', ev.length, 1);
  ok('with segments and a chosen winner', Array.isArray(ev[0].segments) && typeof ev[0].winnerIndex === 'number');
  ok('and the redemption still queues for the site', !!env._store.get('cp_queue_77'));

  /* The redemption handler is wired to spinWheel in source. */
  ok('channel-points triggers the wheel', /spinWheel\(env\)/.test(read('functions/api/channel-points.js')));
  ok('wheel.js exports a shared spinWheel', /export async function spinWheel\(/.test(read('functions/api/wheel.js')));
}

/* ══ bot-setup subscribes to resubs ════════════════════════════════════════ */
{
  const setup = read('functions/api/admin/bot-setup.js');
  ok('bot-setup registers channel.subscription.message', /type: 'channel\.subscription\.message'/.test(setup));
  ok('pointed at the milestones route', /type: 'channel\.subscription\.message'[\s\S]{0,160}callback: `\$\{origin\}\/api\/milestones`/.test(setup));
}

/* ── Report ──────────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[overlay-state] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[overlay-state] ${passed} assertions passed.`);
console.log('');
