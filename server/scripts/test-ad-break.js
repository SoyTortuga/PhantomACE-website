#!/usr/bin/env node
/* ══════════════════════════════════════════════
   AD BREAKS — the webhook, the schedule, and the thing with no end event

     node server/scripts/test-ad-break.js

   THE BUG THIS EXISTS FOR, written down before it happens. Twitch sends
   channel.ad_break.begin and nothing else — there is no ad_break.end. A
   "playing" boolean therefore has nothing to clear it: the process restarts
   mid-break, the flag survives in storage, and drops stay suppressed for
   the rest of the stream with nothing in the logs to say why. So the break
   is stored as an endsAt and every reader does the arithmetic. These tests
   drive a clock rather than sleeping, which is the only way to prove state
   expires on its own.

   The other half is the countdown, which is polled rather than pushed. The
   cache holds an ABSOLUTE next_ad_at, so a stale cache still yields an
   accurate countdown; a cache holding "minutes remaining" would pass a
   naive test and drift on screen. That property is asserted directly.

   No network and no database: a fake KV and a stubbed fetch, so this runs
   anywhere and cannot be fooled by the rig's state.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  recordBreakBegin, breakRunningAt, refreshSchedule, viewOf, adsRunning,
  readAdState, SCHEDULE_TTL_MS, WARNING_LEAD_MS,
} from '../../functions/api/ads/state.js';
import { onRequestPost, onRequestGet } from '../../functions/api/ad-break.js';
import { signEventSub } from '../lib/eventsub.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

const SECRET = 'test-eventsub-secret';
const BROADCASTER = '123456';

/** A KV stand-in that behaves like the real one: get(key) yields a STRING. */
function fakeKV(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    async get(key, type) {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    async put(key, value) { store.set(key, String(value)); },
    async delete(key) { store.delete(key); },
  };
}

function fakeEnv(seed = {}) {
  return {
    MARKETPLACE: fakeKV(seed),
    TWITCH_EVENTSUB_SECRET: SECRET,
    TWITCH_BROADCASTER_ID: BROADCASTER,
    TWITCH_CLIENT_ID: 'client-id',
  };
}

/** A signed EventSub POST, built the way Twitch builds one. */
async function signedRequest(messageType, body, { secret = SECRET, timestamp = null } = {}) {
  const raw = JSON.stringify(body);
  const messageId = crypto.randomUUID();
  const ts = timestamp || new Date().toISOString();
  const sig = await signEventSub(secret, messageId, ts, raw);
  return new Request('https://phantomace.tv/api/ad-break', {
    method: 'POST',
    headers: {
      'Twitch-Eventsub-Message-Id': messageId,
      'Twitch-Eventsub-Message-Timestamp': ts,
      'Twitch-Eventsub-Message-Signature': sig,
      'Twitch-Eventsub-Message-Type': messageType,
      'Content-Type': 'application/json',
    },
    body: raw,
  });
}

const beginBody = (over = {}) => ({
  subscription: { type: 'channel.ad_break.begin', version: '1' },
  event: {
    broadcaster_user_id: BROADCASTER,
    started_at: '2026-09-19T12:00:00Z',
    duration_seconds: 90,
    is_automatic: true,
    ...over,
  },
});

const T0 = Date.parse('2026-09-19T12:00:00Z');

/* ══ A break ends by arithmetic, not by an event ═══════════════════════ */
{
  const env = fakeEnv();
  await recordBreakBegin(env, beginBody().event);
  const state = await readAdState(env);

  check('the break records when it ends', state.break.endsAt, T0 + 90_000);
  ok('it is running one second in', breakRunningAt(state, T0 + 1000));
  ok('and one second before it ends', breakRunningAt(state, T0 + 89_000));

  /* THE WHOLE POINT. Nothing was called to end it — time simply passed. */
  ok('it is over the moment endsAt passes', !breakRunningAt(state, T0 + 90_001));
  ok('and stays over an hour later', !breakRunningAt(state, T0 + 3_600_000));

  /* A RESTART CHANGES NOTHING, because the answer is computed from stored
     numbers rather than held in memory. This re-reads through a fresh env
     over the same stored bytes, which is what a reboot amounts to. */
  const rebooted = fakeEnv(Object.fromEntries(env.MARKETPLACE.store));
  ok('a restart mid-break still sees it running',
     breakRunningAt(await readAdState(rebooted), T0 + 30_000));
  ok('and still sees it finish on time',
     !breakRunningAt(await readAdState(rebooted), T0 + 91_000));
}

