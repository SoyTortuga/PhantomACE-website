#!/usr/bin/env node
/* ══════════════════════════════════════════════
   OVERLAY DASHBOARD QUICK WINS — test suite

     node server/scripts/test-overlay-control.js

   Covers the overlay-dashboard controls promised but not built, plus the
   smaller overlay fixes:

     PANIC CLEAR / SKIP — ride the same /api/overlay/events control feed the
       Reload button uses. Clear wipes the alert queue and the off-queue panels
       off every open overlay; Skip dismisses the alert on screen. Carried like
       the reload token: the overlay records its first sighting WITHOUT acting
       (so a command issued before a source opened is never replayed onto it),
       and applies each later change exactly once.

     LIVE ALERT LOG — polls /api/activity only while the tab is visible.

     SUBSCRIPTION GRID — the five scope-gated features (follow, cheer,
       predictions, ad break, bits) now surface in Bot Control's grid.

     WHEEL — a refused save no longer spins the wheel anyway.

   The route is exercised for real; the page's halves are read out of source,
   since no server test can see them.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as feed from '../../functions/api/overlay/events.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

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

/* ── Who may send a panic command ────────────────────────────────────────── */
{
  const env = makeEnv({ overlay_key: 'K' });

  const anon = await ask(env, { action: 'clear' });
  check('a stranger cannot clear the overlay', anon.status, 403);

  const viewer = await ask(env, { action: 'skip' }, '12345');
  check('nor a viewer', viewer.status, 403);

  const bad = await ask(env, { action: 'nonsense' }, BROADCASTER);
  check('an unknown action is refused', bad.status, 400);

  const clear = await ask(env, { action: 'clear' }, BROADCASTER);
  check('a moderator can clear', clear.status, 200);
  ok('and gets a token back', !!(await clear.json()).token);

  const skip = await ask(env, { action: 'skip' }, BROADCASTER);
  check('a moderator can skip', skip.status, 200);
}

/* ── The overlay key is not a credential for commands either ──────────────── */
{
  const env = makeEnv({ overlay_key: 'K' });
  const withKey = await feed.onRequestPost({
    env,
    request: new Request('https://phantomace.tv/api/overlay/events?key=K', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'clear' }),
    }),
  });
  check('the overlay key cannot trigger a clear', withKey.status, 403);
}

/* ── The command reaches the overlay through the feed ─────────────────────── */
{
  const env = makeEnv({ overlay_key: 'K' });

  const before = await (await poll(env, 'K')).json();
  check('the feed carries no command until one is sent', before.control, null);

  await ask(env, { action: 'clear' }, BROADCASTER);
  const afterClear = await (await poll(env, 'K')).json();
  check('a clear arrives as a clear command', afterClear.control && afterClear.control.cmd, 'clear');
  ok('with a token', !!(afterClear.control && afterClear.control.token));

  /* Stable across polls — the overlay must not re-apply it every second. */
  const again = await (await poll(env, 'K')).json();
  check('and is stable across polls', again.control.token, afterClear.control.token);

  await new Promise(r => setTimeout(r, 2));
  await ask(env, { action: 'skip' }, BROADCASTER);
  const afterSkip = await (await poll(env, 'K')).json();
  check('a later skip replaces the command', afterSkip.control.cmd, 'skip');
  ok('with a new token', afterSkip.control.token !== afterClear.control.token);
}

/* ── The alert feed still works alongside the control channel ─────────────── */
{
  const env = makeEnv({ overlay_key: 'K' });
  await feed.pushOverlayEvent(env, { type: 'drop', code: 'AAA' });
  const first = await (await poll(env, 'K')).json();
  check('a first load still replays nothing', first.events, []);
  check('and is told the position', first.latestSeq, 1);
  check('and carries no command', first.control, null);
}

