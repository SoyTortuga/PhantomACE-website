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

/** A clock the test can move, so "the next day" means the next day rather
    than a different subscription. */
function fakeClock(startMs) {
  const ref = { ms: startMs };
  const Real = Date;
  const D = function (...args) { return args.length ? new Real(...args) : new Real(ref.ms); };
  D.now = () => ref.ms;
  D.prototype = Real.prototype;
  D.parse = Real.parse;
  D.UTC = Real.UTC;
  D.advance = (ms) => { ref.ms += ms; };
  return D;
}

/** A fresh page load, with its own empty localStorage. */
function loadPage(sharedStore, clock) {
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
    'window', 'document', 'localStorage', 'setTimeout', 'fetch', 'Notification', 'Date',
    src + '\nreturn { addNotification, getNotifications, handleTwitchStatusForNotifications,'
        + ' checkUserNotifications, dedupeConditionNotifications };'
  );
  const api = factory(win, document, localStorage, noop, win.fetch, undefined, clock || Date);
  return { ...api, store, clock,
           keys: () => api.getNotifications().map(n => n.key),
           messages: () => api.getNotifications().map(n => n.message) };
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

/* ── A CONDITION IS NOT AN EVENT ──────────────────────────────────────
   checkUserNotifications runs from auth.js on EVERY page load, and the
   three things it can raise are conditions that stay true for a day or
   three: an anniversary, a sub about to lapse. Unkeyed, each was re-added
   -- and re-popped as a desktop notification -- on every page the user
   opened while it held. Twelve page loads, twelve identical notifications.
   That is the "stale notifications keep popping" report. */
{
  /* ONE subscription, and the CLOCK is what moves. An earlier version of
     this test shortened subExpiresAt instead — which changes the key by
     itself, so it passed even with the day left out of the key and proved
     nothing. */
  const clock = fakeClock(Date.parse('2026-03-01T12:00:00Z'));
  const page = loadPage(null, clock);
  const sub = { subExpiresAt: '2026-03-03T12:00:00Z' };

  for (let i = 0; i < 12; i++) page.checkUserNotifications(sub);
  check('twelve page loads raise one expiry warning', page.messages().length, 1);
  ok('and it says how long is left', /expires in 2 days/.test(page.messages()[0]));

  /* The next day is a DIFFERENT warning and must still arrive. Keyed on the
     subscription alone, "expires in 2 days" would be the last thing said —
     and would still be sitting there on the morning it expired. */
  clock.advance(86400000);
  for (let i = 0; i < 8; i++) page.checkUserNotifications(sub);
  check('the next day warns again, once', page.messages().length, 2);
  ok('with the number brought up to date', /expires in 1 day\b/.test(page.messages()[0]));
  ok('and the two are keyed apart', page.keys()[0] !== page.keys()[1]);
}

{
  /* Anniversaries are once a year, however many times the day is loaded. */
  const page = loadPage();
  const soon = new Date(Date.now() + 3600000);
  const anniversary = new Date(soon);
  anniversary.setFullYear(soon.getFullYear() - 4);
  const user = { followedAt: anniversary.toISOString(), subscribedAt: anniversary.toISOString() };
  for (let i = 0; i < 10; i++) page.checkUserNotifications(user);
  check('ten page loads raise two anniversaries, not twenty', page.messages().length, 2);
  ok('one for the follow', page.messages().some(m => /follow anniversary/.test(m)));
  ok('and one for the sub', page.messages().some(m => /sub anniversary/.test(m)));
}

/* ── The backlog the bug already made ────────────────────────────────── */
{
  /* Keying stops new duplicates and does nothing about the pile already in
     a subscriber's localStorage, which is what they will actually open the
     panel to. */
  const store = new Map();
  const seed = [];
  for (let i = 0; i < 9; i++) seed.push({ id: 'a' + i, type: 'sub_expiring', time: Date.now() - i * 3600e3, message: 'Your subscription expires in 2 days. Renew to keep your perks!' });
  for (let i = 0; i < 4; i++) seed.push({ id: 'b' + i, type: 'sub_expiring', time: Date.now() - (20 + i) * 3600e3, message: 'Your subscription expires in 3 days. Renew to keep your perks!' });
  for (let i = 0; i < 6; i++) seed.push({ id: 'c' + i, type: 'offline', time: Date.now() - (50 + i) * 3600e3, message: 'PhantomACE has gone offline.' });
  for (let i = 0; i < 6; i++) seed.push({ id: 'd' + i, type: 'live', time: Date.now() - (51 + i) * 3600e3, message: 'PhantomACE is now LIVE!' });
  store.set('pa_notifications', JSON.stringify(seed));

  const page = loadPage(store);
  check('the duplicates are collapsed', page.dedupeConditionNotifications(), 11);
  const left = page.getNotifications();
  check('one per distinct warning survives', left.filter(n => n.type === 'sub_expiring').length, 2);
  check('and it is the most recent copy', left.find(n => n.type === 'sub_expiring').id, 'a0');

  /* STREAM HISTORY IS NOT A DUPLICATE. Every "gone offline" is the same
     sentence; collapsing those by message would flatten a month of
     broadcasts into one line. */
  check('every live notice is kept', left.filter(n => n.type === 'live').length, 6);
  check('and every offline one', left.filter(n => n.type === 'offline').length, 6);

  check('running it again changes nothing', page.dedupeConditionNotifications(), 0);
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
