#!/usr/bin/env node
/* ══════════════════════════════════════════════
   OVERLAY RESUME — test suite

     node server/scripts/test-overlay-resume.js

   js/pages/overlay.js used to skip to the server's current position on
   every first poll. That is correct for a cold start and WRONG for a
   reload — and OBS reloads a browser source whenever its scene becomes
   visible again. So every alert that fired while the overlay's scene was
   off screen was silently dropped. Nobody would ever file a bug for it:
   the alert simply never appeared, and nothing anywhere said so.

   The fix stores the cursor and resumes from it, bounded by a replay
   window so that opening the overlay after a night off does not dump
   yesterday's alerts on air. Three behaviours have to hold at once, and
   any two of them are easy to get right while breaking the third:

     COLD START  — no stored cursor: show nothing, adopt the position.
     RESUME      — stored cursor, recent events: show them.
     STALE       — stored cursor, old events: show nothing, adopt anyway.

   The page is driven here rather than in a browser because a browser test
   of this races its own setup: the page begins polling the moment it
   parses, so a fixture installed afterwards arrives too late and the run
   reports a failure that is really a harness bug. (It did.)
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const SRC = fs.readFileSync(path.join(REPO, 'js/pages/overlay.js'), 'utf8');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(label + '\n      expected ' + e + '\n      got      ' + a);
}

/* ── A DOM, to the depth overlay.js actually uses ────────────────────────
   Not jsdom: this needs createElement, appendChild, classList and
   innerHTML, and a dependency to supply those would be larger than the
   thing under test. Anything the page touches that is missing here throws,
   which is the behaviour I want — a silent catch-all stub would let a
   broken page pass. */
function makeElement(tag) {
  const el = {
    tagName: tag, className: '', dataset: {}, alt: '', src: '',
    innerHTML: '', textContent: '', hidden: false,
    children: [], parentNode: null,
    classList: { add() {}, remove() {} },
    addEventListener() {}, removeEventListener() {},
    appendChild(child) { child.parentNode = el; el.children.push(child); return child; },
    removeChild(child) {
      const i = el.children.indexOf(child);
      if (i !== -1) el.children.splice(i, 1);
      child.parentNode = null;
      return child;
    },
  };
  return el;
}

/**
 * Load overlay.js against a fixture and let it poll once.
 *
 * @param {object} opts
 * @param {string|null} opts.stored     what localStorage holds at load
 * @param {Array}  opts.events          the feed
 * @param {number} opts.latestSeq       the server's position
 * @param {boolean} [opts.storageThrows] simulate a private window
 */