/* ══ A malformed duration cannot pin the break open ════════════════════ */
{
  /* An absent or absurd duration_seconds is the one input that could still
     produce an endsAt far enough out to behave like a stuck flag. */
  for (const [label, dur, expectSeconds] of [
    ['missing', undefined, 90],
    ['zero', 0, 90],
    ['negative', -1, 90],
    ['nonsense text', 'soon', 90],
    ['absurdly long', 99999, 300],
  ]) {
    const env = fakeEnv();
    await recordBreakBegin(env, beginBody({ duration_seconds: dur }).event);
    const state = await readAdState(env);
    check(`a ${label} duration is clamped`, state.break.durationSeconds, expectSeconds);
    ok(`and a ${label} duration still expires within ten minutes`,
       !breakRunningAt(state, T0 + 600_000));
  }
}

/* ══ The countdown survives a stale cache ══════════════════════════════ */
{
  /* next_ad_at is stored ABSOLUTE. Read it a minute after it was cached and
     the countdown must be a minute shorter — not the same number it was
     when written, which is what caching "seconds remaining" would give. */
  const nextAt = T0 + 300_000;                 /* five minutes out */
  const state = { break: null, schedule: { nextAdAt: nextAt, durationSeconds: 60 },
                  scheduleCheckedAt: T0 };

  check('fresh, the countdown is five minutes', viewOf(state, T0).secondsUntilNext, 300);
  check('a minute later it is four', viewOf(state, T0 + 60_000).secondsUntilNext, 240);
  check('ten seconds before, it is ten', viewOf(state, nextAt - 10_000).secondsUntilNext, 10);

  /* Past the moment, null rather than a negative: a countdown reading -12
     is a bug on screen, and the begin event supersedes it anyway. */
  check('once it passes it reads null', viewOf(state, nextAt + 5_000).secondsUntilNext, null);

  check('the warning is on inside the lead time',
        viewOf(state, nextAt - WARNING_LEAD_MS + 1000).warning, true);
  check('and off outside it',
        viewOf(state, nextAt - WARNING_LEAD_MS - 1000).warning, false);
}

/* ══ A running break suppresses the upcoming one ═══════════════════════ */
{
  const env = fakeEnv();
  await recordBreakBegin(env, beginBody().event);
  const state = await readAdState(env);

  /* The break that just started is no longer "coming". Leaving the old
     schedule would show a countdown to a moment already in the past. */
  check('starting a break clears the schedule', state.schedule, null);

  const v = viewOf(state, T0 + 10_000);
  check('the view says it is running', v.running, true);
  check('with the time left', v.secondsRemaining, 80);
  check('and no warning while it plays', v.warning, false);
}

/* ══ Broadcaster-only numbers stay out of the public view ══════════════ */
{
  const state = { break: null, scheduleCheckedAt: T0,
                  schedule: { nextAdAt: T0 + 60_000, durationSeconds: 60,
                              snoozeCount: 3, prerollFreeTime: 120 } };

  const pub = viewOf(state, T0);
  ok('snooze count is absent by default', !('snoozeCount' in pub));
  ok('as is pre-roll free time', !('prerollFreeTime' in pub));

  const full = viewOf(state, T0, { full: true });
  check('the broadcaster sees the snooze count', full.snoozeCount, 3);
  check('and the pre-roll free time', full.prerollFreeTime, 120);
}

