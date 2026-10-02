#!/usr/bin/env node
/* ══════════════════════════════════════════════
   EVENTSUB RELIABILITY — test suite

     node server/scripts/test-eventsub-revocation.js

   Three ways a webhook used to fail quietly:

   1. REVOKED LOOKED GREEN. Every route answered a revocation with a bare
      200 (milestones and bits had no branch at all), and Bot Control read a
      snapshot written once when the subscriptions were created. Revocations
      are now recorded per type in eventsub_revoked, shown red on the panel,
      and cleared when that type delivers again or is re-created.

   2. A THROW BECAME A 500. channel-points, hype-train and ad-break let a
      database blip escape; Twitch retries and then disables the
      subscription. They now log and answer 200 — the verifier has already
      claimed the message id, so a retry could not have helped.

   3. CHAT WAITED ON HELIX. bot/commands.js awaited every bot reply before
      answering Twitch. Replies on the hot paths now go out after.

   Also: cheermote tokens stripped from cheer text shown on stream.
   ══════════════════════════════════════════════ */

import { signEventSub } from '../lib/eventsub.js';

const SECRET = 'a-test-eventsub-secret';

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

let helixDelay = 0;
const sent = [];
globalThis.fetch = async (url, opts) => {
  if (String(url).includes('/helix/chat/messages')) {
    if (helixDelay) await new Promise(r => setTimeout(r, helixDelay));
    sent.push(JSON.parse(opts.body).message);
    return new Response(JSON.stringify({ data: [{ is_sent: true }] }), { status: 200 });
  }
  return new Response('{}', { status: 500 });
};

function makeEnv() {
  const store = new Map();
  const chains = new Map();
  store.set('twitch_bot_token', JSON.stringify({ access_token: 't', expiresAt: Date.now() + 3600000 }));
  return {
    TWITCH_EVENTSUB_SECRET: SECRET,
    TWITCH_BROADCASTER_ID: '1',
    TWITCH_CLIENT_ID: 'c',
    MARKETPLACE: {
      async get(k, t) { if (!store.has(k)) return null; const r = store.get(k); return t === 'json' ? JSON.parse(r) : r; },
      async put(k, v) { store.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
      async delete(k) { store.delete(k); },
      async list() { return { keys: [], list_complete: true }; },
      async listValues() { return []; },
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
      async pullGiveawayCode() { return null; },
    },
    _store: store,
  };
}

let seq = 0;
async function deliver(mod, env, messageType, type, event = {}, extra = {}) {
  const raw = JSON.stringify({
    subscription: { type, status: messageType === 'revocation' ? 'notification_failures_exceeded' : 'enabled' },
    event,
  });
  const id = `rev-${++seq}-${Math.random()}`;
  const ts = new Date().toISOString();
  const request = new Request('https://phantomace.tv/api/x', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'twitch-eventsub-message-type': messageType,
      'twitch-eventsub-message-id': id,
      'twitch-eventsub-message-timestamp': ts,
      'twitch-eventsub-message-signature': await signEventSub(SECRET, id, ts, raw),
    },
    body: raw,
  });
  return mod.onRequestPost({ env, request, waitUntil() {}, ...extra });
}

const revoked = (env) => JSON.parse(env._store.get('eventsub_revoked') || '{}');
const quiet = { error: console.error, warn: console.warn, log: console.log };
console.error = console.warn = () => {};

const dash = await import('../../functions/api/bot/dashboard.js');

/* ── Every route records its revocation ──────────────────────────────── */
const ROUTES = [
  ['channel points', '../../functions/api/channel-points.js', 'channel.channel_points_custom_reward_redemption.add', true],
  ['hype train', '../../functions/api/hype-train.js', 'channel.hype_train.begin', true],
  ['milestones', '../../functions/api/milestones.js', 'channel.raid', true],
  ['ad break', '../../functions/api/ad-break.js', 'channel.ad_break.begin', true],
  ['bits', '../../functions/api/bits.js', 'channel.bits.use', true],
  ['chat commands', '../../functions/api/bot/commands.js', 'channel.chat.message', true],
  /* Revocation branch only — its notification path belongs to the overlay
     work. Cleared by Create Subscriptions instead (activeRevocations). */
  ['prediction events', '../../functions/api/prediction-events.js', 'channel.prediction.begin', false],
];

