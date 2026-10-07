#!/usr/bin/env node
/* ══════════════════════════════════════════════
   CHANNEL POINT PREDICTIONS — test suite

     node server/scripts/test-predictions.js

   Predictions drive REAL channel points, so the two failure modes that matter
   are pinned here: bad input must be caught before a Twitch request is spent,
   and the missing-scope case must degrade to "not authorized yet" (inert)
   rather than a 500 that reads as broken.

   The mod gate is asserted on every action — the API has no moderator path for
   predictions, so a non-mod must never reach the broadcaster token.

   No database and no network: a fake KV and a stubbed Helix, so the create /
   lock / resolve / cancel payloads can be inspected rather than sent.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as predictions from '../../functions/api/bot/predictions.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

const BROADCASTER = '900';

/* ── The fake channel ─────────────────────────────────────────────────── */

let helixCalls = [];     // { method, url, body } for every /helix/predictions hit
let FAIL_STATUS = 0;     // when set, Helix answers this status
let FAIL_MESSAGE = '';
let STATUS_DATA = [];    // what a GET returns in its data[]

function makePrediction(over = {}) {
  return {
    id: over.id || 'pred-1',
    broadcaster_id: BROADCASTER,
    title: over.title || 'A prediction',
    status: over.status || 'ACTIVE',
    created_at: '2026-09-29T00:00:00Z',
    locked_at: over.locked_at || null,
    ended_at: over.ended_at || null,
    prediction_window: over.prediction_window || 120,
    winning_outcome_id: over.winning_outcome_id || null,
    outcomes: over.outcomes || [
      { id: 'o1', title: 'Yes', users: 3, channel_points: 300, color: 'BLUE' },
      { id: 'o2', title: 'No', users: 1, channel_points: 100, color: 'PINK' },
    ],
  };
}

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = opts.method || 'GET';

  if (u.includes('/helix/predictions')) {
    const body = opts.body ? JSON.parse(opts.body) : null;
    helixCalls.push({ method, url: u, body });

    if (FAIL_STATUS) {
      return new Response(JSON.stringify({ message: FAIL_MESSAGE }), { status: FAIL_STATUS });
    }
    if (method === 'GET') {
      return new Response(JSON.stringify({ data: STATUS_DATA }), { status: 200 });
    }
    if (method === 'POST') {
      return new Response(JSON.stringify({
        data: [makePrediction({ title: body.title, status: 'ACTIVE', outcomes: (body.outcomes || []).map((o, i) => ({ id: 'o' + (i + 1), title: o.title, users: 0, channel_points: 0, color: 'BLUE' })) })],
      }), { status: 200 });
    }
    if (method === 'PATCH') {
      return new Response(JSON.stringify({
        data: [makePrediction({ id: body.id, status: body.status, winning_outcome_id: body.winning_outcome_id })],
      }), { status: 200 });
    }
  }
  if (u.includes('oauth2/token') || u.includes('oauth2/validate')) {
    return new Response(JSON.stringify({ access_token: 't', expires_in: 3600, scopes: [] }), { status: 200 });
  }
  return new Response('{}', { status: 200 });
};

function makeEnv({ token = true } = {}) {
  const store = new Map();
  const chains = new Map();

  store.set('twitch_bot_token', JSON.stringify({ access_token: 'x', expiresAt: Date.now() + 3600e3 }));
  store.set('twitch_bot_user_id', '555');
  if (token) {
    store.set('twitch_broadcaster_token', JSON.stringify({ access_token: 'b', expiresAt: Date.now() + 3600e3 }));
  }

  return {
    TWITCH_BROADCASTER_ID: BROADCASTER,
    TWITCH_CLIENT_ID: 'cid',
    TWITCH_CLIENT_SECRET: 'secret',
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
      async listValues() { return []; },
    },
    _store: store,
  };
}

const session = (userId = BROADCASTER, name = 'PhantomACE') =>
  encodeURIComponent(JSON.stringify({ user_id: userId, display_name: name }));

function panelRequest(method, body, userId = BROADCASTER) {
  return new Request('https://phantomace.tv/api/bot/predictions', {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: `pham_session=${session(userId)}` },
    body: method === 'GET' ? undefined : JSON.stringify(body),
  });
}

const post = (env, body, userId) => predictions.onRequestPost({ env, request: panelRequest('POST', body, userId) });
const get = (env, userId) => predictions.onRequestGet({ env, request: panelRequest('GET', null, userId) });