function run(opts) {
  const stage = makeElement('div');
  const fault = makeElement('div');

  const store = new Map();
  if (opts.stored !== null && opts.stored !== undefined) {
    store.set('ov_cursor', String(opts.stored));
  }

  const localStorage = {
    getItem(k) {
      if (opts.storageThrows) throw new Error('SecurityError');
      return store.has(k) ? store.get(k) : null;
    },
    setItem(k, v) {
      if (opts.storageThrows) throw new Error('SecurityError');
      store.set(k, String(v));
    },
  };

  const since = [];    // every `since` value the page asked for, null when omitted
  const timers = [];   // deferred callbacks, run explicitly rather than awaited

  const document = {
    getElementById(id) {
      if (id === 'ovStage') return stage;
      if (id === 'ovFault') return fault;
      return null;
    },
    createElement: makeElement,
  };

  const fetchImpl = (url) => {
    const m = String(url).match(/[?&]since=([^&]*)/);
    since.push(m ? m[1] : null);
    const body = m === null
      ? { events: [], latestSeq: opts.latestSeq }
      : { events: opts.events.filter(e => e.seq > Number(m[1])), latestSeq: opts.latestSeq };
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  };

  const sandbox = {
    document, localStorage, fetch: fetchImpl, URLSearchParams, Date, Number, console,
    location: { search: '?key=test' },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    setInterval: () => 0,   // the page polls once on load; that poll is what is under test
    clearTimeout: () => {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  vm.runInNewContext(SRC, sandbox, { filename: 'js/pages/overlay.js' });

  return { stage, store, since, timers };
}

/** Let the page's promise chain settle: fetch resolves, then its .then runs. */
const settle = () => new Promise(r => setImmediate(() => setImmediate(r)));

const ev = (seq, ageMs) => ({ seq, type: 'sub', who: 'viewer' + seq, at: Date.now() - ageMs });

/* ── 1. Cold start: no stored cursor ─────────────────────────────────── */
{
  const r = run({ stored: null, events: [ev(1, 5000), ev(2, 4000), ev(3, 3000)], latestSeq: 3 });
  await settle();

  check('cold start sends no since', r.since, [null]);
  check('cold start shows nothing', r.stage.children.length, 0);
  check('cold start adopts the position', r.store.get('ov_cursor'), '3');
}

/* ── 2. Resume: stored cursor, recent events ─────────────────────────── */
{
  const r = run({ stored: '1', events: [ev(2, 4000), ev(3, 3000)], latestSeq: 3 });
  await settle();

  check('resume asks from the stored cursor', r.since, ['1']);
  /* One on screen; the second waits in the queue, which is the whole point
     of the queue. Draining it proves the second was kept, not dropped. */
  check('resume shows the first missed alert', r.stage.children.length, 1);
  r.timers.splice(0).forEach(fn => fn());   // the alert's on-screen time expires
  r.timers.splice(0).forEach(fn => fn());   // its leave transition ends, freeing the stage
  r.timers.splice(0).forEach(fn => fn());   // the inter-alert gap, which calls pump()
  check('and then the second', r.stage.children.length, 1);
  check('resume advances the cursor', r.store.get('ov_cursor'), '3');
}

/* ── 3. Stale: stored cursor, events older than the replay window ────── */
{
  const OLD = 10 * 60 * 1000;               // MAX_REPLAY_MS is two minutes
  const r = run({ stored: '1', events: [ev(2, OLD), ev(3, OLD - 1000)], latestSeq: 3 });
  await settle();

  check('stale events are not shown', r.stage.children.length, 0);
  /* Counted as seen rather than left pending — otherwise they arrive again
     on the next poll, and the one after that, forever. */
  check('stale events still advance the cursor', r.store.get('ov_cursor'), '3');
}

/* ── 4. A mixed batch: the window is applied per event, not per poll ─── */
{
  const r = run({ stored: '1', events: [ev(2, 10 * 60 * 1000), ev(3, 5000)], latestSeq: 3 });
  await settle();
  check('the recent half of a mixed batch shows', r.stage.children.length, 1);
  check('and the whole batch is acknowledged', r.store.get('ov_cursor'), '3');
}

/* ── 5. No storage at all ────────────────────────────────────────────── */
{
  /* A private window, or an embedded browser with site data turned off.
     The overlay must still start and still behave as it did before the
     cursor was ever stored — it must never fail to run over a convenience. */
  const r = run({ stored: null, storageThrows: true, events: [ev(1, 3000)], latestSeq: 1 });
  await settle();

  check('storage refusing does not stop the overlay', r.since, [null]);
  check('and it behaves as a cold start', r.stage.children.length, 0);
}

/* ── 6. A junk cursor is ignored rather than trusted ─────────────────── */
{
  /* parseInt('abc') is NaN and parseInt('') is NaN, but parseInt('3abc')
     is 3 — so the guard has to be a finite-and-positive check, not a
     truthiness test. A cursor of 0 would also be wrong to resume from:
     it means "replay from the beginning of the feed". */
  for (const junk of ['', 'abc', '-1', '0', 'NaN']) {
    const r = run({ stored: junk, events: [ev(1, 3000)], latestSeq: 1 });
    await settle();
    check('a stored cursor of "' + junk + '" is treated as a cold start', r.since, [null]);
  }
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[overlay-resume] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[overlay-resume] ${passed} assertions passed.`);
console.log('');
