#!/usr/bin/env node
/* ══════════════════════════════════════════════
   RELOADING THE OVERLAY REMOTELY — test suite

     node server/scripts/test-overlay-reload.js

   An OBS browser source holds a page open for days, so a change to the
   overlay does not reach the stream until somebody refreshes the source.
   The event feed is already polled once a second, so it carries a token:
   the page remembers what it loaded with and reloads when it changes.

   THE TWO WAYS THIS GOES WRONG, both of them on air:

     it never reloads    — the token is not sent, or the page compares it
                           against itself, and the button does nothing.
     it reloads for ever — a page that treats its FIRST sighting of a token
                           as a change reloads on load, polls, sees the
                           token again, reloads again. An overlay that
                           refreshes every second is worse than a stale one.

   The second is why the first answer only records the token. Both halves
   are checked here: the route's behaviour for real, and the page's
   comparison read out of its source, since no server test can see it.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as feed from '../../functions/api/overlay/events.js';

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

const BROADCASTER = '900';

function makeEnv(seed = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  return {
    TWITCH_BROADCASTER_ID: BROADCASTER,
    MARKETPLACE: {
      async get(k, t) { if (!store.has(k)) return null; const r = store.get(k); return t === 'json' ? JSON.parse(r) : r; },
      async put(k, v) { store.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
      async mutate(k, fn) {
        const cur = store.has(k) ? JSON.parse(store.get(k)) : null;
        const next = await fn(cur);
        if (next !== undefined) store.set(k, JSON.stringify(next));
        return next === undefined ? cur : next;
      },
    },
    _store: store,
  };
}

const cookie = (userId) => `pham_session=${encodeURIComponent(JSON.stringify({ user_id: userId, display_name: 'u' + userId }))}`;

const poll = (env, key) => feed.onRequestGet({
  env,
  request: new Request('https://phantomace.tv/api/overlay/events?key=' + key),
});

const ask = (env, body, userId) => feed.onRequestPost({
  env,
  request: new Request('https://phantomace.tv/api/overlay/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(userId ? { Cookie: cookie(userId) } : {}) },
    body: JSON.stringify(body),
  }),
});

/* ── Who may ask ─────────────────────────────────────────────────────── */
{
  const env = makeEnv({ overlay_key: 'K' });

  const anon = await ask(env, { action: 'reload' });
  check('a stranger cannot reload the overlay', anon.status, 403);

  const viewer = await ask(env, { action: 'reload' }, '12345');
  check('nor a viewer', viewer.status, 403);

  const bad = await ask(env, { action: 'nonsense' }, BROADCASTER);
  check('an unknown action is refused', bad.status, 400);

  const good = await ask(env, { action: 'reload' }, BROADCASTER);
  check('a moderator can', good.status, 200);
  ok('and gets the new token back', !!(await good.json()).token);
}

/* ── THE KEY IS NOT A CREDENTIAL ─────────────────────────────────────── */
{
  /* It lives in an OBS URL and travels wherever that URL does — into a
     screenshot, a scene collection file, a support thread. It proves "this
     is the overlay", never "this person may act", so it must not open the
     POST even though it opens the GET. */
  const env = makeEnv({ overlay_key: 'K' });
  const withKey = await feed.onRequestPost({
    env,
    request: new Request('https://phantomace.tv/api/overlay/events?key=K', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reload' }),
    }),
  });
  check('the overlay key cannot trigger a reload', withKey.status, 403);
}

/* ── The token reaches the overlay ───────────────────────────────────── */
{
  const env = makeEnv({ overlay_key: 'K' });

  const before = await (await poll(env, 'K')).json();
  /* Empty, not absent: a page that loaded before anyone pressed the button
     still has something to compare against, and "" is a stable value. */
  check('the feed always carries a token', before.reloadToken, '');

  await ask(env, { action: 'reload' }, BROADCASTER);
  const after = await (await poll(env, 'K')).json();
  ok('which changes once a reload is asked for', after.reloadToken !== '');

  /* Polling again must not change it, or every overlay would reload on
     every poll for ever. */
  const again = await (await poll(env, 'K')).json();
  check('and is stable across polls', again.reloadToken, after.reloadToken);

  /* A second press is a second reload. */
  await new Promise(r => setTimeout(r, 2));
  await ask(env, { action: 'reload' }, BROADCASTER);
  const third = await (await poll(env, 'K')).json();
  ok('a second press is a different token', third.reloadToken !== after.reloadToken);
}

/* ── The feed still does its actual job ──────────────────────────────── */
{
  /* The token was added to a response the alert queue depends on. Breaking
     the cursor here would silently stop every alert on the stream. */
  const env = makeEnv({ overlay_key: 'K' });
  await feed.pushOverlayEvent(env, { type: 'drop', code: 'AAA' });
  await feed.pushOverlayEvent(env, { type: 'drop', code: 'BBB' });

  const first = await (await poll(env, 'K')).json();
  /* No cursor means "tell me where we are" — a reloaded source must not
     dump an hour of alerts on screen. */
  check('a first load still replays nothing', first.events, []);
  check('and is told the position', first.latestSeq, 2);

  const since = await (await feed.onRequestGet({
    env, request: new Request('https://phantomace.tv/api/overlay/events?key=K&since=1'),
  })).json();
  check('and a cursor still returns what is new', since.events.map(e => e.code), ['BBB']);
}

/* ── The page's half, which no server test can see ───────────────────── */
{
  const src = fs.readFileSync(path.join(REPO, 'js/pages/overlay.js'), 'utf8');
  /* Block comments stripped before any NEGATIVE assertion. The first
     version of the check below read the phrase "location.reload()" out of
     the comment explaining why it is not used, and failed. A source-level
     test that cannot tell code from prose is worse than none: it fails on
     documentation and passes on a regression that happens to be
     undocumented. */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '');

  ok('the overlay reads the token', /data\.reloadToken/.test(code));
  /* THE INFINITE RELOAD. The first sighting must only be recorded. A page
     that treated it as a change would reload on load, poll, and reload
     again — for ever, on air. */
  ok('the first sighting is only recorded', /reloadToken === undefined/.test(code));
  ok('and a later change reloads', /location\.replace\(/.test(code));
  /* location.reload() may be answered from cache, and the reason for
     pressing the button is usually that the cached copy is the stale one. */
  ok('through a changed URL, not reload()', !/location\.reload\(/.test(code));
  ok('carrying a cache-busting parameter', /searchParams\.set\('r'/.test(code));

  const html = fs.readFileSync(path.join(REPO, 'bot-control.html'), 'utf8');
  ok('the panel has the button', /id="ovReloadBtn"/.test(html));
  const js = fs.readFileSync(path.join(REPO, 'js/pages/bot-control.js'), 'utf8');
  ok('and it is wired up', /ovReloadBtn/.test(js) && /reloadOverlay/.test(js));
}

/* ── Registered, because an unmapped key is a 500 ────────────────────── */
{
  const { resolveKey } = await import('../lib/registry.js');
  const target = resolveKey('overlay_reload');
  ok('the reload token has a table', !!target);
  /* 'none': were this to expire, the token would vanish, every open overlay
     would see a change on its next poll, and they would all reload in
     unison in the middle of a stream. */
  check('and never expires on its own', target && target.expiry, 'none');
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[overlay-reload] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[overlay-reload] ${passed} assertions passed.`);
console.log('');
