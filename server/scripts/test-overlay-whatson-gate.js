#!/usr/bin/env node
/* ══════════════════════════════════════════════
   OVERLAY — the "what's on stream" gate

     node server/scripts/test-overlay-whatson-gate.js

   A gated panel fetches its own state endpoint only while the single
   `whatsOn` pointer names its event, and does no network at all otherwise.
   On a source that stays open for a whole marathon stream that is the
   difference between a few requests and tens of thousands.

   The failure mode is SILENT IN BOTH DIRECTIONS, which is why this exists:

     - a MY_GAME that does not match a name the server's stream-now GAMES
       list can ever write means the pointer never names the panel, so it
       never shows and nothing logs anything;
     - a guard written `if (!mine())` instead of `if (mine() === false)`
       treats "the bus has not answered yet" as "not my event", so a panel
       opened before the first poll lands never starts polling at all;
     - a panel that never subscribes shows up to one idle interval late.

   Each panel is RUN, not grepped: the IIFE is evaluated against a fake
   document, a fake fetch and a fake bus, and the test counts the fetches.
   A regex would have passed on all three of the faults above.
   ══════════════════════════════════════════════ */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(REPO, p), 'utf8');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

/* The panels that read the pointer, and the server file that keeps the
   pointer alive for each one's event. The panel's element id is read out of
   the panel's own source rather than written here, so a label can never
   drift from what the code actually looks up. */
const GATED = [
  { file: 'js/pages/overlay-dino-safari.js',     game: 'dino-park',  server: 'functions/api/dino-safari.js' },
  { file: 'js/pages/overlay-mana-clash-chat.js', game: 'mana-clash', server: 'functions/api/mana-clash-chat.js' },
  { file: 'js/pages/overlay-pham-wind.js',       game: 'phamshock',  server: 'functions/api/pham-wind-night.js' },
  { file: 'js/pages/overlay-maze.js',            game: 'maze',       server: 'functions/api/bot/maze.js' },
  { file: 'js/pages/overlay-scramble.js',        game: 'scramble',   server: 'functions/api/chat-game.js' },
  { file: 'js/pages/overlay-mtgbbb.js',          game: 'mtgbbb',     server: 'functions/api/mtgbbb/state.js' },
  { file: 'js/pages/overlay-commander-bingo.js', game: 'bingo',      server: 'functions/api/bingo/state.js' },
];

/* EVERY PANEL BAILS IF ITS ELEMENT IS MISSING (`if (!panel) return;`), which
   is right, but it means renaming the markup silently retires the panel for
   the whole stream with nothing logged. Resolve each id from the script and
   check the overlay actually carries it. */
{
  const markup = read('overlay.html');
  for (const p of GATED) {
    const found = /var panel = document\.getElementById\('([A-Za-z0-9_-]+)'\)/.exec(read(p.file));
    ok(`${p.file}: looks up one panel element`, !!found);
    p.panel = found && found[1];
    ok(`${p.panel}: the overlay markup carries that id`,
      !!p.panel && new RegExp(`id="${p.panel}"`).test(markup));
  }
}

/* ── The pointer can actually name each panel's game ─────────────────── */
{
  /* A MY_GAME outside this list is a panel that can never show. */
  const src = read('functions/api/stream-now.js');
  const list = /const GAMES = \[([^\]]*)\]/.exec(src);
  ok('the server declares its GAMES list', !!list);
  const games = [...list[1].matchAll(/'([a-z-]+)'/g)].map(m => m[1]);

  for (const p of GATED) {
    const js = read(p.file);
    const my = /var MY_GAME = '([a-z-]+)'/.exec(js);
    ok(`${p.panel}: declares a MY_GAME`, !!my);
    check(`${p.panel}: gates on the game this suite expects`, my && my[1], p.game);
    ok(`${p.panel}: and on a game the pointer can hold`, games.includes(p.game));
  }

  /* The other half: something has to WRITE the pointer for that game, or it
     is never named however correct the client is. */
  for (const p of GATED) {
    const server = read(p.server);
    ok(`${p.game}: its server file maintains the pointer`,
      /refreshStreamNow|clearStreamNow/.test(server));
  }
}

/* ── Each panel, actually run ────────────────────────────────────────── */

