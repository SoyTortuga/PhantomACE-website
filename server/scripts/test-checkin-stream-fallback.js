#!/usr/bin/env node
/* ══════════════════════════════════════════════
   CHECK-INS WHEN TWITCH WON'T SAY WHICH STREAM — test suite

     node server/scripts/test-checkin-stream-fallback.js

   A failed or lagging stream lookup used to hand channel-points.js a null
   stream id, which was read as "a new broadcast": the check-in list was
   replaced (everyone after became an early bird again), the history got an
   id-less entry that skipped the duplicate check and reset the streak to 1,
   and that null then broke the NEXT stream's previous-stream test too.

   Pinned here:
     stream-info falls back to the last stream it saw live, not to null
     an unknown stream id holds a check-in as pending — never a new stream
     pending check-ins settle with the right position, streak and stream
     a check-in that beats the minute tick still extends a streak
     id-less history from before the fix still counts toward a streak
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

/* Twitch, as the test wants it right now. */
let twitch = { mode: 'live', stream: null };
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('id.twitch.tv/oauth2/token')) {
    return new Response(JSON.stringify({ access_token: 'app', expires_in: 3600 }), { status: 200 });
  }
  if (u.includes('/helix/streams')) {
    if (twitch.mode === 'down') return new Response('{}', { status: 503 });
    if (twitch.mode === 'throw') throw new Error('network');
    const data = twitch.mode === 'live' && twitch.stream
      ? [{ id: twitch.stream.id, started_at: twitch.stream.startedAt, viewer_count: 12 }] : [];
    return new Response(JSON.stringify({ data }), { status: 200 });
  }
  return new Response(JSON.stringify({ data: [{ is_sent: true }] }), { status: 200 });
};

function makeEnv() {
  const store = new Map();
  const chains = new Map();
  return {
    TWITCH_EVENTSUB_SECRET: SECRET,
    TWITCH_CLIENT_ID: 'client',
    TWITCH_CLIENT_SECRET: 'secret',
    TWITCH_BROADCASTER_ID: '1',
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
    },
    _store: store,
  };
}

const read = (env, k) => JSON.parse(env._store.get(k) || 'null');
/* The 30-second cache would otherwise answer from the last lookup. */
const expireCache = (env) => {
  const c = read(env, 'twitch_live_cache');
  if (c) { c.checkedAt = 0; env._store.set('twitch_live_cache', JSON.stringify(c)); }
};

let seq = 0;
async function checkIn(env, userId) {
  expireCache(env);
  const mod = await import('../../functions/api/channel-points.js');
  const raw = JSON.stringify({
    subscription: { type: 'channel.channel_points_custom_reward_redemption.add' },
    event: { id: 'r' + (++seq), user_id: String(userId), user_name: 'v' + userId, reward: { id: 'rw', title: 'Pham Check-In' } },
  });
  const id = 'ci-' + seq + '-' + Math.random();
  const ts = new Date().toISOString();
  const request = new Request('https://phantomace.tv/api/channel-points', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'twitch-eventsub-message-type': 'notification',
      'twitch-eventsub-message-id': id,
      'twitch-eventsub-message-timestamp': ts,
      'twitch-eventsub-message-signature': await signEventSub(SECRET, id, ts, raw),
    },
    body: raw,
  });
  return mod.onRequestPost({ env, request });
}

const quiet = { error: console.error, warn: console.warn, log: console.log };
console.error = console.warn = () => {};

const { getStreamInfo } = await import('../../functions/api/stream-info.js');
const { recordStream, recordCheckin, getCheckinStats } = await import('../../functions/api/checkin-rewards.js');
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

