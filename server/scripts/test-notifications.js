#!/usr/bin/env node
/* ══════════════════════════════════════════════
   LIVE NOTIFICATIONS — test suite

     node server/scripts/test-notifications.js

   THE BUG. A viewer on mobile data collected a run of "PhantomACE has gone
   offline" / "is now LIVE!" pairs across one unbroken broadcast. Two causes,
   both invisible from the code and neither reproducible on a desk:

     1. fetchTwitchStatus returned a bare { live: false } when the REQUEST
        failed. A phone changing cell reads identically to a stream ending,
        and the next successful poll reads identically to it starting again.

     2. Every open tab watches the status independently and writes to one
        shared localStorage list, so a real transition seen by four tabs was
        four notifications.

   The fix for both is that a notification names the EVENT rather than the
   observation: 'live:<started_at>' is the same string in every tab, on
   every poll, for one broadcast.

   js/notifications.js is a plain browser script, so it is loaded here the
   way the browser loads it, with document and localStorage faked — which
   also means these run against the real file rather than a copy of it.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

/** A fresh page load, with its own empty localStorage. */
function loadPage(sharedStore) {
  const store = sharedStore || new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const noop = () => {};
  const element = { addEventListener: noop, querySelector: () => null, textContent: '', style: {}, classList: { add: noop, remove: noop, contains: () => false } };
  const document = {
    addEventListener: noop,
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => element,
    cookie: '',
  };
  const win = { localStorage, document, setTimeout: noop, fetch: async () => ({ ok: false }) };

  const src = fs.readFileSync(path.join(REPO, 'js/notifications.js'), 'utf8');
  const factory = new Function(
    'window', 'document', 'localStorage', 'setTimeout', 'fetch', 'Notification',
    src + '\nreturn { addNotification, getNotifications, handleTwitchStatusForNotifications };'
  );
  const api = factory(win, document, localStorage, noop, win.fetch, undefined);
  return { ...api, store, messages: () => api.getNotifications().map(n => n.message) };
}

const LIVE = (startedAt, game) => ({ live: true, started_at: startedAt, game });
const OFFLINE = { live: false };
const BROKEN = { live: false, error: 'unreachable' };

const T1 = '2026-09-17T15:02:00Z';
const T2 = '2026-09-18T15:02:00Z';

/* ── The key is what stops a repeat ──────────────────────────────────── */
{
  const page = loadPage();
  check('a keyed notification is added', page.addNotification({ type: 'live', key: 'live:x', message: 'one' }), true);
  check('the same key again is refused', page.addNotification({ type: 'live', key: 'live:x', message: 'one' }), false);
  check('leaving one', page.messages(), ['one']);

  /* Everything that is not a broadcast is unaffected: two profile comments
     really are two notifications. */
  page.addNotification({ type: 'comment', message: 'someone commented' });
  page.addNotification({ type: 'comment', message: 'someone commented' });
  check('unkeyed notifications are never deduped', page.messages().filter(m => m === 'someone commented').length, 2);
}

/* ── The first poll never announces anything ─────────────────────────── */
{
  const page = loadPage();
  page.handleTwitchStatusForNotifications(LIVE(T1, 'Rocket League'));
  /* Otherwise opening a page mid-stream would announce a start that
     happened an hour ago, every time. */
  check('arriving while already live says nothing', page.messages(), []);
}

/* ── A real transition ───────────────────────────────────────────────── */
{
  const page = loadPage();
  page.handleTwitchStatusForNotifications(OFFLINE);
  page.handleTwitchStatusForNotifications(LIVE(T1, 'Rocket League'));
  check('going live is announced once', page.messages(), ['PhantomACE is now LIVE! Playing Rocket League']);

  page.handleTwitchStatusForNotifications(LIVE(T1, 'Rocket League'));
  page.handleTwitchStatusForNotifications(LIVE(T1, 'Rocket League'));
  check('and staying live adds nothing', page.messages().length, 1);
}

/* ── THE BUG: a dropped request is not the stream ending ─────────────── */
{
  const page = loadPage();
  page.handleTwitchStatusForNotifications(OFFLINE);
  page.handleTwitchStatusForNotifications(LIVE(T1, 'Rocket League'));
  check('live, once', page.messages().length, 1);

  /* A phone changing cell, four polls in a row. */
  for (let i = 0; i < 4; i++) page.handleTwitchStatusForNotifications(BROKEN);
  check('four failed lookups announce nothing', page.messages().length, 1);

  /* Signal returns, same broadcast. */
  page.handleTwitchStatusForNotifications(LIVE(T1, 'Rocket League'));
  check('and coming back is not a second start', page.messages(), ['PhantomACE is now LIVE! Playing Rocket League']);
}