for (const [name, spec, type, clearsOnNotify] of ROUTES) {
  const mod = await import(spec);
  const env = makeEnv();
  dash._resetRevokedCache();

  const res = await deliver(mod, env, 'revocation', type);
  check(`${name}: a revocation is answered 200`, res.status, 200);
  const rec = revoked(env)[type];
  ok(`${name}: and recorded under its type`, rec && rec.type === type);
  check(`${name}: with Twitch's reason`, rec && rec.reason, 'notification_failures_exceeded');
  ok(`${name}: and when`, rec && rec.at > 0);

  if (clearsOnNotify) {
    const event = type === 'channel.chat.message'
      ? { chatter_user_id: '9', chatter_user_name: 'x', message: { text: 'hello' }, badges: [] }
      : type === 'channel.ad_break.begin'
        ? { duration_seconds: 60, started_at: new Date().toISOString() }
        : { id: 'e1', level: 1, total: 0, goal: 100, viewers: 1, from_broadcaster_user_name: 'r', reward: { title: 'nothing' }, user_id: '9' };
    await deliver(mod, env, 'notification', type, event);
    check(`${name}: a later notification clears it`, revoked(env)[type], undefined);
  }
}

/* ── A revocation does not clear another type ────────────────────────── */
{
  const env = makeEnv();
  dash._resetRevokedCache();
  const ms = await import('../../functions/api/milestones.js');
  await deliver(ms, env, 'revocation', 'channel.follow');
  await deliver(ms, env, 'notification', 'channel.raid', { viewers: 1, from_broadcaster_user_name: 'r' });
  ok('a raid arriving does not clear a revoked follow', !!revoked(env)['channel.follow']);
}

/* ── Re-creating the subscription clears it on the panel ─────────────── */
{
  const at = Date.now();
  const rec = {
    'channel.follow': { type: 'channel.follow', reason: 'authorization_revoked', at },
    'channel.prediction.end': { type: 'channel.prediction.end', reason: 'user_removed', at: at - 10 },
  };
  check('with no re-creation, both stand',
    dash.activeRevocations(rec, []).map(r => r.type), ['channel.follow', 'channel.prediction.end']);
  check('a re-creation AFTER the revocation clears that type',
    dash.activeRevocations(rec, [{ type: 'channel.follow', createdAt: at + 1 }]).map(r => r.type), ['channel.prediction.end']);
  check('a creation BEFORE it does not',
    dash.activeRevocations(rec, [{ type: 'channel.follow', createdAt: at - 1 }]).length, 2);
  check('garbage in is nothing out', dash.activeRevocations(null, null), []);
}

/* ── The panel is told ───────────────────────────────────────────────── */
{
  const env = makeEnv();
  env.MARKETPLACE.giveawayPoolLevels = async () => ({});
  env._store.set('eventsub_subscriptions', JSON.stringify([
    { type: 'channel.hype_train.progress', createdAt: 1 },
    { type: 'channel.chat.message', createdAt: 1 },
  ]));
  env._store.set('eventsub_revoked', JSON.stringify({
    'channel.hype_train.progress': { type: 'channel.hype_train.progress', reason: 'authorization_revoked', at: 5 },
  }));
  const request = new Request('https://phantomace.tv/api/bot/dashboard', {
    headers: { Cookie: 'pham_session=' + encodeURIComponent(JSON.stringify({ user_id: '1', display_name: 'b' })) },
  });
  let data = null;
  try {
    const res = await dash.onRequestGet({ env, request });
    data = await res.json();
  } catch (err) {
    failures.push('dashboard GET threw: ' + err.message);
  }
  if (data) {
    check('the dashboard lists the revoked type', (data.subscriptions.revoked || []).map(r => r.type), ['channel.hype_train.progress']);
    check('its row reads revoked, not active', data.subscriptions.revokedRows.hypeTrain, true);
    check('while an unrevoked row does not', data.subscriptions.revokedRows.chat, false);
  }
}

/* ── Throws answer 200 ───────────────────────────────────────────────── */
{
  const failing = () => {
    const env = makeEnv();
    env.MARKETPLACE.mutate = async () => { throw new Error('database unavailable'); };
    env.MARKETPLACE.put = async () => { throw new Error('database unavailable'); };
    return env;
  };
  const cp = await import('../../functions/api/channel-points.js');
  const r1 = await deliver(cp, failing(), 'notification', 'channel.channel_points_custom_reward_redemption.add',
    { id: 'r', user_id: '5', user_name: 'v', reward: { id: 'rw', title: 'Skull Boost' } });
  check('channel points: a failing handler answers 200', r1.status, 200);

  const ad = await import('../../functions/api/ad-break.js');
  const r2 = await deliver(ad, failing(), 'notification', 'channel.ad_break.begin',
    { duration_seconds: 90, started_at: new Date().toISOString() });
  check('ad break: a failing handler answers 200', r2.status, 200);

  const cmd = await import('../../functions/api/bot/commands.js');
  const r3 = await deliver(cmd, failing(), 'notification', 'channel.chat.message',
    { chatter_user_id: '1', chatter_user_name: 'b', message: { text: '!announce hi' }, badges: [{ set_id: 'broadcaster' }] });
  check('chat commands: a failing handler answers 200', r3.status, 200);
}