/* ── stream-info: the fallback ───────────────────────────────────────── */
{
  const env = makeEnv();
  twitch = { mode: 'live', stream: { id: 'S1', startedAt: iso(3600000) } };
  const live = await getStreamInfo(env);
  check('a live lookup names the stream', live.streamId, 'S1');
  ok('and remembers the sighting', read(env, 'twitch_live_cache').lastLive.streamId === 'S1');

  twitch.mode = 'down';
  expireCache(env);
  const blip = await getStreamInfo(env);
  check('a failed lookup still names the stream just seen', blip.streamId, 'S1');
  check('marked stale', blip.stale, true);
  check('but does not claim the channel is live', blip.live, false);

  twitch.mode = 'throw';
  expireCache(env);
  check('a thrown lookup does the same', (await getStreamInfo(env)).streamId, 'S1');

  /* An hour later, a failure must not name yesterday's stream. */
  const c = read(env, 'twitch_live_cache');
  c.lastLive.seenAt = Date.now() - 3600000;
  c.checkedAt = 0;
  env._store.set('twitch_live_cache', JSON.stringify(c));
  check('a sighting long past is not reused', (await getStreamInfo(env)).streamId, null);

  /* Offline answers carry the sighting forward rather than erasing it. */
  twitch = { mode: 'offline', stream: null };
  expireCache(env);
  const off = await getStreamInfo(env);
  check('a successful offline answer is offline', off.streamId, null);
  ok('and keeps the last sighting', read(env, 'twitch_live_cache').lastLive.streamId === 'S1');
}
{
  /* No sighting on record at all: the newest logged broadcast, if recent. */
  const env = makeEnv();
  await recordStream(env, 'S9', iso(2 * 3600000));
  twitch = { mode: 'down', stream: null };
  check('with no sighting, a recent logged stream is used', (await getStreamInfo(env)).streamId, 'S9');

  const env2 = makeEnv();
  await recordStream(env2, 'S8', iso(48 * 3600000));
  check('but not one from days ago', (await getStreamInfo(env2)).streamId, null);

  const env3 = makeEnv();
  env3.MARKETPLACE.get = async () => { throw new Error('db down'); };
  const r = await getStreamInfo(env3);
  check('a database failure never throws out of getStreamInfo', r.live, false);
}

/* ── Pending check-ins ───────────────────────────────────────────────── */
{
  const env = makeEnv();

  /* Last stream: alice and bob attend. */
  twitch = { mode: 'live', stream: { id: 'A', startedAt: iso(26 * 3600000) } };
  await recordStream(env, 'A', iso(26 * 3600000));
  await checkIn(env, 'alice');
  await checkIn(env, 'bob');
  check('last stream: two checked in', read(env, 'checkin_current').checkins.length, 2);

  /* New stream B starts. Twitch says offline for its first minute. */
  const startB = iso(30000);
  twitch = { mode: 'offline', stream: null };
  const r1 = await checkIn(env, 'alice');
  check('an unconfirmed check-in is accepted', r1.status, 200);
  const cur1 = read(env, 'checkin_current');
  check('it is held as pending', cur1.pending.map(p => p.userId), ['alice']);
  check('the list is NOT replaced by a null stream', cur1.streamId, 'A');
  check('and nothing is written to history yet', read(env, 'ci_alice').streams.length, 1);

  const r2 = await checkIn(env, 'alice');
  check('a redelivery while pending is not a second check-in', read(env, 'checkin_current').pending.length, 1);
  check('and still answers 200', r2.status, 200);

  await checkIn(env, 'carol');
  check('a second pending check-in queues behind it', read(env, 'checkin_current').pending.map(p => p.userId), ['alice', 'carol']);

  /* Twitch confirms B. The next check-in settles the queue first. */
  twitch = { mode: 'live', stream: { id: 'B', startedAt: startB } };
  await checkIn(env, 'bob');
  const cur2 = read(env, 'checkin_current');
  check('the list is now stream B', cur2.streamId, 'B');
  check('pending check-ins keep their place ahead of later ones', cur2.checkins.map(c => c.userId), ['alice', 'carol', 'bob']);
  check('and the queue is empty', cur2.pending, []);

  const alice = await getCheckinStats(env, 'alice');
  check('alice attended A and B: a streak of 2, not a reset to 1', alice.streak, 2);
  const aliceHist = read(env, 'ci_alice');
  check('and her B attendance carries B\'s id', aliceHist.streams.map(s => s.streamId), ['A', 'B']);
  check('with her real arrival position', aliceHist.streams[1].position, 1);
  check('bob also keeps his streak', (await getCheckinStats(env, 'bob')).streak, 2);
  check('carol, new, starts at 1', (await getCheckinStats(env, 'carol')).streak, 1);
}

