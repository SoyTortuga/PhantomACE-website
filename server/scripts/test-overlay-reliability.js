#!/usr/bin/env node
/* ══════════════════════════════════════════════
   OVERLAY CLIENT RELIABILITY — test suite

     node server/scripts/test-overlay-reliability.js

   js/pages/overlay.js runs for a whole marathon inside OBS on the streaming
   PC. Each block here pins one way it used to fail on air:

     FOLLOW-BOT WAVE   — 200 follows played one card at a time held every sub
                         and raid back ~25 minutes. Follows now merge into one
                         "+N new followers" card, higher tiers jump the queue,
                         and the queue is capped (low tier dropped first).
     CLOCK SKEW        — the replay window compared server ev.at to the OBS
                         PC's clock; a PC 2+ minutes fast dropped EVERY alert.
     OVERLAPPING POLLS — setInterval polled whether or not the last reply had
                         landed; an older reply could move the cursor back.
     FEED RESET        — a server whose seq restarted below our cursor would
                         swallow every alert until it climbed past it.
     STUCK PREDICTION  — a LOCKED panel whose 'end' never came stayed up for
                         good and blocked the idle self-reload.
     LAYOUT-HIDDEN     — a panel a layout preset switched off (style.display)
                         was counted as "on screen" and blocked the reload.

   The page is driven in a vm with a fake clock, a fake timer wheel and a
   fetch whose replies the test releases by hand, so ordering is exact.
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
const ok = (label, cond) => check(label, !!cond, true);

function makeElement(tag) {
  const classes = new Set();
  const el = {
    tagName: tag, className: '', dataset: {}, alt: '', src: '', style: {},
    innerHTML: '', textContent: '', hidden: false,
    children: [], parentNode: null,
    classList: {
      add(c) { classes.add(c); }, remove(c) { classes.delete(c); },
      contains(c) { return classes.has(c); }, toggle(c, on) { if (on) classes.add(c); else classes.delete(c); },
    },
    addEventListener() {}, removeEventListener() {},
    setAttribute() {},
    appendChild(child) { child.parentNode = el; el.children.push(child); return child; },
    removeChild(child) {
      const i = el.children.indexOf(child);
      if (i !== -1) el.children.splice(i, 1);
      child.parentNode = null;
      return child;
    },
    replaceChildren(...kids) { el.children = []; kids.forEach(k => el.appendChild(k)); },
  };
  /* esc() in the page relies on textContent → innerHTML escaping. */
  let tc = '';
  Object.defineProperty(el, 'textContent', {
    get() { return tc; },
    set(v) { tc = String(v); el.innerHTML = tc.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
  });
  return el;
}

/** Every bit of markup under a node, for reading what a card says. */
function text(el) {
  return (el.innerHTML || '') + (el.textContent || '') + el.children.map(text).join('');
}

/**
 * Load overlay.js.
 * @param {object} o
 * @param {number} o.skewMs      local clock minus server clock (+ = PC fast)
 * @param {string|null} o.stored the stored cursor
 * @param {string} [o.search]    extra query string
 */