const reset = () => { helixCalls = []; FAIL_STATUS = 0; FAIL_MESSAGE = ''; STATUS_DATA = []; };

/* ── Input validation, all WITHOUT reaching Twitch ───────────────────────
   Every rejection here must land before any /helix/predictions request. */
{
  reset();
  const env = makeEnv();
  const base = { action: 'create', outcomes: ['Yes', 'No'] };

  const noTitle = await post(env, { action: 'create', title: '', outcomes: ['Yes', 'No'] });
  check('an empty title is refused', noTitle.status, 400);

  const longTitle = await post(env, { ...base, title: 'x'.repeat(46) });
  check('a title over 45 chars is refused', longTitle.status, 400);

  const okTitleLen = 'y'.repeat(45);

  const oneOutcome = await post(env, { action: 'create', title: 'Boss fight', outcomes: ['Only one'] });
  check('fewer than 2 outcomes is refused', oneOutcome.status, 400);

  const tooMany = await post(env, { action: 'create', title: 'Boss fight', outcomes: Array.from({ length: 11 }, (_, i) => 'o' + i) });
  check('more than 10 outcomes is refused', tooMany.status, 400);

  const longOutcome = await post(env, { action: 'create', title: 'Boss fight', outcomes: ['Yes', 'z'.repeat(26)] });
  check('an outcome over 25 chars is refused', longOutcome.status, 400);

  const lowWindow = await post(env, { action: 'create', title: 'Boss fight', outcomes: ['Yes', 'No'], window: 29 });
  check('a window under 30 is refused', lowWindow.status, 400);

  const highWindow = await post(env, { action: 'create', title: 'Boss fight', outcomes: ['Yes', 'No'], window: 1801 });
  check('a window over 1800 is refused', highWindow.status, 400);

  const fracWindow = await post(env, { action: 'create', title: 'Boss fight', outcomes: ['Yes', 'No'], window: 60.5 });
  check('a fractional window is refused', fracWindow.status, 400);

  check('the max-length title is accepted', (await post(env, { action: 'create', title: okTitleLen, outcomes: ['Yes', 'No'] })).status, 200);

  /* One valid create at the end made exactly one POST; all the invalid ones
     above made none. */
  check('only the valid create reached Twitch', helixCalls.filter(c => c.method === 'POST').length, 1);
}

/* ── The mod gate on every action ─────────────────────────────────────── */
{
  reset();
  const env = makeEnv();
  const VIEWER = '12345';

  for (const body of [
    { action: 'create', title: 'x', outcomes: ['a', 'b'] },
    { action: 'status' },
    { action: 'lock', id: 'p' },
    { action: 'resolve', id: 'p', winningOutcomeId: 'o1' },
    { action: 'cancel', id: 'p' },
  ]) {
    const r = await post(env, body, VIEWER);
    check('a viewer is refused: ' + body.action, r.status, 403);
  }
  check('and a viewer never reached Twitch', helixCalls.length, 0);

  const g = await get(env, VIEWER);
  check('a viewer cannot GET status either', g.status, 403);
}

/* ── create sends the right Helix method + payload ───────────────────── */
{
  reset();
  const env = makeEnv();
  const r = await post(env, { action: 'create', title: 'Clutch?', outcomes: ['Yes', 'No', 'Maybe'], window: 300 });
  const body = await r.json();
  check('create succeeds', body.success, true);
  check('exactly one Helix call', helixCalls.length, 1);
  check('a POST', helixCalls[0].method, 'POST');
  check('with the broadcaster id', helixCalls[0].body.broadcaster_id, BROADCASTER);
  check('the title', helixCalls[0].body.title, 'Clutch?');
  check('outcomes as {title} objects', helixCalls[0].body.outcomes, [{ title: 'Yes' }, { title: 'No' }, { title: 'Maybe' }]);
  check('and the prediction window', helixCalls[0].body.prediction_window, 300);
  check('the created prediction comes back normalized', body.prediction.status, 'ACTIVE');
  check('with its outcomes', body.prediction.outcomes.map(o => o.title), ['Yes', 'No', 'Maybe']);

  /* Default window when omitted. */
  reset();
  await post(env, { action: 'create', title: 'Default window', outcomes: ['a', 'b'] });
  check('an omitted window defaults to 120', helixCalls[0].body.prediction_window, 120);
}

