#!/usr/bin/env node
/* ══════════════════════════════════════════════
   DINO PARK — offline egg catch-up

     node server/scripts/test-dino-park-catchup.js

   Eggs only incubate while PhantomACE is live, and until now a closed
   browser meant that gap was simply never credited — nobody could say
   whether the stream WAS live while the page was shut. Twitch's VOD list
   is that missing record: this endpoint sums how much of [since, now]
   overlaps the channel's own archived broadcasts.

   Everything here drives the real onRequestGet with a faked env and a
   faked Twitch Videos response — no network, no KV.
   ══════════════════════════════════════════════ */

import { onRequestGet, parseDuration, overlapSeconds } from '../../functions/api/dino-park-catchup.js';

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

/* ── parseDuration ────────────────────────────────────────────────────── */
check('hours, minutes and seconds', parseDuration('3h24m10s'), 3 * 3600 + 24 * 60 + 10);
check('minutes and seconds', parseDuration('45m2s'), 45 * 60 + 2);
check('seconds only', parseDuration('10s'), 10);
check('hours only', parseDuration('2h'), 7200);
check('empty string is zero', parseDuration(''), 0);
check('undefined is zero', parseDuration(undefined), 0);
check('garbage is zero, not a throw', parseDuration('not a duration'), 0);

/* ── overlapSeconds ───────────────────────────────────────────────────── */
{
  const from = 1000, now = 5000;
  check('fully inside the window', overlapSeconds(2000, 3000, from, now), 1);
  check('starts before, ends inside', overlapSeconds(0, 2000, from, now), 1);
  check('starts inside, ends after', overlapSeconds(4000, 6000, from, now), 1);
  check('fully contains the window', overlapSeconds(0, 6000, from, now), 4);
  check('entirely before the window', overlapSeconds(0, 500, from, now), 0);
  check('entirely after the window', overlapSeconds(6000, 7000, from, now), 0);
}

/* ── Fake env / fake Twitch ───────────────────────────────────────────── */
function makeEnv() {
  return {
    TWITCH_BROADCASTER_ID: '900',
    TWITCH_CLIENT_ID: 'cid',
    MARKETPLACE: {
      async get(k, t) {
        if (k === 'twitch_app_token') {
          const v = { access_token: 'tok', token: 'tok', expiresAt: Date.now() + HOUR };
          return t === 'json' ? v : JSON.stringify(v);
        }
        return null;
      },
      async put() {},
    },
  };
}

const GET = (env, since) => onRequestGet({
  env, request: new Request('https://x/api/dino-park-catchup' + (since === undefined ? '' : `?since=${since}`)),
});

function vod(startMs, durationStr) {
  return { created_at: new Date(startMs).toISOString(), duration: durationStr };
}

let calls;
function mockVideos(pages) {
  calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const u = new URL(String(url));
    const cursor = u.searchParams.get('after');
    const pageIdx = cursor ? parseInt(cursor, 10) : 0;
    const page = pages[pageIdx];
    if (!page) return new Response(JSON.stringify({ data: [] }), { status: 200 });
    const nextCursor = pageIdx + 1 < pages.length ? String(pageIdx + 1) : null;
    return new Response(JSON.stringify({
      data: page,
      pagination: nextCursor ? { cursor: nextCursor } : {},
    }), { status: 200 });
  };
}

/* ── No/invalid `since` credits nothing ──────────────────────────────── */
{
  mockVideos([[]]);
  const now = Date.now();
  check('missing since', (await (await GET(makeEnv(), undefined)).json()).liveSeconds, 0);
  check('since in the future', (await (await GET(makeEnv(), now + 60000)).json()).liveSeconds, 0);
  ok('neither even asked Twitch', calls.length === 0);
}

/* ── Missing config credits nothing, does not throw ──────────────────── */
{
  mockVideos([[]]);
  const env = makeEnv();
  delete env.TWITCH_BROADCASTER_ID;
  const body = await (await GET(env, Date.now() - HOUR)).json();
  check('no broadcaster id configured', body.liveSeconds, 0);
  ok('and Twitch was never called', calls.length === 0);
}

/* ── A VOD fully inside the gap is credited in full ──────────────────── */
{
  const now = Date.now();
  const since = now - 2 * HOUR;
  mockVideos([[ vod(now - HOUR, '45m0s') ]]);
  const body = await (await GET(makeEnv(), since)).json();
  check('a VOD fully inside the gap counts in full', body.liveSeconds, 45 * 60);
}