/* ══ The webhook refuses anything it cannot verify ═════════════════════ */
{
  const env = fakeEnv();

  const wrong = await signedRequest('notification', beginBody(), { secret: 'not-the-secret' });
  const r1 = await onRequestPost({ env, request: wrong });
  check('a bad signature is rejected', r1.status, 403);
  check('and records nothing', (await readAdState(env)).break, null);

  const stale = await signedRequest('notification', beginBody(),
    { timestamp: new Date(Date.now() - 30 * 60_000).toISOString() });
  const r2 = await onRequestPost({ env, request: stale });
  check('a replayed message is rejected', r2.status, 403);
  check('and still records nothing', (await readAdState(env)).break, null);

  /* Fails CLOSED when unconfigured — never "skip verification". */
  const noSecret = { ...fakeEnv(), TWITCH_EVENTSUB_SECRET: '' };
  const r3 = await onRequestPost({ env: noSecret, request: await signedRequest('notification', beginBody()) });
  check('a missing secret is a 500, not a pass', r3.status, 500);
}

/* ══ The handshake and the real thing ══════════════════════════════════ */
{
  const env = fakeEnv();

  const challenge = await signedRequest('webhook_callback_verification',
    { challenge: 'pingback-12345', subscription: { type: 'channel.ad_break.begin' } });
  const r1 = await onRequestPost({ env, request: challenge });
  check('the verification challenge is echoed', await r1.text(), 'pingback-12345');
  check('as plain text', r1.headers.get('Content-Type'), 'text/plain');
  check('and the handshake stores no break', (await readAdState(env)).break, null);

  const note = await signedRequest('notification', beginBody());
  const r2 = await onRequestPost({ env, request: note });
  check('a signed notification is accepted', r2.status, 200);
  check('and the break is recorded', (await readAdState(env)).break.endsAt, T0 + 90_000);

  /* Revocation must not look like success to a human reading logs. */
  const rev = await signedRequest('revocation',
    { subscription: { type: 'channel.ad_break.begin', status: 'authorization_revoked' } });
  check('a revocation is acknowledged', (await onRequestPost({ env, request: rev })).status, 200);
}

