#!/usr/bin/env node
/* ══════════════════════════════════════════════
   PHAMSHOCK WIND NIGHT — chat steers the wind — test suite

     node server/scripts/test-pham-wind.js

   The mode is server-authoritative: a mod starts it, chat nudges the wind with
   `!wind left` / `!wind right`, and every PhamShock room flies its shells with
   that wind while the session is live. The things that would be embarrassing
   live and are asserted here:

     - start is behind the broadcaster/moderator gate, never public;
     - a `!wind` nudge moves the server wind, is CLAMPED to range, and is
       RATE-LIMITED per chatter (one per cooldown);
     - the record stays a value + counters + a capped rate-limit map — bounded,
       no per-message log;
     - PhamShock reads the session wind ONLY while a session is live, and falls
       back to its own per-round wind otherwise;
     - the session self-clears when idle, and an explicit End ends it now.

   No database, no browser: a fake MARKETPLACE holds keys in a Map, shared by
   both pham-wind-night.js and pham-shock.js so the cross-module read is real.
   ══════════════════════════════════════════════ */

import {
  WIND_NIGHT_KEY, WIND_MAX, WIND_STEP, NUDGE_COOLDOWN_MS, IDLE_MS,
  parseWindDir, publicWind, windFromChat, getActiveWind,
  onRequestGet, onRequestPost,
} from '../../functions/api/pham-wind-night.js';
import {
  onRequestGet as shockGet, onRequestPost as shockPost,
} from '../../functions/api/pham-shock.js';

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

/* ── A KV stand-in ───────────────────────────────────────────────────────
   mutate() ignores the expirationTtl options object the handlers pass — the
   TTL is a storage policy, not behaviour the logic depends on (self-clear here
   is timestamp-driven, so it is testable without a TTL clock). Values round-trip
   through JSON so object-identity bugs surface here. */
function makeEnv(seed = {}) {
  const store = new Map();
  for (const [k, v] of Object.entries(seed)) store.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  return {
    TWITCH_BROADCASTER_ID: '900',
    MARKETPLACE: {
      async get(key, type) {
        if (!store.has(key)) return null;
        const raw = store.get(key);
        return type === 'json' ? JSON.parse(raw) : raw;
      },
      async put(key, value) { store.set(key, typeof value === 'string' ? value : JSON.stringify(value)); },
      async delete(key) { store.delete(key); },
      async mutate(key, fn) {
        const current = store.has(key) ? JSON.parse(store.get(key)) : null;
        const next = await fn(current);
        if (next === undefined) return current;
        store.set(key, JSON.stringify(next));
        return JSON.parse(store.get(key));
      },
      async listValues({ prefix }) {
        const out = [];
        for (const [name, raw] of store) if (name.startsWith(prefix)) out.push({ name, value: JSON.parse(raw) });
        return out;
      },
    },
    _store: store,
  };
}

const sessionOf = (env) => {
  const raw = env._store.get(WIND_NIGHT_KEY);
  return raw ? JSON.parse(raw) : null;
};

const cookie = (userId, name) =>
  `pham_session=${encodeURIComponent(JSON.stringify({ user_id: userId, display_name: name || ('u' + userId) }))}`;

/* pham-wind-night control POST. userId null => anonymous (no cookie). */
function windPost(env, body, userId, name) {
  const headers = { 'Content-Type': 'application/json' };
  if (userId != null) headers.Cookie = cookie(userId, name);
  return onRequestPost({
    env,
    request: new Request('https://phantomace.tv/api/pham-wind-night', {
      method: 'POST', headers, body: JSON.stringify(body),
    }),
  });
}

function windGet(env, key) {
  return onRequestGet({
    env,
    request: new Request('https://phantomace.tv/api/pham-wind-night?key=' + encodeURIComponent(key)),
  });
}

/* ══ parseWindDir — the command scheme ═════════════════════════════════════ */
{
  check('"left" steers left', parseWindDir('left'), -1);
  check('"right" steers right', parseWindDir('right'), 1);
  check('shorthand l / r', [parseWindDir('l'), parseWindDir('r')], [-1, 1]);
  check('shorthand < / >', [parseWindDir('<'), parseWindDir('>')], [-1, 1]);
  check('case does not matter', parseWindDir('RIGHT'), 1);
  check('extra words after the direction are ignored', parseWindDir('left please'), -1);
  check('an empty / unknown arg is not a steer', [parseWindDir(''), parseWindDir('sideways')], [0, 0]);
}

