#!/usr/bin/env node
/* ══════════════════════════════════════════════
   IS HE LIVE? — the most-called route on the site

     node server/scripts/test-twitch-status.js

   The shared header asks /api/twitch-status on every page load and every 60
   seconds after, for every visitor. It used to make its own Twitch Helix
   call each time, bypassing the 30-second cache in stream-info.js that
   exists for exactly this ("without it, N viewers means N calls a minute to
   Twitch"). An app token has a finite points budget, and when a busy stream
   exhausted it this route answered {"live": false} with HTTP 200 -- the
   header's dot going dark in the middle of a broadcast, silently.

   What is pinned:

     - a second request inside the cache window makes NO further Helix call.
       That is the entire point, and it is invisible if it breaks.
     - `error` on a FAILED lookup, absent when the channel is simply
       offline. js/notifications.js announces a change only when `error` is
       absent, so getting this backwards means either "PhantomACE has gone
       offline" on every Twitch blip, or never announcing a real one. The
       first of those is a bug this site has already shipped once.
     - the fields the two consumers actually read: js/twitch.js wants
       game/viewers, dino-park wants started_at.
   ══════════════════════════════════════════════ */

import { onRequestGet } from '../../functions/api/twitch-status.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

const LIVE_STREAM = {
  id: '48291', title: 'Cracking a box of Foundations',
  game_name: 'Magic: The Gathering', game_id: '1465',
  viewer_count: 412, started_at: '2026-10-10T18:00:00Z',
  thumbnail_url: 'https://static-cdn.twitch.tv/x-{width}x{height}.jpg',
};

/* Counts Helix calls, which is what this is really about. */
function makeEnv({ streams = [], helixStatus = 200 } = {}) {
  const store = new Map();
  const calls = { streams: 0, token: 0 };
  const env = {
    TWITCH_CLIENT_ID: 'cid',
    TWITCH_CLIENT_SECRET: 'secret',
    MARKETPLACE: {
      async get(k, t) { if (!store.has(k)) return null; const r = store.get(k); return t === 'json' ? JSON.parse(r) : r; },
      async put(k, v) { store.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
      async delete(k) { store.delete(k); },
      async mutate(k, fn) {
        const cur = store.has(k) ? JSON.parse(store.get(k)) : null;
        const next = await fn(cur);
        if (next === undefined) return cur;
        store.set(k, JSON.stringify(next));
        return next;
      },
      async listValues() { return []; },
    },
    _store: store,
    _calls: calls,
  };
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('oauth2/token')) {
      calls.token++;
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 5000000 }), { status: 200 });
    }
    if (u.includes('helix/streams')) {
      calls.streams++;
      if (helixStatus !== 200) return new Response('{}', { status: helixStatus });
      return new Response(JSON.stringify({ data: streams }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  };
  return env;
}

const hit = async (env) => {
  const res = await onRequestGet({ env, request: new Request('https://phantomace.tv/api/twitch-status') });
  return { status: res.status, cc: res.headers.get('Cache-Control'), data: await res.json() };
};

/* ── Live, and the fields the consumers read ─────────────────────────── */
{
  const env = makeEnv({ streams: [LIVE_STREAM] });
  const r = await hit(env);
  check('a live channel answers 200', r.status, 200);
  check('and says so', r.data.live, true);
  /* js/twitch.js renders these two in the hero. */
  check('with the category js/twitch.js shows', r.data.game, 'Magic: The Gathering');
  check('and the viewer count', r.data.viewers, 412);
  /* dino-park starts its park day from this. */
  check('and the start time dino-park reads', r.data.started_at, '2026-10-10T18:00:00Z');
  check('plus the title', r.data.title, 'Cracking a box of Foundations');
  ok('and a thumbnail', !!r.data.thumbnail);
  ok('no error field, so a going-live change is announced', !('error' in r.data));

  /* The whole point. */
  check('one Helix call so far', env._calls.streams, 1);
  const again = await hit(env);
  check('a second request inside the cache window adds none', env._calls.streams, 1);
  check('and still reports live', again.data.live, true);
  const third = await hit(env);
  check('nor does a third', env._calls.streams, 1);
  check('all three agree', third.data.viewers, 412);
}

/* ── Genuinely offline: no error, so the change IS announced ─────────── */
{
  const env = makeEnv({ streams: [] });
  const r = await hit(env);
  check('an offline channel answers 200', r.status, 200);
  check('and reports not live', r.data.live, false);
  ok('with NO error, so "gone offline" is announced', !('error' in r.data));
  check('having made one Helix call', env._calls.streams, 1);

  const again = await hit(env);
  check('and none on the next request', env._calls.streams, 1);
  check('still offline', again.data.live, false);
}

/* ── A FAILED lookup is not an offline channel ───────────────────────── */
{
  /* This is the one that has already shipped as a bug: a Twitch blip read
     as the stream ending, then starting again when it recovered, so a single
     broadcast produced pairs of offline/LIVE announcements. */
  const env = makeEnv({ helixStatus: 503 });
  const r = await hit(env);
  check('a failed lookup still answers 200', r.status, 200);
  check('and falls back to not live', r.data.live, false);
  ok('but CARRIES an error, which is what keeps the announcer quiet',
    typeof r.data.error === 'string' && r.data.error.length > 0);
}

/* ── A rate-limited token is a failed lookup, not an offline channel ─── */
{
  /* 429 is the case that made the dot go dark mid-broadcast. */
  const env = makeEnv({ helixStatus: 429 });
  const r = await hit(env);
  check('a rate-limited lookup reports not live', r.data.live, false);
  ok('and marks itself an error rather than an offline channel', !!r.data.error);
}

/* ── No credentials ─────────────────────────────────────────────────── */
{
  const env = makeEnv({ streams: [LIVE_STREAM] });
  delete env.TWITCH_CLIENT_SECRET;
  const r = await hit(env);
  check('an unconfigured server answers 200', r.status, 200);
  check('not live', r.data.live, false);
  ok('and says why', /not configured/.test(r.data.error || ''));
  check('without calling Twitch at all', env._calls.streams, 0);
}

/* ── Cacheable at the edge ──────────────────────────────────────────── */
{
  const env = makeEnv({ streams: [LIVE_STREAM] });
  const r = await hit(env);
  ok('the response is cacheable by the browser', /max-age=60/.test(r.cc || ''));
  ok('and by the edge, so a burst of page loads need not reach the rig',
    /s-maxage=\d+/.test(r.cc || ''));
}

/* ── The contract this all hangs on ─────────────────────────────────── */
{
  /* Mapping a failed lookup onto `error` is only worth anything because
     something reads it. If that check is ever removed, the mapping above
     becomes dead weight and a blip starts announcing again. */
  const notif = readFileSync(join(REPO, 'js/notifications.js'), 'utf8');
  ok('the announcer still skips a status carrying an error',
    /if \(!status \|\| status\.error\) return;/.test(notif));
}

/* ── Report ─────────────────────────────────────────────────────────── */
if (failures.length) {
  console.error(`\n✗ ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`[twitch-status] ${passed} assertions passed.`);
