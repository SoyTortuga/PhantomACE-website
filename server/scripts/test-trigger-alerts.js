#!/usr/bin/env node
/* ══════════════════════════════════════════════
   TEST-ALERT SUITE — server test

     node server/scripts/test-trigger-alerts.js

   The Overlay Dashboard's "Test Alerts" buttons POST { action:'test-alert',
   type } to /api/bot/trigger, which must push a representative sample of THAT
   type onto the overlay feed (so it renders + self-clears like the real one),
   reject an unknown type, and stay staff-gated. The sample SHAPES rendering
   correctly is covered in the overlay preview; here we pin the routing, the
   type coverage, and the gate.
   ══════════════════════════════════════════════ */

import * as trigger from '../../functions/api/bot/trigger.js';

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

const BROADCASTER = '900';

function makeEnv() {
  const store = new Map();
  const chains = new Map();
  return {
    TWITCH_BROADCASTER_ID: BROADCASTER,
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

const session = (userId = BROADCASTER) => encodeURIComponent(JSON.stringify({ user_id: userId, display_name: 'PhantomACE' }));
function req(body, userId = BROADCASTER) {
  return new Request('https://phantomace.tv/api/bot/trigger', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `pham_session=${session(userId)}` },
    body: JSON.stringify(body),
  });
}
const post = (env, body, userId) => trigger.onRequestPost({ env, request: req(body, userId) });
const lastEvent = (env) => {
  const rec = env._store.get('overlay_events');
  const events = rec ? JSON.parse(rec).events : [];
  return events[events.length - 1] || null;
};

/* ── Every one-shot type fires a matching overlay event ──────────────── */
{
  ok('the suite exports its type list', Array.isArray(trigger.TEST_ALERT_TYPES) && trigger.TEST_ALERT_TYPES.length >= 13);

  for (const type of trigger.TEST_ALERT_TYPES) {
    const env = makeEnv();
    const res = await post(env, { action: 'test-alert', type });
    check(`test-alert ${type} succeeds`, res.status, 200);
    const ev = lastEvent(env);
    check(`test-alert ${type} pushes a ${type} overlay event`, ev && ev.type, type);
  }

  /* Spot-check that samples carry the obviously-fake marker data. */
  const env = makeEnv();
  await post(env, { action: 'test-alert', type: 'giftsub' });
  const gs = lastEvent(env);
  check('the giftsub sample uses the test name', gs.who, 'TestReaper');
  check('and a sample count', gs.count, 10);

  const env2 = makeEnv();
  await post(env2, { action: 'test-alert', type: 'prediction' });
  const pr = lastEvent(env2);
  /* The prediction test fires the RESOLVED end-state so the panel auto-hides. */
  check('the prediction sample fires the resolved end-state', [pr.state, pr.status], ['end', 'RESOLVED']);
  check('with a winning outcome so the panel reveals then hides', pr.winningOutcomeId, 'o1');

  const env3 = makeEnv();
  await post(env3, { action: 'test-alert', type: 'giveaway-spin' });
  const gv = lastEvent(env3);
  ok('the giveaway sample carries a reel to spin', Array.isArray(gv.entrants) && gv.entrants.length > 1);
  ok('landing on a real index', gv.entrants[gv.winnerIndex] && gv.entrants[gv.winnerIndex].username === gv.who);

  /* The two new Twitch-native samples (Phase 6a). */
  const envF = makeEnv();
  await post(envF, { action: 'test-alert', type: 'follow' });
  check('the follow sample uses the test name', lastEvent(envF).user, 'TestFollower');
  const envC = makeEnv();
  await post(envC, { action: 'test-alert', type: 'cheer' });
  const cv = lastEvent(envC);
  check('the cheer sample carries bits', cv.bits, 500);
  ok('and a message', typeof cv.message === 'string' && cv.message.length > 0);
}

/* ── Unknown type is refused ─────────────────────────────────────────── */
{
  const env = makeEnv();
  const res = await post(env, { action: 'test-alert', type: 'not-a-type' });
  check('an unknown test type is refused', res.status, 400);
  check('and nothing was pushed', env._store.get('overlay_events') || null, null);
}

/* ── Staff gate ──────────────────────────────────────────────────────── */
{
  const env = makeEnv();
  const res = await post(env, { action: 'test-alert', type: 'sub' }, '12345');
  check('a viewer cannot fire a test alert', res.status, 403);
  check('and nothing was pushed', env._store.get('overlay_events') || null, null);
}

/* ── Per-alert toggle: a disabled type's test does not enqueue ─────────── */
{
  const env = makeEnv();
  const off = await post(env, { action: 'alert-toggle', type: 'follow', enabled: false });
  check('toggling a known alert off succeeds', off.status, 200);

  await post(env, { action: 'test-alert', type: 'follow' });
  check('a disabled type\'s test is dropped', lastEvent(env), null);

  await post(env, { action: 'test-alert', type: 'sub' });
  check('an enabled type still fires', lastEvent(env) && lastEvent(env).type, 'sub');

  /* Re-enabling brings it back. */
  await post(env, { action: 'alert-toggle', type: 'follow', enabled: true });
  await post(env, { action: 'test-alert', type: 'follow' });
  check('re-enabled, the type fires again', lastEvent(env).type, 'follow');

  const bad = await post(env, { action: 'alert-toggle', type: 'not-a-type', enabled: false });
  check('toggling an unknown type is refused', bad.status, 400);

  const denied = await post(env, { action: 'alert-toggle', type: 'follow', enabled: false }, '12345');
  check('a viewer cannot change a toggle', denied.status, 403);
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[trigger-alerts] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[trigger-alerts] ${passed} assertions passed.`);
console.log('');