/* ══ start is broadcaster / moderator only ═════════════════════════════════ */
{
  const env = makeEnv({ site_moderators: { entries: [{ userId: '500' }] } });

  const anon = await windPost(env, { action: 'start' }, null);
  check('an anonymous start is refused', anon.status, 403);
  check('and nothing is live', await getActiveWind(env), null);

  const rando = await windPost(env, { action: 'start' }, '123');
  check('a non-mod start is refused', rando.status, 403);

  const broadcaster = await windPost(env, { action: 'start' }, '900', 'Pham');
  check('the broadcaster can start', broadcaster.status, 200);
  check('and the session is live at wind 0', await getActiveWind(env), 0);

  const mod = await windPost(env, { action: 'start' }, '500', 'Mod');
  check('a listed moderator can start too', mod.status, 200);
}

/* ══ a nudge moves the wind, clamped, rate-limited per chatter ═════════════ */
{
  const env = makeEnv();
  await windPost(env, { action: 'start' }, '900');

  const r1 = await windFromChat(env, { userId: 'c1', name: 'C1', arg: 'right' });
  ok('a nudge from a chatter lands', r1.ok);
  check('and moves the wind one step right', await getActiveWind(env), WIND_STEP);

  await windFromChat(env, { userId: 'c2', arg: 'right' });
  await windFromChat(env, { userId: 'c3', arg: 'right' });
  check('more distinct chatters move it further', await getActiveWind(env), 3 * WIND_STEP);

  const back = await windFromChat(env, { userId: 'c4', arg: 'left' });
  ok('a left nudge lands', back.ok);
  check('and steers it back one step', await getActiveWind(env), 2 * WIND_STEP);

  check('each distinct chatter is counted once', sessionOf(env).chatters, 4);
  check('the nudge counter tallies every applied nudge', sessionOf(env).nudges, 4);

  /* A bad arg from a live session is a no-op, not a crash. */
  const bad = await windFromChat(env, { userId: 'c5', arg: 'sideways' });
  check('an unparseable direction does nothing', [bad.ok, sessionOf(env).nudges], [false, 4]);
}

/* clamp: many right nudges cannot push past WIND_MAX. */
{
  const env = makeEnv();
  await windPost(env, { action: 'start' }, '900');
  for (let i = 0; i < WIND_MAX + 6; i++) {
    await windFromChat(env, { userId: 'pusher' + i, arg: 'right' });
  }
  check('the wind clamps at WIND_MAX, however many push', await getActiveWind(env), WIND_MAX);

  for (let i = 0; i < 2 * WIND_MAX + 10; i++) {
    await windFromChat(env, { userId: 'puller' + i, arg: 'left' });
  }
  check('and clamps at -WIND_MAX the other way', await getActiveWind(env), -WIND_MAX);
}

/* rate limit: a second nudge from the same chatter inside the cooldown is a
   quiet no-op (the two awaits are milliseconds apart, well under the cooldown). */
{
  const env = makeEnv();
  await windPost(env, { action: 'start' }, '900');
  await windFromChat(env, { userId: 'spammer', arg: 'right' });
  const second = await windFromChat(env, { userId: 'spammer', arg: 'right' });
  check('a repeat nudge inside the cooldown is refused', second.ok, false);
  check('and the wind moved only once', await getActiveWind(env), WIND_STEP);
  check('the spammer counts as one chatter, one nudge',
    [sessionOf(env).chatters, sessionOf(env).nudges], [1, 1]);
  ok('the cooldown window is real (non-zero)', NUDGE_COOLDOWN_MS > 0);

  /* Once the cooldown has passed (simulated by ageing their last nudge), the
     same chatter may steer again — and is not double-counted as a new chatter. */
  const s = sessionOf(env);
  s.seen.spammer = Date.now() - NUDGE_COOLDOWN_MS - 1;
  env._store.set(WIND_NIGHT_KEY, JSON.stringify(s));
  const again = await windFromChat(env, { userId: 'spammer', arg: 'right' });
  check('after the cooldown the same chatter may nudge again', again.ok, true);
  check('still one distinct chatter', sessionOf(env).chatters, 1);
}

/* ══ bounded: a value + counters + a rate-limit map, never a per-message log ═ */
{
  const env = makeEnv();
  await windPost(env, { action: 'start' }, '900');
  /* A handful of chatters, each nudging many times (cooldown-aged between). */
  for (let round = 0; round < 50; round++) {
    for (const uid of ['x', 'y', 'z']) {
      const s = sessionOf(env);
      if (s.seen[uid] != null) { s.seen[uid] = Date.now() - NUDGE_COOLDOWN_MS - 1; env._store.set(WIND_NIGHT_KEY, JSON.stringify(s)); }
      await windFromChat(env, { userId: uid, arg: round % 2 ? 'left' : 'right' });
    }
  }
  const s = sessionOf(env);
  check('the rate-limit map holds one entry per distinct chatter, not per message',
    Object.keys(s.seen).length, 3);
  check('and the distinct-chatter count matches', s.chatters, 3);
  ok('the session has no per-message log array of any kind',
    Object.values(s).every(v => !Array.isArray(v)));
  ok('the wind is a single bounded number', typeof s.wind === 'number' && Math.abs(s.wind) <= WIND_MAX);
}