/* ── Chat replies wait until after the answer ────────────────────────── */
{
  const env = makeEnv();
  const { startMaze, _resetHint } = await import('../../functions/api/bot/maze.js');
  await startMaze(env);
  _resetHint();
  /* Walk the maze to its goal along its own solution, so the last move
     produces a clear line to say. */
  const st = JSON.parse(env._store.get('maze_current'));
  const DIRS = { up: [0, -1, 1], right: [1, 0, 2], down: [0, 1, 4], left: [-1, 0, 8] };
  const size = st.size;
  const walls = (x, y) => parseInt(st.walls[y][x], 16);
  const prev = new Map([['0,0', null]]);
  const queue = [[0, 0]];
  while (queue.length) {
    const [x, y] = queue.shift();
    for (const [dir, [dx, dy, bit]] of Object.entries(DIRS)) {
      if (walls(x, y) & bit) continue;
      const nx = x + dx, ny = y + dy, k = nx + ',' + ny;
      if (nx < 0 || ny < 0 || nx >= size || ny >= size || prev.has(k)) continue;
      prev.set(k, [x + ',' + y, dir]);
      queue.push([nx, ny]);
    }
  }
  const path = [];
  for (let k = (size - 1) + ',' + (size - 1); prev.get(k); k = prev.get(k)[0]) path.unshift(prev.get(k)[1]);

  const cmd = await import('../../functions/api/bot/commands.js');
  sent.length = 0;
  for (const dir of path.slice(0, -1)) {
    await deliver(cmd, env, 'notification', 'channel.chat.message',
      { chatter_user_id: '7', chatter_user_name: 'mover', message: { text: dir }, badges: [] });
  }
  helixDelay = 150;
  const waited = [];
  const t0 = Date.now();
  const res = await deliver(cmd, env, 'notification', 'channel.chat.message',
    { chatter_user_id: '7', chatter_user_name: 'mover', message: { text: path[path.length - 1] }, badges: [] },
    { waitUntil(p) { waited.push(p); } });
  const answeredIn = Date.now() - t0;
  check('the winning move is answered 200', res.status, 200);
  ok('before the clear message has gone out', answeredIn < helixDelay);
  check('the send is handed to waitUntil', waited.length, 1);
  await Promise.all(waited);
  ok('and does go out afterwards', sent.some(m => /cleared/.test(m)));
  helixDelay = 0;
}

/* ── Cheermotes ──────────────────────────────────────────────────────── */
{
  const { stripCheermotes } = await import('../../functions/api/milestones.js');
  check('a plain cheer token goes', stripCheermotes('Cheer100 great stream!', 100), 'great stream!');
  check('several, anywhere in the line', stripCheermotes('Cheer50 hype Kappa25 train Cheer25', 100), 'hype train');
  check('case does not matter', stripCheermotes('cheer100 gg', 100), 'gg');
  check('global prefixes beyond Cheer', stripCheermotes('BibleThump10 4Head10 lol', 20), 'lol');
  check('a custom channel prefix goes once the known ones fall short', stripCheermotes('phantom100 lets go', 100), 'lets go');
  check('but ordinary words with digits survive when the bits are accounted for',
    stripCheermotes('Cheer100 my mp3 player', 100), 'my mp3 player');
  check('a message that is only cheermotes is empty', stripCheermotes('Cheer1 Cheer1', 2), '');
  check('nothing in, nothing out', stripCheermotes(null, 0), '');

  const ms = await import('../../functions/api/milestones.js');
  const env = makeEnv();
  env._store.set('alert_toggles', JSON.stringify({ cheer: true }));
  await deliver(ms, env, 'notification', 'channel.cheer',
    { user_name: 'Fan', bits: 100, message: 'Cheer100 love the stream' });
  const feed = JSON.stringify([...env._store.entries()].filter(([k]) => /overlay/.test(k)).map(([, v]) => v));
  ok('the overlay alert carries the cleaned message', /love the stream/.test(feed) && !/Cheer100/.test(feed));
}

Object.assign(console, quiet);
console.log('');
if (failures.length) {
  console.log(`[eventsub-revocation] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[eventsub-revocation] ${passed} assertions passed.`);
console.log('');