/* ── A VOD that started before `since` only counts from `since` ─────── */
{
  const now = Date.now();
  const since = now - HOUR;
  // Started 90 minutes ago, ran 1 hour -> ended 30 minutes ago, so only the
  // last 30 of those 60 minutes fall inside [since, now].
  mockVideos([[ vod(now - 90 * 60 * 1000, '1h0m0s') ]]);
  const body = await (await GET(makeEnv(), since)).json();
  check('only the portion inside [since, now] counts', body.liveSeconds, 30 * 60);
}

/* ── A VOD entirely before `since` contributes nothing ───────────────── */
{
  const now = Date.now();
  const since = now - HOUR;
  mockVideos([[ vod(now - 5 * HOUR, '1h0m0s') ]]);
  const body = await (await GET(makeEnv(), since)).json();
  check('an old VOD outside the gap is worth zero', body.liveSeconds, 0);
}

/* ── Multiple VODs on one page sum ───────────────────────────────────── */
{
  const now = Date.now();
  const since = now - 6 * HOUR;
  mockVideos([[ vod(now - 5 * HOUR, '30m0s'), vod(now - 2 * HOUR, '1h0m0s') ]]);
  const body = await (await GET(makeEnv(), since)).json();
  check('two VODs in the gap sum', body.liveSeconds, 30 * 60 + 60 * 60);
}

/* ── Pagination: keeps paging while the oldest VOD is still in the gap ── */
{
  const now = Date.now();
  const since = now - 10 * HOUR;
  mockVideos([
    [ vod(now - HOUR, '20m0s') ],          // page 0 — oldest here is still > since -> must page on
    [ vod(now - 5 * HOUR, '10m0s') ],      // page 1 — oldest here is still > since -> must page on
    [ vod(now - 20 * HOUR, '10m0s') ],     // page 2 — starts (and ends) before since -> zero credit, but its
                                            //          age is what stops paging any further
    [ vod(now - 40 * HOUR, '10m0s') ],     // page 3 — must never be reached
  ]);
  const body = await (await GET(makeEnv(), since)).json();
  check('credit sums across pages, excluding the one outside the window', body.liveSeconds, 20 * 60 + 10 * 60);
  check('paging stopped once a page\'s oldest VOD precedes the window', calls.length, 3);
}

/* ── The lookback window itself is capped ────────────────────────────── */
{
  const now = Date.now();
  const since = now - 30 * DAY;              // far beyond MAX_WINDOW_MS (7 days)
  // Entirely inside the 30-day gap, but before the 7-day cap -> must not count.
  mockVideos([[ vod(now - 10 * DAY, '1h0m0s') ]]);
  const body = await (await GET(makeEnv(), since)).json();
  check('a VOD older than the capped window is not credited', body.liveSeconds, 0);
}

/* ── A dead Twitch call fails soft, not a throw ──────────────────────── */
{
  globalThis.fetch = async () => new Response('nope', { status: 500 });
  const body = await (await GET(makeEnv(), Date.now() - HOUR)).json();
  check('a Twitch failure still answers cleanly', body.liveSeconds, 0);
}

/* ── The request itself is well-formed ───────────────────────────────── */
{
  const now = Date.now();
  mockVideos([[ vod(now - HOUR, '10m0s') ]]);
  await GET(makeEnv(), now - 2 * HOUR);
  const u = new URL(calls[0]);
  check('queries the right broadcaster', u.searchParams.get('user_id'), '900');
  check('archived broadcasts only', u.searchParams.get('type'), 'archive');
}

/* ── Wiring ───────────────────────────────────────────────────────────── */
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const REPO = path.resolve(HERE, '../..');

  const game = fs.readFileSync(path.join(REPO, 'games/dino-park/index.html'), 'utf8');
  ok('applyOfflineDecay calls the catch-up', /applyEggCatchup\(state\.lastTick\)/.test(game));
  ok('the catch-up credit is additive, never a replace', /e\.elapsed = Math\.min\(e\.hatchTime, e\.elapsed \+ liveSeconds\)/.test(game));
  ok('the missing null-guard on the eggs-tab tick branch is fixed', /if \(active && active\.id === 'tab-eggs'\)/.test(game));
}

/* ── Report ───────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[dino-park-catchup] ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[dino-park-catchup] ${passed} assertions passed.`);
console.log('');