/* ══ PhamShock reads the session wind only while live, else falls back ══════ */
async function startedShockRoom(env) {
  const post = (userId, body) => shockPost({
    env,
    request: new Request('https://phantomace.tv/api/pham-shock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie(userId) },
      body: JSON.stringify(body),
    }),
  });
  const made = await (await post('900', { action: 'create-room' })).json();
  const code = made.code;
  await post('800', { action: 'join-room', code });
  await post('900', { action: 'set-ready', code, ready: true });
  await post('800', { action: 'set-ready', code, ready: true });
  await post('900', { action: 'start-game', code });
  return { code, post };
}

function shockState(env, code) {
  return shockGet({
    env,
    request: new Request('https://phantomace.tv/api/pham-shock?action=get-state&code=' + code),
  }).then(r => r.json());
}
const shockRoom = (env, code) => JSON.parse(env._store.get('ps_room_' + code));

{
  const env = makeEnv();
  const { code } = await startedShockRoom(env);

  /* No session: PhamShock sees no override and the view carries no flag. */
  check('with no Wind Night, getActiveWind is null', await getActiveWind(env), null);
  const normalView = await shockState(env, code);
  ok('and the game state is not flagged as Wind Night', !normalView.windNight);

  /* Start a session and drive the wind to a known value. */
  await windPost(env, { action: 'start' }, '900');
  for (const uid of ['a', 'b', 'c', 'd']) await windFromChat(env, { userId: uid, arg: 'right' });
  check('the session wind is at +4', await getActiveWind(env), 4);

  /* The game state now reports the chat wind and the flag, even mid-aim. */
  const liveView = await shockState(env, code);
  check('PhamShock shows the chat wind while aiming', liveView.wind, 4);
  ok('and flags the room as Wind Night', liveView.windNight);

  /* Force a resolution: both players have submitted and the aim clock expired.
     resolve() must fly the shells with the session wind, and persist it. */
  const r = shockRoom(env, code);
  for (const id of Object.keys(r.players)) {
    r.players[id].submitted = true;
    r.players[id].submission = { angle: 45, power: 50, weapon: 0 };
  }
  r.roundStartedAt = Date.now() - 31000;
  env._store.set('ps_room_' + code, JSON.stringify(r));

  await shockState(env, code);
  const resolved = shockRoom(env, code);
  ok('the round resolved', Array.isArray(resolved.roundResults));
  check('and the room flew its shells with the chat wind', resolved.wind, 4);

  /* End the session: PhamShock falls back to its own wind immediately. */
  await windPost(env, { action: 'end' }, '900');
  check('ending the session clears the override', await getActiveWind(env), null);
  const afterView = await shockState(env, code);
  ok('and the game is no longer flagged Wind Night', !afterView.windNight);
}

/* ══ self-clear when idle, and an explicit End ═════════════════════════════ */
{
  const env = makeEnv();
  await windPost(env, { action: 'start' }, '900');
  await windFromChat(env, { userId: 'q', arg: 'right' });
  ok('a fresh session is live', (await getActiveWind(env)) != null);

  /* Age the last activity past the idle window. */
  const s = sessionOf(env);
  s.lastActiveAt = Date.now() - IDLE_MS - 1;
  env._store.set(WIND_NIGHT_KEY, JSON.stringify(s));

  check('an idle session reads as not live', await getActiveWind(env), null);
  check('and publicWind reports none', publicWind(sessionOf(env)).status, 'none');
  const idleNudge = await windFromChat(env, { userId: 'late', arg: 'right' });
  check('a nudge cannot revive an idle session', idleNudge.ok, false);
}

/* the overlay GET retires an idle session and reports none. */
{
  const env = makeEnv({ overlay_key: 'testkey' });
  await windPost(env, { action: 'start' }, '900');
  await windFromChat(env, { userId: 'q', arg: 'left' });

  const liveRes = await windGet(env, 'testkey');
  const live = await liveRes.json();
  check('a live session renders on the overlay', live.status, 'active');
  check('with its direction', live.dir, 'left');

  const bad = await windGet(env, 'wrongkey');
  check('a wrong overlay key is refused', bad.status, 403);

  /* Age it and poll: the overlay read flips it to ended. */
  const s = sessionOf(env);
  s.lastActiveAt = Date.now() - IDLE_MS - 1;
  env._store.set(WIND_NIGHT_KEY, JSON.stringify(s));
  const goneRes = await windGet(env, 'testkey');
  const gone = await goneRes.json();
  check('an idle overlay poll reports nothing on', gone.status, 'none');
  check('and the session is flipped to ended', sessionOf(env).status, 'ended');
}

/* ── Report ──────────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[pham-wind] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[pham-wind] ${passed} assertions passed.`);
console.log('');