function boot(o) {
  let serverClock = 1_800_000_000_000;
  const local = () => serverClock + (o.skewMs || 0);

  const ids = ['ovStage', 'ovFault', 'ovPrediction', 'ovPredOutcomes', 'ovPredLabel', 'ovPredTitle', 'ovPredTimer',
    'ovScramble', 'ovMaze', 'ovMtg', 'ovRaid', 'ovBingo', 'ovMc', 'ovCheckin', 'ovHatch'];
  const els = {};
  for (const id of ids) els[id] = makeElement('div');
  for (const id of ['ovPrediction', 'ovScramble', 'ovMaze', 'ovMtg', 'ovRaid', 'ovBingo', 'ovMc', 'ovCheckin', 'ovHatch', 'ovFault']) els[id].hidden = true;
  const body = makeElement('body');

  const store = new Map();
  if (o.stored != null) store.set('ov_cursor', String(o.stored));

  /* Timer wheel on the LOCAL clock. */
  let nextId = 1;
  const timers = new Map();
  const add = (fn, ms, every) => { const id = nextId++; timers.set(id, { fn, at: local() + (ms || 0), every }); return id; };
  const clear = (id) => { timers.delete(id); };

  const requests = [];   // { since, resolve }
  const fetchImpl = (url) => {
    const m = String(url).match(/[?&]since=([^&]*)/);
    return new Promise((resolve) => { requests.push({ since: m ? m[1] : null, resolve }); });
  };

  const replaced = [];
  class FakeURL {
    constructor(h) { this.h = h; this.searchParams = { set() {} }; }
    toString() { return this.h; }
  }

  const FakeDate = { now: () => local(), parse: (s) => Date.parse(s) };

  const sandbox = {
    document: { getElementById: (id) => els[id] || null, createElement: makeElement, createElementNS: (ns, t) => makeElement(t), body },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    fetch: fetchImpl, URLSearchParams, URL: FakeURL, Date: FakeDate, Number, Math, console, isFinite, JSON,
    location: { search: '?key=test' + (o.search || ''), href: 'https://x/overlay.html?key=test', replace: (u) => replaced.push(u) },
    setTimeout: (fn, ms) => add(fn, ms, 0), clearTimeout: clear,
    setInterval: (fn, ms) => add(fn, ms, ms || 1), clearInterval: clear,
    requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(SRC, sandbox, { filename: 'js/pages/overlay.js' });

  const flush = () => new Promise(r => setImmediate(() => setImmediate(r)));

  return {
    els, body, store, requests, replaced,
    serverNow: () => serverClock,
    /** Release the oldest pending request with this body (serverNow stamped). */
    async reply(bodyObj, which = 0) {
      const req = requests.splice(which, 1)[0];
      req.resolve({ ok: true, json: () => Promise.resolve({ serverNow: serverClock, ...bodyObj }) });
      await flush();
      return req;
    },
    /** Move both clocks forward, running every timer that falls due. */
    async advance(ms) {
      const end = local() + ms;
      for (;;) {
        let due = null, dueId = null;
        for (const [id, t] of timers) if (t.at <= end && (!due || t.at < due.at)) { due = t; dueId = id; }
        if (!due) break;
        serverClock += Math.max(0, due.at - local());
        if (due.every) due.at += due.every; else timers.delete(dueId);
        due.fn();
        await flush();
      }
      serverClock += end - local();
      await flush();
    },
  };
}

const mk = (ov, seq, type, extra = {}, ageMs = 1000) => ({ seq, type, at: ov.serverNow() - ageMs, ...extra });

/* ── CLOCK SKEW: a PC three minutes FAST still shows live alerts ─────── */
{
  const ov = boot({ skewMs: 3 * 60 * 1000, stored: '1' });
  await ov.reply({ events: [mk(ov, 2, 'sub', { who: 'Fresh' }, 1000)], latestSeq: 2 });
  check('a PC 3 minutes fast still shows a 1s-old alert', ov.els.ovStage.children.length, 1);
}
{
  const ov = boot({ skewMs: 3 * 60 * 1000, stored: '1' });
  await ov.reply({ events: [mk(ov, 2, 'sub', { who: 'Stale' }, 10 * 60 * 1000)], latestSeq: 2 });
  check('and still drops a genuinely stale one', ov.els.ovStage.children.length, 0);
  check('which is still acknowledged', ov.store.get('ov_cursor'), '2');
}
{
  /* A PC 3 minutes SLOW must not replay something 4 minutes old either. */
  const ov = boot({ skewMs: -3 * 60 * 1000, stored: '1' });
  await ov.reply({ events: [mk(ov, 2, 'sub', { who: 'Old' }, 4 * 60 * 1000)], latestSeq: 2 });
  check('a PC 3 minutes slow does not replay a 4-minute-old alert', ov.els.ovStage.children.length, 0);
}

/* ── ONE POLL IN FLIGHT ───────────────────────────────────────────────── */
{
  const ov = boot({ stored: '5' });
  check('the first poll goes out on load', ov.requests.length, 1);
  await ov.advance(5000);
  check('no second poll while the first is unanswered', ov.requests.length, 1);
  await ov.reply({ events: [], latestSeq: 5 });
  check('nothing new until the poll interval', ov.requests.length, 0);
  await ov.advance(1000);
  check('then exactly one next poll', ov.requests.length, 1);
}
{
  /* A hung request is abandoned by the watchdog and the chain carries on; its
     late reply is ignored rather than acted on out of order. */
  const ov = boot({ stored: '5' });
  await ov.advance(9000);
  check('a hung poll is given up on, and the next goes out', ov.requests.length, 2);
  await ov.reply({ events: [mk(ov, 6, 'sub', { who: 'Late' })], latestSeq: 6 }, 0);
  check('the abandoned reply is ignored', ov.els.ovStage.children.length, 0);
  check('and does not move the cursor', ov.store.get('ov_cursor'), '5');
  await ov.reply({ events: [mk(ov, 6, 'sub', { who: 'Late' })], latestSeq: 6 }, 0);
  check('the live poll delivers it', ov.els.ovStage.children.length, 1);
}

/* ── THE CURSOR ONLY MOVES FORWARD ───────────────────────────────────── */
{
  const ov = boot({ stored: '10' });
  await ov.reply({ events: [mk(ov, 9, 'sub'), mk(ov, 10, 'raid')], latestSeq: 10 });
  check('events at or behind the cursor are never shown', ov.els.ovStage.children.length, 0);
  check('and the cursor stays put', ov.store.get('ov_cursor'), '10');
}

/* ── A RESET FEED IS RESYNCED, NOT WAITED OUT ─────────────────────────── */
{
  const ov = boot({ stored: '500' });
  await ov.reply({ events: [], latestSeq: 3 });
  await ov.advance(1000);
  check('a server behind our cursor makes us ask from the start', ov.requests[0].since, '0');
  await ov.reply({ events: [mk(ov, 1, 'sub', { who: 'AfterReset' }), mk(ov, 2, 'follow', { user: 'f' }, 10 * 60 * 1000)], latestSeq: 2 });
  check('the post-reset alert shows', ov.els.ovStage.children.length, 1);
  check('the stale one in the new feed does not', /AfterReset/.test(text(ov.els.ovStage)), true);
  check('and the cursor adopts the new numbering', ov.store.get('ov_cursor'), '2');
}

/* ── FOLLOW-BOT WAVE ──────────────────────────────────────────────────── */
{
  const ov = boot({ stored: '1' });
  /* A sub is on stage; two hundred follows land, then a raid. */
  const batch = [mk(ov, 2, 'sub', { who: 'FirstSub' })];
  for (let i = 0; i < 200; i++) batch.push(mk(ov, 3 + i, 'follow', { user: 'bot' + i }));
  batch.push(mk(ov, 203, 'raid', { who: 'BigRaider', viewers: 40 }));
  await ov.reply({ events: batch, latestSeq: 203 });
  ok('the sub is on stage', /FirstSub/.test(text(ov.els.ovStage)));

  await ov.advance(7000 + 340 + 350 + 10);
  ok('the raid jumped ahead of the follows', /BigRaider/.test(text(ov.els.ovStage)));

  await ov.advance(7000 + 340 + 350 + 10);
  const card = text(ov.els.ovStage);
  ok('two hundred follows became ONE card', /\+200 new followers/.test(card));
  ok('and it names none of them', !/bot\d/.test(card));

  await ov.advance(7000 + 340 + 350 + 10);
  check('and the stage is empty after — 3 cards, not 202', ov.els.ovStage.children.length, 0);
  ok('with the alerting flag cleared', !ov.body.classList.contains('ov-alerting'));
}
{
  /* Follows that arrive across several polls still fold into the queued card. */
  const ov = boot({ stored: '1' });
  await ov.reply({ events: [mk(ov, 2, 'sub', { who: 'S' }), mk(ov, 3, 'follow', { user: 'a' })], latestSeq: 3 });
  await ov.advance(1000);
  await ov.reply({ events: [mk(ov, 4, 'follow', { user: 'b' }), mk(ov, 5, 'follow', { user: 'c' })], latestSeq: 5 });
  await ov.advance(7000);
  ok('follows from later polls merge into the queued card', /\+3 new followers/.test(text(ov.els.ovStage)));
}
{
  /* A single follow still reads as before. */
  const ov = boot({ stored: '1' });
  await ov.reply({ events: [mk(ov, 2, 'follow', { user: 'Solo' })], latestSeq: 2 });
  ok('a lone follow keeps its name', /Solo followed!/.test(text(ov.els.ovStage)));
}

/* ── THE QUEUE IS CAPPED, LOW TIER FIRST, REVEALS NEVER ───────────────── */
{
  const ov = boot({ stored: '1' });
  const batch = [mk(ov, 2, 'sub', { who: 'OnStage' }), mk(ov, 3, 'wheel-spin', { segments: [], winnerIndex: 0 })];
  for (let i = 0; i < 40; i++) batch.push(mk(ov, 4 + i, 'cheer', { user: 'c' + i, bits: 1 }));
  batch.push(mk(ov, 44, 'raid', { who: 'LateRaid', viewers: 3 }));
  await ov.reply({ events: batch, latestSeq: 44 });

  /* Play the whole queue out, recording each distinct card once. */
  const shown = [];
  let last = null;
  for (let n = 0; n < 1200; n++) {
    const card = ov.els.ovStage.children[0];
    if (card && card !== last) { shown.push(text(card)); last = card; }
    await ov.advance(500);
    while (ov.requests.length) await ov.reply({ events: [], latestSeq: 44 });
  }
  check('the stage drained back to empty', ov.els.ovStage.children.length, 0);
  /* One poll delivered all 43 at once, so the cap applied before the first
     card took the stage: 25 kept, 18 low-tier cheers dropped. */
  check('a 43-alert burst is capped to 25 cards', shown.length, 25);
  ok('the sub that was first in still played first', /OnStage/.test(shown[0]));
  ok('the wheel reveal survived the cap', shown.some(s => /Wheel/.test(s)));
  ok('the raid survived the cap and beat the cheers', shown.findIndex(s => /LateRaid/.test(s)) < shown.findIndex(s => /cheered/.test(s)));
  ok('the oldest cheers are the ones kept (newest dropped)', shown.some(s => /c0 cheered/.test(s)) && !shown.some(s => /c39 cheered/.test(s)));
}

/* ── PREDICTION PANEL CANNOT STICK ────────────────────────────────────── */
const OUT = [{ id: 'o1', title: 'Yes', points: 10, users: 1 }, { id: 'o2', title: 'No', points: 5, users: 1 }];
{
  const ov = boot({ stored: '1' });
  const lockedAt = new Date(ov.serverNow()).toISOString();
  await ov.reply({ events: [mk(ov, 2, 'prediction', { state: 'lock', title: 'T', outcomes: OUT, locksAt: lockedAt })], latestSeq: 2 });
  check('a lock shows the panel', ov.els.ovPrediction.hidden, false);
  await ov.advance(29 * 60 * 1000);
  check('still up at 29 minutes', ov.els.ovPrediction.hidden, false);
  await ov.advance(2 * 60 * 1000);
  check('hidden by 30 minutes with no end', ov.els.ovPrediction.hidden, true);
  check('and its list emptied', ov.els.ovPredOutcomes.children.length, 0);
}
{
  /* ACTIVE with a lock time, PC clock 10 minutes slow: the cap follows the
     prediction's own (server-clock) window, not the PC's. */
  const ov = boot({ stored: '1', skewMs: -10 * 60 * 1000 });
  const locksAt = new Date(ov.serverNow() + 2 * 60 * 1000).toISOString();
  await ov.reply({ events: [mk(ov, 2, 'prediction', { state: 'begin', title: 'T', outcomes: OUT, locksAt })], latestSeq: 2 });
  check('a begin shows the panel', ov.els.ovPrediction.hidden, false);
  ok('its countdown reads the server clock (~2:00, not 12:00)', /^[12]:\d\d$/.test(ov.els.ovPredTimer.textContent));
  await ov.advance(6 * 60 * 1000);
  check('still up before lock + grace (7 min)', ov.els.ovPrediction.hidden, false);
  await ov.advance(90 * 1000);
  check('an active panel whose lock never came hides at lock + grace', ov.els.ovPrediction.hidden, true);
}
{
  /* The teardown for a switched-off prediction alert closes the panel without
     a reveal. */
  const ov = boot({ stored: '1' });
  await ov.reply({ events: [mk(ov, 2, 'prediction', { state: 'lock', title: 'T', outcomes: OUT, locksAt: new Date(ov.serverNow()).toISOString() })], latestSeq: 2 });
  await ov.advance(1000);
  await ov.reply({ events: [mk(ov, 3, 'prediction', { state: 'end', status: 'RESOLVED', quiet: true, title: 'T', outcomes: OUT, winningOutcomeId: 'o1' })], latestSeq: 3 });
  check('a quiet end hides the panel immediately', ov.els.ovPrediction.hidden, true);
  check('with no winner reveal', ov.els.ovPrediction.dataset.state, 'locked');
}

/* ── LAYOUT-HIDDEN PANELS DO NOT BLOCK THE IDLE RELOAD ───────────────── */
{
  const ov = boot({ stored: '1', search: '&reloadHours=0.01' });   // 36s
  await ov.reply({ events: [], latestSeq: 1 });
  ov.els.ovRaid.hidden = false;
  ov.els.ovRaid.style.display = 'none';     // a preset switched it off
  /* Keep answering polls so the feed stays healthy. */
  for (let i = 0; i < 70 && !ov.replaced.length; i++) {
    await ov.advance(1000);
    while (ov.requests.length) await ov.reply({ events: [], latestSeq: 1 });
  }
  check('a preset-hidden panel does not block the idle reload', ov.replaced.length > 0, true);
}
{
  const ov = boot({ stored: '1', search: '&reloadHours=0.01' });
  await ov.reply({ events: [], latestSeq: 1 });
  ov.els.ovRaid.hidden = false;             // genuinely on screen
  for (let i = 0; i < 130; i++) {
    await ov.advance(1000);
    while (ov.requests.length) await ov.reply({ events: [], latestSeq: 1 });
  }
  check('a visible panel still holds the reload off', ov.replaced.length, 0);
}

/* ── SCRAMBLE CLOCK: msLeft is relative, so skew must not shift it ────── */
{
  const scSrc = fs.readFileSync(path.join(REPO, 'js/pages/overlay-scramble.js'), 'utf8');
  const els = {};
  for (const id of ['ovScramble', 'ovScWord', 'ovScCategory', 'ovScClock', 'ovScRound', 'ovScAnswered', 'ovScScores']) els[id] = makeElement('div');
  const now = 1_800_000_000_000;
  const sandbox = {
    document: { getElementById: (id) => els[id] || null, createElement: makeElement },
    /* The server's clock is 5 minutes BEHIND the OBS PC. */
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ status: 'running', round: 1, display: 'ABC', msLeft: 30000, serverNow: now - 5 * 60 * 1000, scores: [] }) }),
    URLSearchParams, location: { search: '' }, Date: { now: () => now }, Math, String,
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0,
  };
  vm.runInNewContext(scSrc, sandbox, { filename: 'js/pages/overlay-scramble.js' });
  await new Promise(r => setImmediate(() => setImmediate(r)));
  check('a scramble with 30s left reads 30s whatever the clock skew', els.ovScClock.textContent, '30s');
}

