#!/usr/bin/env node
/* ══════════════════════════════════════════════
   PREDICTION EVENTSUB WEBHOOK — test suite

     node server/scripts/test-prediction-events.js

   Two things have to hold for the overlay + feed integration:

     1. EVERY prediction state (begin / progress / lock / end) pushes ONE
        overlay event of the agreed shape, so the on-stream panel can render
        from a single thing.
     2. The activity feed records begin / lock / end ONLY. progress is
        high-frequency — it must update the overlay but must NOT spam the feed,
        or one prediction buries it under hundreds of rows.

   Driven end-to-end through onRequestPost with real Twitch-style signed
   requests (so the fail-closed verification is exercised too), then the fake
   KV is inspected for what landed in the overlay feed and the activity feed.
   No network: Helix is not called by this webhook at all.
   ══════════════════════════════════════════════ */

import { signEventSub } from '../lib/eventsub.js';
import * as pe from '../../functions/api/prediction-events.js';

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

const SECRET = 'a-test-eventsub-secret';

function makeEnv() {
  const store = new Map();
  const chains = new Map();
  return {
    TWITCH_EVENTSUB_SECRET: SECRET,
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

/* pushOverlayEvent dynamically imports ./overlay/events.js which touches no
   network; recordActivity imports ./activity.js which also does not. So a
   signed notification runs the whole path against the fake KV. */
async function notify(env, subType, event) {
  const raw = JSON.stringify({ subscription: { type: subType }, event });
  const messageId = 'mid-' + subType + '-' + Math.random().toString(36).slice(2);
  const ts = new Date().toISOString();
  const request = new Request('https://phantomace.tv/api/prediction-events', {
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
  return pe.onRequestPost({ env, request });
}

const overlayEvents = (env) => {
  const rec = env._store.get('overlay_events');
  return rec ? JSON.parse(rec).events.filter(e => e.type === 'prediction') : [];
};
const activityRows = (env) => {
  const rec = env._store.get('activity_feed');
  return rec ? JSON.parse(rec) : [];
};

const OUTCOMES = [
  { id: 'o1', title: 'Yes', color: 'BLUE', users: 30, channel_points: 9000 },
  { id: 'o2', title: 'No', color: 'PINK', users: 10, channel_points: 1000 },
];

/* ── The overlay event shape, per state (pure builder) ────────────────── */
{
  const begin = pe.predictionOverlayEvent('channel.prediction.begin', {
    id: 'p1', title: 'Who wins?', outcomes: [{ id: 'o1', title: 'Yes', color: 'BLUE' }, { id: 'o2', title: 'No', color: 'PINK' }],
    locks_at: '2026-09-29T00:02:00Z',
  });
  check('begin → ACTIVE', begin.status, 'ACTIVE');
  check('begin state', begin.state, 'begin');
  check('begin carries the title', begin.title, 'Who wins?');
  check('begin carries the lock time', begin.locksAt, '2026-09-29T00:02:00Z');
  check('begin outcomes default to zero totals', begin.outcomes, [
    { id: 'o1', title: 'Yes', points: 0, users: 0, color: 'BLUE' },
    { id: 'o2', title: 'No', points: 0, users: 0, color: 'PINK' },
  ]);
  check('the event type is always prediction', begin.type, 'prediction');

  const prog = pe.predictionOverlayEvent('channel.prediction.progress', {
    id: 'p1', title: 'Who wins?', outcomes: OUTCOMES, locks_at: '2026-09-29T00:02:00Z',
  });
  check('progress → ACTIVE', prog.status, 'ACTIVE');
  check('progress carries live totals', prog.outcomes, [
    { id: 'o1', title: 'Yes', points: 9000, users: 30, color: 'BLUE' },
    { id: 'o2', title: 'No', points: 1000, users: 10, color: 'PINK' },
  ]);

  const lock = pe.predictionOverlayEvent('channel.prediction.lock', {
    id: 'p1', title: 'Who wins?', outcomes: OUTCOMES, locked_at: '2026-09-29T00:02:00Z',
  });
  check('lock → LOCKED', lock.status, 'LOCKED');
  check('lock surfaces locked_at as the lock time', lock.locksAt, '2026-09-29T00:02:00Z');

  const resolved = pe.predictionOverlayEvent('channel.prediction.end', {
    id: 'p1', title: 'Who wins?', status: 'resolved', winning_outcome_id: 'o1', outcomes: OUTCOMES,
  });
  check('end resolved → RESOLVED', resolved.status, 'RESOLVED');
  check('and carries the winning outcome', resolved.winningOutcomeId, 'o1');

  const canceled = pe.predictionOverlayEvent('channel.prediction.end', {
    id: 'p1', title: 'Who wins?', status: 'canceled', outcomes: OUTCOMES,
  });
  check('end canceled → CANCELED', canceled.status, 'CANCELED');
  check('with no winner', canceled.winningOutcomeId, null);

  check('an unknown subscription type yields no overlay event', pe.predictionOverlayEvent('channel.other', {}), null);
}

/* ── The activity entry: begin / lock / end only ─────────────────────── */
{
  ok('begin records', !!pe.predictionActivityEntry('channel.prediction.begin', { title: 'T' }));
  ok('lock records', !!pe.predictionActivityEntry('channel.prediction.lock', { title: 'T' }));
  ok('end records', !!pe.predictionActivityEntry('channel.prediction.end', { title: 'T', status: 'resolved', outcomes: OUTCOMES, winning_outcome_id: 'o1' }));
  check('PROGRESS records nothing', pe.predictionActivityEntry('channel.prediction.progress', { title: 'T', outcomes: OUTCOMES }), null);

  const end = pe.predictionActivityEntry('channel.prediction.end', { title: 'Who wins?', status: 'resolved', outcomes: OUTCOMES, winning_outcome_id: 'o1' });
  ok('a resolved summary names the winning outcome', /"Yes" won/.test(end.summary));
  const cancel = pe.predictionActivityEntry('channel.prediction.end', { title: 'Who wins?', status: 'canceled' });
  ok('a canceled summary says refunded', /refunded/i.test(cancel.summary));
  check('every prediction row is categorised', pe.predictionActivityEntry('channel.prediction.begin', { title: 'T' }).category, 'prediction');
}

/* ── End-to-end: the webhook pushes overlay events for ALL states ─────── */
{
  const env = makeEnv();
  await notify(env, 'channel.prediction.begin', { id: 'p1', title: 'Who wins?', outcomes: OUTCOMES, locks_at: '2026-09-29T00:02:00Z' });
  await notify(env, 'channel.prediction.progress', { id: 'p1', title: 'Who wins?', outcomes: OUTCOMES, locks_at: '2026-09-29T00:02:00Z' });
  await notify(env, 'channel.prediction.progress', { id: 'p1', title: 'Who wins?', outcomes: OUTCOMES, locks_at: '2026-09-29T00:02:00Z' });
  await notify(env, 'channel.prediction.lock', { id: 'p1', title: 'Who wins?', outcomes: OUTCOMES, locked_at: '2026-09-29T00:02:00Z' });
  await notify(env, 'channel.prediction.end', { id: 'p1', title: 'Who wins?', status: 'resolved', winning_outcome_id: 'o1', outcomes: OUTCOMES });

  const ev = overlayEvents(env);
  /* Progress is a snapshot: the second REPLACES the first in the buffer
     rather than appending, so the shared feed holds one progress at most. */
  check('every state reached the overlay feed, progress coalesced to the latest', ev.map(e => e.state), ['begin', 'progress', 'lock', 'end']);
  ok('the surviving progress is the newer one (a fresh seq)', ev[1].seq > ev[0].seq + 1);
  check('the overlay events are all type prediction', ev.every(e => e.type === 'prediction'), true);
  check('the last one is the resolved winner', ev[ev.length - 1].winningOutcomeId, 'o1');
}

/* ── End-to-end: the activity feed gets begin/lock/end, NOT progress ──── */
{
  const env = makeEnv();
  await notify(env, 'channel.prediction.begin', { id: 'p2', title: 'Feed test', outcomes: OUTCOMES, locks_at: '2026-09-29T00:02:00Z' });
  for (let i = 0; i < 5; i++) {
    await notify(env, 'channel.prediction.progress', { id: 'p2', title: 'Feed test', outcomes: OUTCOMES, locks_at: '2026-09-29T00:02:00Z' });
  }
  await notify(env, 'channel.prediction.lock', { id: 'p2', title: 'Feed test', outcomes: OUTCOMES, locked_at: '2026-09-29T00:02:00Z' });
  await notify(env, 'channel.prediction.end', { id: 'p2', title: 'Feed test', status: 'resolved', winning_outcome_id: 'o1', outcomes: OUTCOMES });

  const rows = activityRows(env);
  const types = rows.map(r => r.type).sort();
  check('exactly three feed rows despite five progress events', rows.length, 3);
  check('and they are begin, lock, end only', types, ['prediction-begin', 'prediction-end', 'prediction-lock']);
  ok('no progress row leaked into the feed', !rows.some(r => /progress/.test(r.type)));

  /* Meanwhile the overlay feed holds begin, ONE progress, lock and end. */
  check('the overlay feed carries every state, progress coalesced', overlayEvents(env).map(e => e.state), ['begin', 'progress', 'lock', 'end']);
}

/* ── PROGRESS CANNOT FLOOD THE SHARED BUFFER ──────────────────────────
   The overlay feed is 60 slots shared with every alert. A busy prediction
   fires progress on every vote; appended, two hundred of them would evict the
   sub and raid that landed just before — exactly the alerts that must not be
   lost while the overlay is behind. */
{
  const env = makeEnv();
  const { pushOverlayEvent } = await import('../../functions/api/overlay/events.js');
  await pushOverlayEvent(env, { type: 'sub', who: 'Subber' });
  await pushOverlayEvent(env, { type: 'raid', who: 'Raider', viewers: 12 });
  await notify(env, 'channel.prediction.begin', { id: 'p3', title: 'Flood', outcomes: OUTCOMES, locks_at: '2026-09-29T00:02:00Z' });
  for (let i = 0; i < 200; i++) {
    await notify(env, 'channel.prediction.progress', { id: 'p3', title: 'Flood', outcomes: OUTCOMES, locks_at: '2026-09-29T00:02:00Z' });
  }
  const all = JSON.parse(env._store.get('overlay_events')).events;
  ok('the sub survives two hundred progress events', all.some(e => e.type === 'sub'));
  ok('and so does the raid', all.some(e => e.type === 'raid'));
  check('only one progress is buffered', all.filter(e => e.state === 'progress').length, 1);
  check('the feed seq still counted every push', JSON.parse(env._store.get('overlay_events')).seq, 203);
}

/* ── A switched-off prediction alert still tears its panel down ───────
   Toggling predictions off mid-prediction used to swallow the 'end', so the
   panel stayed up for the rest of the stream. The end now goes through,
   marked quiet: the overlay closes the panel without a reveal. Begin and
   progress stay blocked. */
{
  const env = makeEnv();
  env._store.set('alert_toggles', JSON.stringify({ prediction: false }));
  await notify(env, 'channel.prediction.begin', { id: 'p4', title: 'Off', outcomes: OUTCOMES, locks_at: '2026-09-29T00:02:00Z' });
  await notify(env, 'channel.prediction.progress', { id: 'p4', title: 'Off', outcomes: OUTCOMES, locks_at: '2026-09-29T00:02:00Z' });
  await notify(env, 'channel.prediction.lock', { id: 'p4', title: 'Off', outcomes: OUTCOMES, locked_at: '2026-09-29T00:02:00Z' });
  await notify(env, 'channel.prediction.end', { id: 'p4', title: 'Off', status: 'resolved', winning_outcome_id: 'o1', outcomes: OUTCOMES });
  const ev = overlayEvents(env);
  check('a disabled prediction pushes only its end', ev.map(e => e.state), ['end']);
  check('and that end is quiet (teardown, no reveal)', ev[0].quiet, true);
}

/* ── webhook_callback_verification returns the challenge as text/plain ── */
{
  const env = makeEnv();
  const challenge = 'abc-challenge-123';
  const raw = JSON.stringify({ challenge, subscription: { type: 'channel.prediction.begin' } });
  const messageId = 'verify-1';
  const ts = new Date().toISOString();
  const request = new Request('https://phantomace.tv/api/prediction-events', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'twitch-eventsub-message-type': 'webhook_callback_verification',
      'twitch-eventsub-message-id': messageId,
      'twitch-eventsub-message-timestamp': ts,
      'twitch-eventsub-message-signature': await signEventSub(SECRET, messageId, ts, raw),
    },
    body: raw,
  });
  const res = await pe.onRequestPost({ env, request });
  check('challenge verification is 200', res.status, 200);
  check('and echoes the challenge verbatim', await res.text(), challenge);
  check('as text/plain', res.headers.get('Content-Type'), 'text/plain');
}

/* ── Fails closed on a bad signature ─────────────────────────────────── */
{
  const env = makeEnv();
  const raw = JSON.stringify({ subscription: { type: 'channel.prediction.begin' }, event: { id: 'x', title: 'nope', outcomes: OUTCOMES } });
  const request = new Request('https://phantomace.tv/api/prediction-events', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'twitch-eventsub-message-type': 'notification',
      'twitch-eventsub-message-id': 'forged',
      'twitch-eventsub-message-timestamp': new Date().toISOString(),
      'twitch-eventsub-message-signature': 'sha256=deadbeef',
    },
    body: raw,
  });
  const res = await pe.onRequestPost({ env, request });
  check('a forged signature is rejected', res.status, 403);
  check('and nothing reached the overlay feed', overlayEvents(env).length, 0);
  check('nor the activity feed', activityRows(env).length, 0);
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[prediction-events] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[prediction-events] ${passed} assertions passed.`);
console.log('');