/* Enough DOM for these panels to initialise. Every getElementById answers,
   because a panel that bails early would pass a "did not fetch" test for
   entirely the wrong reason. */
function fakeDom() {
  const made = new Map();
  const el = (id) => {
    if (made.has(id)) return made.get(id);
    const node = {
      id, hidden: false, textContent: '', innerHTML: '', src: '', onerror: null,
      value: '', style: {}, children: [], dataset: {},
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      setAttribute() {}, removeAttribute() {}, getAttribute: () => null,
      appendChild() {}, removeChild() {}, replaceChildren() {}, insertBefore() {},
      addEventListener() {}, removeEventListener() {},
      querySelector: () => null, querySelectorAll: () => [],
      getBoundingClientRect: () => ({ width: 100, height: 100, top: 0, left: 0 }),
      cloneNode() { return el(id + '-clone'); },
    };
    made.set(id, node);
    return node;
  };
  return {
    getElementById: el,
    document: {
      getElementById: el,
      createElement: (t) => el('new-' + t + '-' + made.size),
      createDocumentFragment: () => el('frag-' + made.size),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {}, removeEventListener() {},
      body: el('body'),
      readyState: 'complete',
      head: el('head'),
    },
  };
}

/* Runs one panel with the bus already answering `whatsOn`, and reports what
   it fetched. Timers are collected rather than fired, so nothing runs on. */
function runPanel(file, whatsOn) {
  const { document } = fakeDom();
  const fetches = [];
  const timers = [];
  const subs = [];

  const win = {
    PhamWhatsOn: {
      get: () => whatsOn,
      subscribe: (fn) => { subs.push(fn); if (whatsOn !== undefined) { try { fn(whatsOn); } catch (e) {} } },
    },
    ovSetFault() {},
    location: { search: '', href: 'https://phantomace.tv/overlay.html', replace() {} },
    addEventListener() {}, removeEventListener() {},
    devicePixelRatio: 1,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
  };

  const sandbox = {
    window: win,
    document,
    console: { log() {}, warn() {}, error() {} },
    location: win.location,
    URLSearchParams,
    URL,
    Date,
    Math,
    JSON,
    Number,
    String,
    Boolean,
    Array,
    Object,
    isNaN,
    parseInt,
    parseFloat,
    encodeURIComponent,
    decodeURIComponent,
    AbortController: class { constructor() { this.signal = {}; } abort() {} },
    Audio: class { play() { return Promise.resolve(); } pause() {} },
    Image: class {},
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout() {},
    setInterval: (fn, ms) => { timers.push({ fn, ms, repeating: true }); return timers.length; },
    clearInterval() {},
    fetch: (url) => {
      fetches.push(String(url));
      /* Never resolves: this test is about whether the request was MADE. */
      return new Promise(() => {});
    },
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(read(file), sandbox, { filename: file });
  return { fetches, timers, subs };
}

for (const p of GATED) {
  /* 1. ANOTHER game is on stream. Nothing may go out. */
  const other = runPanel(p.file, { game: p.game === 'maze' ? 'bingo' : 'maze' });
  check(`${p.panel}: fetches nothing while another game is on stream`, other.fetches, []);
  ok(`${p.panel}: and schedules another look rather than stopping dead`, other.timers.length > 0);
  ok(`${p.panel}: and subscribes to the pointer`, other.subs.length > 0);

  /* 2. NOTHING is on stream. Also nothing. */
  const idle = runPanel(p.file, null);
  check(`${p.panel}: fetches nothing while the pointer is empty`, idle.fetches, []);

  /* 3. ITS game is on. It must fetch. A gate that never opens is worse than
     no gate. */
  const live = runPanel(p.file, { game: p.game });
  ok(`${p.panel}: fetches when its own event is on stream`, live.fetches.length > 0);

  /* 4. The bus has not answered yet (undefined). It must NOT treat that as
     "not mine" -- that is the `!mine()` vs `mine() === false` bug, and it
     silences a panel opened before the first poll lands. */
  const unknown = runPanel(p.file, undefined);
  ok(`${p.panel}: polls while the pointer is still unknown`, unknown.fetches.length > 0);
}

/* ── Report ─────────────────────────────────────────────────────────── */
if (failures.length) {
  console.error(`\n✗ ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`[overlay-whatson-gate] ${passed} assertions passed.`);