/* ── Belt and braces: even a genuine flap announces the broadcast once ── */
{
  const page = loadPage();
  page.handleTwitchStatusForNotifications(OFFLINE);
  page.handleTwitchStatusForNotifications(LIVE(T1));
  /* Twitch itself briefly reporting no stream — the key still holds. */
  page.handleTwitchStatusForNotifications(OFFLINE);
  page.handleTwitchStatusForNotifications(LIVE(T1));
  page.handleTwitchStatusForNotifications(OFFLINE);
  page.handleTwitchStatusForNotifications(LIVE(T1));

  const live = page.messages().filter(m => m.startsWith('PhantomACE is now LIVE'));
  const off = page.messages().filter(m => m.startsWith('PhantomACE has gone offline'));
  check('one broadcast is announced once', live.length, 1);
  check('and its ending once', off.length, 1);
}

/* ── Two tabs, one list ──────────────────────────────────────────────── */
{
  /* localStorage is shared; the in-memory lastLiveState is not. Both tabs
     see the same transition and both call addNotification. */
  const store = new Map();
  const tabA = loadPage(store);
  const tabB = loadPage(store);

  for (const tab of [tabA, tabB]) tab.handleTwitchStatusForNotifications(OFFLINE);
  for (const tab of [tabA, tabB]) tab.handleTwitchStatusForNotifications(LIVE(T1, 'Rocket League'));

  check('two tabs produce one notification', tabA.messages().length, 1);
  check('and they are looking at the same list', tabB.messages(), tabA.messages());
}

/* ── Tomorrow's stream is a different broadcast ──────────────────────── */
{
  const page = loadPage();
  page.handleTwitchStatusForNotifications(OFFLINE);
  page.handleTwitchStatusForNotifications(LIVE(T1));
  page.handleTwitchStatusForNotifications(OFFLINE);
  page.handleTwitchStatusForNotifications(LIVE(T2));
  /* The dedupe must not be so eager that the next day goes unannounced. */
  check('a new broadcast is announced', page.messages().filter(m => m.startsWith('PhantomACE is now LIVE')).length, 2);
}

/* ── A response with no started_at ───────────────────────────────────── */
{
  /* An older cached payload. No key is better than a key every broadcast
     would share, which would announce the first stream and then nothing
     ever again. */
  const page = loadPage();
  page.handleTwitchStatusForNotifications(OFFLINE);
  page.handleTwitchStatusForNotifications({ live: true });
  page.handleTwitchStatusForNotifications(OFFLINE);
  page.handleTwitchStatusForNotifications({ live: true });
  check('an unkeyed broadcast still announces', page.messages().filter(m => m.startsWith('PhantomACE is now LIVE')).length, 2);
}

/* ── The source of the flap, at the fetch ────────────────────────────── */
{
  const twitch = fs.readFileSync(path.join(REPO, 'js/twitch.js'), 'utf8');
  /* fetchTwitchStatus swallowing a network error into a bare
     { live: false } is what made every consumer unable to tell "not
     streaming" from "could not ask". */
  ok('a failed status fetch is marked as an error', /catch\s*\{[\s\S]*?error:\s*'unreachable'/.test(twitch));
  ok('and the watcher refuses to announce one', /if \(!status \|\| status\.error\) return;/.test(
    fs.readFileSync(path.join(REPO, 'js/notifications.js'), 'utf8')));
}

/* ── The panel fits a phone ──────────────────────────────────────────── */
{
  /* 320px right-aligned to a bell in the middle of the top bar puts the
     left edge off the side of a 360px screen, which is what the report
     showed: the first third of every line missing. */
  const css = fs.readFileSync(path.join(REPO, 'css/components.css'), 'utf8');
  const mobile = /@media \(max-width: 767px\) \{\s*\.notif-panel \{([\s\S]*?)\}/.exec(css);
  ok('there is a phone rule for the panel', !!mobile);
  const rule = mobile ? mobile[1] : '';
  ok('pinned to the viewport, not the bell', /position:\s*fixed/.test(rule));
  ok('with both edges held off the sides', /left:\s*\d+px/.test(rule) && /right:\s*\d+px/.test(rule));
  /* A fixed width is what broke it; the phone rule must not reintroduce one. */
  ok('and no fixed width', /width:\s*auto/.test(rule));
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[notifications] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[notifications] ${passed} assertions passed.`);
console.log('');