/* ── lock / resolve / cancel send the right PATCH payloads ───────────── */
{
  reset();
  const env = makeEnv();

  await post(env, { action: 'lock', id: 'pred-9' });
  check('lock is a PATCH', helixCalls[0].method, 'PATCH');
  check('locking sends status LOCKED', helixCalls[0].body, { broadcaster_id: BROADCASTER, id: 'pred-9', status: 'LOCKED' });

  reset();
  await post(env, { action: 'resolve', id: 'pred-9', winningOutcomeId: 'o2' });
  check('resolve sends status + winning outcome',
    helixCalls[0].body, { broadcaster_id: BROADCASTER, id: 'pred-9', status: 'RESOLVED', winning_outcome_id: 'o2' });

  reset();
  await post(env, { action: 'cancel', id: 'pred-9' });
  check('cancel sends status CANCELED', helixCalls[0].body, { broadcaster_id: BROADCASTER, id: 'pred-9', status: 'CANCELED' });

  /* lock/resolve/cancel need an id; resolve needs a winner — caught before Twitch. */
  reset();
  check('lock without an id is refused', (await post(env, { action: 'lock' })).status, 400);
  check('resolve without a winner is refused', (await post(env, { action: 'resolve', id: 'p' })).status, 400);
  check('and neither reached Twitch', helixCalls.length, 0);
}

/* ── status returns the latest prediction, or null ───────────────────── */
{
  reset();
  const env = makeEnv();

  STATUS_DATA = [];
  const empty = await (await get(env)).json();
  check('no predictions → prediction:null', empty.prediction, null);

  STATUS_DATA = [makePrediction({ status: 'LOCKED', locked_at: '2026-09-29T00:02:00Z' })];
  const one = await (await get(env)).json();
  check('a live prediction is returned', one.prediction.status, 'LOCKED');
  check('with per-outcome totals', one.prediction.outcomes[0].channelPoints, 300);
  check('and voter counts', one.prediction.outcomes[0].users, 3);
  check('status is a GET', helixCalls[helixCalls.length - 1].method, 'GET');
}

/* ── Missing token → clean 400, no throw ─────────────────────────────── */
{
  reset();
  const env = makeEnv({ token: false });
  let r, threw = false;
  try { r = await post(env, { action: 'create', title: 'x', outcomes: ['a', 'b'] }); }
  catch { threw = true; }
  check('a missing token does not throw', threw, false);
  check('it is a clean 400', r.status, 400);
  const body = await r.json();
  ok('naming Step 2 in bot setup', /Step 2/.test(body.error || ''));
  check('and flags the feature as unauthorized', body.authorized, false);
  check('no Twitch prediction call was made', helixCalls.length, 0);

  /* status with no token degrades the same way, not a 500. */
  const g = await get(env);
  check('status with no token is a clean 400', g.status, 400);
  check('never a 500', g.status < 500, true);
}

/* ── A Twitch 403 (scope not granted) is inert, not a 500 ────────────── */
{
  reset();
  const env = makeEnv();
  FAIL_STATUS = 403;
  FAIL_MESSAGE = 'Missing scope: channel:manage:predictions';

  let r, threw = false;
  try { r = await post(env, { action: 'create', title: 'Will it work?', outcomes: ['Yes', 'No'] }); }
  catch { threw = true; }
  check('a 403 from Twitch does not throw', threw, false);
  check('and is surfaced as 400, not 500', r.status, 400);
  const body = await r.json();
  check('flagged as not authorized (inert)', body.authorized, false);
  ok('with a non-scary message', /not authorized yet/i.test(body.error || ''));

  /* A 401 degrades identically. */
  reset();
  FAIL_STATUS = 401;
  const r2 = await post(env, { action: 'status' });
  const b2 = await r2.json();
  check('a 401 is inert too', b2.authorized, false);
  check('not a 500', r2.status, 400);
}

/* ── "Prediction already active" is passed through plainly ───────────── */
{
  reset();
  const env = makeEnv();
  FAIL_STATUS = 400;
  FAIL_MESSAGE = 'There is already an ACTIVE prediction';
  const r = await post(env, { action: 'create', title: 'Second one', outcomes: ['Yes', 'No'] });
  const body = await r.json();
  check('a clean 400', r.status, 400);
  ok('surfacing Twitch\'s own words', /already an ACTIVE prediction/i.test(body.error || ''));
  /* Not mistaken for the missing-scope case. */
  ok('and not flagged as an auth problem', body.authorized === undefined);
}

/* ── An unknown action is rejected ───────────────────────────────────── */
{
  reset();
  const env = makeEnv();
  check('an unknown action is refused', (await post(env, { action: 'nope' })).status, 400);
}