/* ══ The schedule poll is rate limited and fails soft ══════════════════ */
{
  const realFetch = globalThis.fetch;
  let calls = 0;

  const env = fakeEnv({
    twitch_broadcaster_token: JSON.stringify({ access_token: 'tok', expiresAt: Date.now() + 3_600_000 }),
    twitch_live_cache: JSON.stringify({ live: true, checkedAt: Date.now() }),
  });

  globalThis.fetch = async (url) => {
    if (String(url).includes('/helix/streams')) {
      return new Response(JSON.stringify({ data: [{ id: '1', started_at: '2026-09-19T11:00:00Z' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    calls++;
    return new Response(JSON.stringify({ data: [{
      next_ad_at: '2026-09-19T12:05:00Z', duration: 60,
      snooze_count: 2, preroll_free_time: 0,
    }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const s1 = await refreshSchedule(env, T0);
    check('the schedule is fetched', calls, 1);
    check('and next_ad_at is stored absolute', s1.schedule?.nextAdAt, T0 + 300_000);

    await refreshSchedule(env, T0 + SCHEDULE_TTL_MS - 1000);
    check('a second read inside the TTL does not call Twitch', calls, 1);

    await refreshSchedule(env, T0 + SCHEDULE_TTL_MS + 1000);
    check('a read past the TTL does', calls, 2);

    /* A FAILED CALL MUST NOT STAMP THE CLOCK. Otherwise one 500 from Twitch
       buys a full TTL of silence, and the countdown that never appears is
       indistinguishable from no ads being scheduled. */
    const before = await readAdState(env);
    globalThis.fetch = async (url) => String(url).includes('/helix/streams')
      ? new Response(JSON.stringify({ data: [{ id: '1' }] }), { status: 200 })
      : new Response('nope', { status: 500 });

    const after = await refreshSchedule(env, T0 + 10 * SCHEDULE_TTL_MS);
    check('a failed fetch keeps the previous schedule',
          after.schedule?.nextAdAt, before.schedule?.nextAdAt);
    check('and does not advance the checked-at clock',
          after.scheduleCheckedAt, before.scheduleCheckedAt);
  } finally {
    globalThis.fetch = realFetch;
  }
}

/* ══ The drop guard asks a question that costs nothing ═════════════════ */
{
  /* A drop must not wait on a network round trip, and by the time a break
     is running the begin event has already been pushed — so this reads
     stored state only. Proven by stubbing fetch to explode. */
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('the drop guard must not call out'); };

  try {
    const env = fakeEnv();
    check('no break means drops are fine', await adsRunning(env, T0), false);

    await recordBreakBegin(env, beginBody().event);
    check('a running break suppresses', await adsRunning(env, T0 + 30_000), true);
    check('and stops suppressing on its own', await adsRunning(env, T0 + 120_000), false);
  } finally {
    globalThis.fetch = realFetch;
  }
}

/* ══ The GET never leaks the private numbers to an unauthenticated caller ═ */
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [] }), { status: 200 });

  try {
    const env = fakeEnv({
      ad_state: JSON.stringify({
        break: null, scheduleCheckedAt: Date.now(),
        schedule: { nextAdAt: Date.now() + 60_000, durationSeconds: 60,
                    snoozeCount: 4, prerollFreeTime: 90 },
      }),
    });

    const anon = await onRequestGet({ env,
      request: new Request('https://phantomace.tv/api/ad-break') });
    const body = await anon.json();
    ok('an anonymous read gets no snooze count', !('snoozeCount' in body));
    check('and is never cached', anon.headers.get('Cache-Control'), 'no-store');

    /* A viewer session is not the broadcaster. */
    const viewer = await onRequestGet({ env, request: new Request('https://phantomace.tv/api/ad-break', {
      headers: { Cookie: 'pham_session=' + encodeURIComponent(JSON.stringify({ user_id: '999' })) } }) });
    ok('nor does a logged-in viewer', !('snoozeCount' in await viewer.json()));

    const owner = await onRequestGet({ env, request: new Request('https://phantomace.tv/api/ad-break', {
      headers: { Cookie: 'pham_session=' + encodeURIComponent(JSON.stringify({ user_id: BROADCASTER })) } }) });
    check('the broadcaster does', (await owner.json()).snoozeCount, 4);
  } finally {
    globalThis.fetch = realFetch;
  }
}

/* ══ The wiring nobody notices until it is missing ═════════════════════ */
{
  const { resolveKey } = await import('../lib/registry.js');
  check('ad_state maps to a table', resolveKey('ad_state'), { table: 'singletons', expiry: 'none' });

  /* 'real' expiry here would un-suppress drops mid-break by deleting the
     row, which is the failure this design is built to avoid. */
  check('and never expires on a timer', resolveKey('ad_state').expiry, 'none');

  const setup = fs.readFileSync(path.join(REPO, 'functions/api/admin/bot-setup.js'), 'utf8');
  ok('bot-setup requests the ads scope', /channel:read:ads/.test(setup));
  ok('in the consent URL, not only in a check',
     /const broadcasterScopes = [\s\S]{0,200}channel:read:ads/.test(setup));
  ok('and creates the subscription', /type: 'channel\.ad_break\.begin'/.test(setup));
  ok('pointed at this route', /callback: `\$\{origin\}\/api\/ad-break`/.test(setup));

  /* CONDITIONAL, deliberately. Folding it into the hard scope gate would
     refuse to create ANY subscription for a broadcaster who has not
     re-consented — breaking a working setup to add an optional feature. */
  ok('the subscription is conditional on the scope',
     /if \(granted\.includes\('channel:read:ads'\)\) \{/.test(setup));

  /* Anchored to the consent string, not the file. The header above explains
     at length why channel:manage:ads is withheld, and scanning the whole
     source flags that prose as the thing it is ruling out. */
  const consent = /const broadcasterScopes = ([\s\S]*?);\n/.exec(setup)?.[1] || '';
  ok('the consent URL asks for read:ads', /channel:read:ads/.test(consent));
  ok('and does not ask to manage ads', !/channel:manage:ads/.test(consent));

  const router = fs.readFileSync(path.join(REPO, 'server/router.js'), 'utf8');
  ok('the state library is not published as a route', /'api\/ads\/state\.js'/.test(router));
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[ad-break] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[ad-break] ${passed} assertions passed.`);
console.log('');