/* ── The overlay page half (clear/skip), which no server test can see ─────── */
{
  const src = read('js/pages/overlay.js');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '');   // strip prose before NEGATIVE checks

  ok('the overlay reads the control command', /data\.control/.test(code));
  /* The first sighting is only recorded, so a command issued before this source
     opened is never replayed onto it. */
  ok('the first sighting is only recorded', /controlToken === undefined/.test(code));
  ok('a later change applies the command', /ctl\.cmd === 'clear'\) clearAll\(\)/.test(code) && /ctl\.cmd === 'skip'\) skipCurrent\(\)/.test(code));

  ok('clearAll and skipCurrent exist', /function clearAll\(/.test(code) && /function skipCurrent\(/.test(code));
  /* Marathon-safety: everything a card started is stopped before it detaches. */
  ok('a shared detach stops the card timers and cleanup', /function detachCard\(/.test(code) &&
     /clearTimeout\(card\._showTimer\)/.test(code) && /clearTimeout\(card\._leaveTimer\)/.test(code) &&
     /card\._cleanup/.test(code));
  /* Clear returns the overlay to idle: queue emptied, off-queue panels hidden. */
  ok('clear empties the queue', /queue\.length = 0/.test(code));
  ok('clear hides the prediction, hatch and check-in panels',
     /clearPrediction\(\)/.test(code) && /clearHatch\(\)/.test(code) && /clearCheckinTimers\(\)/.test(code));
}

/* ── The dashboard buttons and their wiring ──────────────────────────────── */
{
  const html = read('overlay-dashboard.html');
  ok('the panel has Clear and Skip buttons', /id="odClearBtn"/.test(html) && /id="odSkipBtn"/.test(html));

  const js = read('js/pages/overlay-dashboard.js');
  ok('Clear posts the clear command', /overlayControl\('clear'/.test(js));
  ok('Skip posts the skip command', /overlayControl\('skip'/.test(js));
  ok('both go through /api/overlay/events', /fetch\('\/api\/overlay\/events'[\s\S]*?action: action/.test(js));
  ok('the panic controls are initialised', /function initPanic\(/.test(js) && /initPanic\(\)/.test(js.replace(/function initPanic/, '')));
}

/* ── The live alert log, visible-tab only ────────────────────────────────── */
{
  const html = read('overlay-dashboard.html');
  ok('the log has a feed element', /id="odAlertLog"/.test(html));

  const js = read('js/pages/overlay-dashboard.js');
  ok('the log polls the activity feed', /fetch\('\/api\/activity'/.test(js) && /function fetchAlertLog\(/.test(js));
  /* Pauses while the tab is hidden — no hammering the rig while nobody looks. */
  ok('it pauses when the tab is hidden', /visibilitychange/.test(js) && /document\.hidden/.test(js) && /stopAlertLog\(\)/.test(js));
  ok('and is initialised', /function initAlertLog\(/.test(js) && /initAlertLog\(\)/.test(js.replace(/function initAlertLog/, '')));
}

/* ── A refused wheel save must not spin ───────────────────────────────────── */
{
  const js = read('js/pages/overlay-dashboard.js');
  const spin = (js.match(/async function spinWheel[\s\S]*?\n\}/) || [''])[0];
  ok('the spin checks the save response', /saveRes/.test(spin) && /saveData\.success/.test(spin));
  ok('and bails before spinning on a refused save', /if \(!\(saveRes\.ok && saveData\.success\)\)[\s\S]*?return;/.test(spin));
}

/* ── The scope-gated subscription grid (Bot Control) ─────────────────────── */
{
  const dash = read('functions/api/bot/dashboard.js');
  ok('the dashboard reports follow/cheer status',
     /follow: subTypes\.includes\('channel\.follow'\)/.test(dash) && /cheer: subTypes\.includes\('channel\.cheer'\)/.test(dash));
  ok('and predictions/ad break/bits status',
     /predictions: subTypes\.some\(t => t\.startsWith\('channel\.prediction'\)\)/.test(dash) &&
     /adBreak: subTypes\.includes\('channel\.ad_break\.begin'\)/.test(dash) &&
     /bits: subTypes\.includes\('channel\.bits\.use'\)/.test(dash));
  ok('each also has a revoked-row check',
     /follow: isRevoked/.test(dash) && /cheer: isRevoked/.test(dash) && /predictions: isRevoked/.test(dash) &&
     /adBreak: isRevoked/.test(dash) && /bits: isRevoked/.test(dash));

  const bc = read('js/pages/bot-control.js');
  ok('Bot Control lists the five scope-gated rows',
     /subs\.follow/.test(bc) && /subs\.cheer/.test(bc) && /subs\.predictions/.test(bc) &&
     /subs\.adBreak/.test(bc) && /subs\.bits/.test(bc));
}

/* ── Report ──────────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[overlay-control] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[overlay-control] ${passed} assertions passed.`);
console.log('');