/* ── THE SHARED BUFFER EVICTS FOLLOWS BEFORE REAL ALERTS ──────────────── */
{
  const { pushOverlayEvent } = await import('../../functions/api/overlay/events.js');
  const store = new Map();
  const env = {
    MARKETPLACE: {
      async get(k, t) { if (!store.has(k)) return null; const r = store.get(k); return t === 'json' ? JSON.parse(r) : r; },
      async put(k, v) { store.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
      async mutate(k, fn) { const cur = store.has(k) ? JSON.parse(store.get(k)) : null; const next = await fn(cur); if (next !== undefined) store.set(k, JSON.stringify(next)); return next; },
    },
  };
  await pushOverlayEvent(env, { type: 'sub', who: 'KeepMe' });
  for (let i = 0; i < 200; i++) await pushOverlayEvent(env, { type: 'follow', user: 'bot' + i });
  await pushOverlayEvent(env, { type: 'raid', who: 'AlsoKeep', viewers: 9 });
  const rec = JSON.parse(store.get('overlay_events'));
  check('the buffer stays at 60', rec.events.length, 60);
  ok('a sub from before a 200-follow wave survives it', rec.events.some(e => e.who === 'KeepMe'));
  ok('as does the raid after it', rec.events.some(e => e.who === 'AlsoKeep'));
  ok('and the follows kept are the newest', rec.events.some(e => e.user === 'bot199') && !rec.events.some(e => e.user === 'bot0'));
  check('every push still took a seq', rec.seq, 202);
  const seqs = rec.events.map(e => e.seq);
  ok('and the buffer is still in seq order', seqs.every((s, i) => i === 0 || s > seqs[i - 1]));
}

/* ── Source-level marathon rules for what this changed ────────────────── */
{
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '');
  ok('no fixed-interval poller remains', !/setInterval\(poll/.test(code));
  ok('no box-shadow or backdrop-filter crept into the client', !/box-shadow|backdrop-filter/.test(code));
}

console.log('');
if (failures.length) {
  console.log(`[overlay-reliability] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[overlay-reliability] ${passed} assertions passed.`);
console.log('');