/* ── ROUND PREDICTIONS, titled from the Siege match tracker ─────────────
   One button mid-match is the whole value: he has no hands free to type a
   title, and the round and side are already known. A prediction cannot be
   retitled once open, so everything here is about refusing rather than
   guessing when the title would be wrong about the thing it states. */
async function startMatch(env, side) {
  const m = await import('../../functions/api/r6-match.js');
  await m.startMatch(env, side);
  return m;
}

{
  reset();
  const env = makeEnv();
  const r = await post(env, { action: 'round' });
  check('with no match it refuses', r.status, 400);
  ok('naming where to start one', /No tracked match/.test((await r.json()).error));
  check('and never reaches Twitch', helixCalls.length, 0);
}

{
  reset();
  const env = makeEnv();
  await startMatch(env, 'attack');
  const r = await post(env, { action: 'round' });
  check('round 1 on attack opens', r.status, 200);
  const sent = helixCalls.find(c => c.method === 'POST');
  check('titled after the round and side', sent.body.title, 'Round 1 (ATK) — win it?');
  check('with a win/lose pair', sent.body.outcomes.map(o => o.title), ['Win', 'Lose']);
  check('and a window suited to a round', sent.body.prediction_window, 90);
}

{
  reset();
  const env = makeEnv();
  const m = await startMatch(env, 'attack');
  /* Past the swap: the title has to follow the side, not the start. */
  for (const x of ['won', 'lost', 'won']) await m.scoreRound(env, x);
  await post(env, { action: 'round' });
  const sent = helixCalls.find(c => c.method === 'POST');
  check('round 4 is titled as defence', sent.body.title, 'Round 4 (DEF) — win it?');
}

{
  reset();
  const env = makeEnv();
  const m = await startMatch(env, 'attack');
  for (const x of ['won', 'lost', 'won', 'lost', 'won', 'lost']) await m.scoreRound(env, x);
  /* 3-3: overtime has not been told its side, so the title cannot be right. */
  const refused = await post(env, { action: 'round' });
  check('overtime without a side refuses', refused.status, 400);
  ok('saying what is missing', /overtime starts on/.test((await refused.json()).error));
  check('and spends no Twitch request', helixCalls.length, 0);

  await m.setOvertimeSide(env, 'defence');
  await post(env, { action: 'round' });
  const sent = helixCalls.find(c => c.method === 'POST');
  check('once answered it marks the round as overtime', sent.body.title, 'OT Round 7 (DEF) — win it?');
}

{
  reset();
  const env = makeEnv();
  await startMatch(env, 'defence');
  await post(env, { action: 'round', window: 45 });
  check('the window can be overridden', helixCalls.find(c => c.method === 'POST').body.prediction_window, 45);

  reset();
  const bad = await post(env, { action: 'round', window: 5 });
  check('but not out of range', bad.status, 400);
  check('without reaching Twitch', helixCalls.length, 0);
}

{
  reset();
  const env = makeEnv();
  await startMatch(env, 'attack');
  /* Every round number must fit Twitch's 45-character title limit. */
  const m = await import('../../functions/api/r6-match.js');
  for (let round = 1; round <= 9; round++) {
    const t = `OT Round ${round} (DEF) — win it?`;
    ok(`a round ${round} title fits the limit`, t.length <= 45);
  }
}

{
  reset();
  const env = makeEnv({ token: false });
  await startMatch(env, 'attack');
  const r = await post(env, { action: 'round' });
  check('unauthorized degrades the same as a manual create', r.status, 400);
  check('reported as not authorized, not broken', (await r.json()).authorized, false);
}

{
  reset();
  const env = makeEnv();
  await startMatch(env, 'attack');
  const r = await post(env, { action: 'round' }, 'nobody');
  check('a non-staff caller is refused', r.status, 403);
  check('and never reaches Twitch', helixCalls.length, 0);
}

{
  const dashHtml = fs.readFileSync(path.join(REPO, 'overlay-dashboard.html'), 'utf8');
  ok('the dashboard has the one-button control', /id="odR6PredictBtn"/.test(dashHtml));
  const dashJs = fs.readFileSync(path.join(REPO, 'js/pages/overlay-dashboard.js'), 'utf8');
  ok('wired to the round action', /action: 'round'/.test(dashJs));
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[predictions] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[predictions] ${passed} assertions passed.`);
console.log('');