/* ── The minute tick settles a queue nobody else touches ─────────────── */
{
  const env = makeEnv();
  twitch = { mode: 'offline', stream: null };
  await checkIn(env, 'dave');
  check('pending with no stream at all', read(env, 'checkin_current').pending.length, 1);
  await recordStream(env, 'C', iso(60000));
  const cur = read(env, 'checkin_current');
  check('the tick logging the stream settles it', cur.checkins.map(c => c.userId), ['dave']);
  check('against that stream', cur.streamId, 'C');
  check('and dave has history for it', read(env, 'ci_dave').streams.map(s => s.streamId), ['C']);
}

/* ── A pending check-in from before the stream began is the old one's ─ */
{
  const env = makeEnv();
  await recordStream(env, 'D', iso(5 * 3600000));
  twitch = { mode: 'live', stream: { id: 'D', startedAt: iso(5 * 3600000) } };
  await checkIn(env, 'erin');
  /* The tail of D: a lookup failure long enough to outlive the sighting. */
  twitch = { mode: 'offline', stream: null };
  await checkIn(env, 'frank');
  const cur = read(env, 'checkin_current');
  cur.pending[0].at = Date.now() - 3 * 3600000;
  env._store.set('checkin_current', JSON.stringify(cur));

  await recordStream(env, 'E', iso(60000));
  check('it is not counted as the new stream\'s early bird', read(env, 'checkin_current').checkins, []);
  check('it is credited to the stream it happened in', read(env, 'ci_frank').streams.map(s => s.streamId), ['D']);
  check('without an early-bird position', read(env, 'ci_frank').streams[0].position, null);
}

/* ── recordCheckin itself ────────────────────────────────────────────── */
{
  const env = makeEnv();
  const r = await recordCheckin(env, { userId: 'gail', username: 'gail', streamId: null, startedAt: null, position: 1 });
  check('a null stream id records nothing', env._store.has('ci_gail'), false);
  check('and pays nothing', r.awards, []);
  check('and says it was deferred', r.deferred, true);

  /* The first check-in of a stream can beat the minute tick to the log. */
  await recordStream(env, 'F1', iso(48 * 3600000));
  await recordCheckin(env, { userId: 'hal', username: 'hal', streamId: 'F1', startedAt: iso(48 * 3600000), position: 3 });
  const res = await recordCheckin(env, { userId: 'hal', username: 'hal', streamId: 'F2', startedAt: iso(20000), position: 1 });
  check('a check-in before the tick logs the stream still extends the streak', res.streak, 2);
  ok('and logs the stream itself', read(env, 'stream_log').streams.some(s => s.id === 'F2'));

  /* History written before the fix, with no stream id. */
  const env2 = makeEnv();
  const gStart = Date.now() - 30 * 3600000;
  await recordStream(env2, 'G1', new Date(gStart).toISOString());
  await recordStream(env2, 'G2', iso(60000));
  env2._store.set('ci_ivy', JSON.stringify({
    userId: 'ivy', username: 'ivy', streak: 4, bestStreak: 4, total: 4, paidStreak: 3,
    streams: [{ streamId: null, startedAt: null, at: gStart + 120000, position: 1 }],
  }));
  const ivy = await recordCheckin(env2, { userId: 'ivy', username: 'ivy', streamId: 'G2', startedAt: iso(60000), position: 2 });
  check('an id-less entry inside the previous stream still counts', ivy.streak, 5);
}

Object.assign(console, quiet);
console.log('');
if (failures.length) {
  console.log(`[checkin-stream-fallback] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[checkin-stream-fallback] ${passed} assertions passed.`);
console.log('');
