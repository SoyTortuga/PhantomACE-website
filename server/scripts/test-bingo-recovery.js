#!/usr/bin/env node
/* ══════════════════════════════════════════════
   COMMANDER BINGO — server-written board + host recovery

     node server/scripts/test-bingo-recovery.js

   Two halves.

   THE BOARD. lb_bingo pays monthly prizes and used to be POSTed by the
   player's browser, so a hand-made request took first place. end.js now
   writes it from the room's own record. Checked here: the score matches
   what the player page counts, best card only, stamps included; best score
   kept; only on the real active-to-ended edge; only staff-hosted rooms; and
   last month is settled BEFORE the write.

   THE HOST PAGE. host.html's inline script is run in a vm against a stub
   DOM and a scripted fetch, so the recovery paths are exercised for real:
   a create that the server answers never goes local, a refused call is put
   back, a failed end keeps the room, and an ended room comes back to its
   award screen with the paid rows marked.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import * as create from '../../functions/api/bingo/create.js';
import * as join from '../../functions/api/bingo/join.js';
import * as call from '../../functions/api/bingo/call.js';
import * as end from '../../functions/api/bingo/end.js';
import * as award from '../../functions/api/bingo/award.js';
import * as state from '../../functions/api/bingo/state.js';
import { standings } from '../../functions/api/bingo/end.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

function makeEnv({ moderators = [] } = {}) {
  const store = new Map();
  const chains = new Map();
  const log = [];
  store.set('site_moderators', JSON.stringify({
    entries: moderators.map(id => ({ userId: String(id), name: 'Mod', addedBy: 'test' })),
  }));
  return {
    TWITCH_BROADCASTER_ID: '900',
    MARKETPLACE: {
      async get(k, t) { if (!store.has(k)) return null; const r = store.get(k); return t === 'json' ? JSON.parse(r) : r; },
      async put(k, v) { store.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
      async delete(k) { store.delete(k); },
      async mutate(k, fn) {
        const prev = chains.get(k) || Promise.resolve();
        const run = prev.then(async () => {
          const cur = store.has(k) ? JSON.parse(store.get(k)) : null;
          const next = await fn(cur);
          if (next === undefined) return cur;
          if (k === 'lb_bingo') log.push('lb_write');
          store.set(k, JSON.stringify(next));
          return JSON.parse(store.get(k));
        });
        chains.set(k, run.then(() => {}, () => {}));
        return run;
      },
      async listValues() { return []; },
      async claimMonthlyAward() { log.push('settle'); return false; },
    },
    _store: store,
    _log: log,
  };
}

const USERS = {
  broadcaster: { user_id: '900', display_name: 'PhantomACE' },
  mod: { user_id: '101', display_name: 'Mod' },
  viewer: { user_id: '202', display_name: 'Viewer' },
  p1: { user_id: '303', display_name: 'PlayerOne' },
  p2: { user_id: '304', display_name: 'PlayerTwo' },
};
const cookie = (who) => `pham_session=${encodeURIComponent(JSON.stringify(USERS[who]))}`;

async function post(mod, env, who, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (who) headers.Cookie = cookie(who);
  const res = await mod.onRequestPost({
    env, request: new Request('https://t.local/api/bingo/x', { method: 'POST', headers, body: JSON.stringify(body) }),
  });
  return { status: res.status, data: await res.json() };
}

async function get(env, who, qs) {
  const headers = {};
  if (who) headers.Cookie = cookie(who);
  const res = await state.onRequestGet({ env, request: new Request('https://t.local/api/bingo/state?' + qs, { headers }) });
  return { status: res.status, data: await res.json() };
}

const room = (env, code) => JSON.parse(env._store.get('bingo_' + code));
const setRoom = (env, code, g) => env._store.set('bingo_' + code, JSON.stringify(g));
const board = (env) => JSON.parse(env._store.get('lb_bingo') || '[]');

/* The player page's own pattern count (index.html getPatterns), ported
   verbatim, so the server is held to what the player saw on screen. */
function clientCount(ids, called, wild) {
  const m = ids.map(id => id === 0 || called.has(id) || wild.has(id));
  let n = 0;
  for (let r = 0; r < 5; r++) if ([0,1,2,3,4].map(c => r * 5 + c).every(i => m[i])) n++;
  for (let c = 0; c < 5; c++) if ([0,1,2,3,4].map(r => r * 5 + c).every(i => m[i])) n++;
  if ([0, 6, 12, 18, 24].every(i => m[i])) n++;
  if ([4, 8, 12, 16, 20].every(i => m[i])) n++;
  if ([0, 4, 20, 24].every(i => m[i])) n++;
  if (m.every(Boolean)) n++;
  return n;
}

/* ── Scoring parity with the player page ─────────────────────────────── */
{
  let mismatches = 0;
  for (let t = 0; t < 300; t++) {
    const cards = [join.generateCard(), join.generateCard()];
    const called = new Set();
    const k = Math.floor(Math.random() * 68);
    while (called.size < k) called.add(1 + Math.floor(Math.random() * 68));
    const wildcards = [{ cardIndex: 1, eventId: cards[1][3] }, { cardIndex: 0, eventId: cards[0][20] }];
    const s = standings({ calledEvents: [...called], players: [{ id: 'u_1', name: 'x', cards, cardIds: cards[0], wildcards }] })[0];
    const best = Math.max(...cards.map((ids, ci) =>
      clientCount(ids, called, new Set(wildcards.filter(w => w.cardIndex === ci).map(w => w.eventId)))));
    if (s.bingos !== best) mismatches++;
  }
  check('server bingo count matches the player page on 300 random rooms', mismatches, 0);

  const ids = join.generateCard();
  check('a full card is 12 lines + corners + blackout = 14',
    standings({ calledEvents: ids.filter(Boolean), players: [{ id: 'u_1', name: 'x', cardIds: ids }] })[0].bingos, 14);
  check('a legacy cardIds-only player is scored',
    standings({ calledEvents: ids.slice(0, 5), players: [{ id: 'u_1', name: 'x', cardIds: ids }] })[0].bingos, 1);
  check('a malformed card scores zero rather than throwing',
    standings({ calledEvents: [1], players: [{ id: 'u_1', name: 'x', cardIds: null }] })[0].bingos, 0);
}

/* ── Ending a staff room writes lb_bingo from the room ───────────────── */
{
  const env = makeEnv({ moderators: ['101'] });
  await post(create, env, 'mod', { code: 'LBAA' });
  const j1 = await post(join, env, 'p1', { code: 'LBAA', name: 'PlayerOne' });
  await post(join, env, 'p2', { code: 'LBAA', name: 'PlayerTwo' });

  /* Call p1's top row: one bingo for p1. */
  for (const id of j1.data.cardIds.slice(0, 5)) await post(call, env, 'mod', { code: 'LBAA', eventId: id });

  const e = await post(end, env, 'mod', { code: 'LBAA' });
  check('the host can end it', e.status, 200);
  check('end returns server standings', e.data.standings[0].id, 'u_303');
  check('p1 has at least one bingo', e.data.standings[0].bingos >= 1, true);
  check('the board was written', e.data.boardWritten, true);

  const lb = board(env);
  const p1Row = lb.find(r => r.id === '303');
  ok('p1 is on lb_bingo, keyed by account id (no u_ prefix)', p1Row);
  check('with the server-counted score', p1Row && p1Row.score, e.data.standings[0].bingos);
  check('a player with no bingo is not written', lb.some(r => r.id === '304'), false);
  check('last month is settled BEFORE the board write', env._log.filter(x => x === 'settle' || x === 'lb_write'), ['settle', 'lb_write']);

  /* A repeated end — a host retrying after a dropped response — returns the
     same results and writes nothing again. */
  env._log.length = 0;
  const again = await post(end, env, 'mod', { code: 'LBAA' });
  check('a repeated end still succeeds', again.status, 200);
  check('and says it was already ended', again.data.alreadyEnded, true);
  check('with the same standings', again.data.standings, e.data.standings);
  check('and touches neither the board nor the settle', env._log, []);
}

{
  /* Best score kept across games, never lowered; a higher one raises it. */
  const env = makeEnv({ moderators: ['101'] });
  env._store.set('lb_bingo', JSON.stringify([{ id: '303', name: 'Old', score: 3, updatedAt: 1 }]));

  await post(create, env, 'mod', { code: 'LBBB' });
  const j = await post(join, env, 'p1', { code: 'LBBB', name: 'PlayerOne' });
  for (const id of j.data.cardIds.slice(0, 5)) await post(call, env, 'mod', { code: 'LBBB', eventId: id });
  await post(end, env, 'mod', { code: 'LBBB' });
  check('a lower game does not lower the best score', board(env).find(r => r.id === '303').score, 3);
  check('but the name is refreshed', board(env).find(r => r.id === '303').name, 'PlayerOne');

  await post(create, env, 'mod', { code: 'LBBC' });
  const j2 = await post(join, env, 'p1', { code: 'LBBC', name: 'PlayerOne' });
  for (const id of j2.data.cardIds.filter(Boolean)) await post(call, env, 'mod', { code: 'LBBC', eventId: id });
  await post(end, env, 'mod', { code: 'LBBC' });
  check('a blackout raises it to 14', board(env).find(r => r.id === '303').score, 14);
  check('and there is still one row for the player', board(env).filter(r => r.id === '303').length, 1);
}

{
  /* Wildcard stamps and extra cards count — from the room, not the client. */
  const env = makeEnv({ moderators: ['101'] });
  await post(create, env, 'mod', { code: 'LBWC' });
  await post(join, env, 'p1', { code: 'LBWC', name: 'PlayerOne' });
  const g = room(env, 'LBWC');
  const second = join.generateCard();
  g.players[0].cards.push(second);
  g.players[0].wildcards = [{ cardIndex: 1, eventId: second[0] }];
  setRoom(env, 'LBWC', g);
  for (const id of second.slice(1, 5)) await post(call, env, 'mod', { code: 'LBWC', eventId: id });
  const e = await post(end, env, 'mod', { code: 'LBWC' });
  check('a stamp completing a row on the second card counts', e.data.standings[0].bingos >= 1, true);
  check('and reaches the board', board(env).find(r => r.id === '303').score, e.data.standings[0].bingos);
  check('cards and stamps are reported for the host', [e.data.standings[0].cardCount, e.data.standings[0].wildcardsUsed], [2, 1]);
}

{
  /* A viewer-hosted room plays normally but never touches the prize board:
     otherwise opening a room, joining it and calling every square is a
     blackout on demand. */
  const env = makeEnv({ moderators: ['101'] });
  await post(create, env, 'viewer', { code: 'LBVV' });
  const j = await post(join, env, 'p1', { code: 'LBVV', name: 'PlayerOne' });
  for (const id of j.data.cardIds.filter(Boolean)) await post(call, env, 'viewer', { code: 'LBVV', eventId: id });
  const e = await post(end, env, 'viewer', { code: 'LBVV' });
  check('a viewer can end their own room', e.status, 200);
  check('and still sees the standings', e.data.standings[0].bingos, 14);
  check('but nothing is written to lb_bingo', env._store.has('lb_bingo'), false);
  check('and boardWritten says so', e.data.boardWritten, false);
}

{
  /* The client POST is gone from the player page. */
  const cb = fs.readFileSync(path.join(REPO, 'games/commander-bingo/index.html'), 'utf8');
  check('index.html no longer POSTs to /api/leaderboards', cb.includes('/api/leaderboards'), false);
}

/* ── End / call / state refusals the host page relies on ────────────── */
{
  const env = makeEnv({ moderators: ['101'] });
  check('ending with no session is 401 (re-login), not 403', (await post(end, env, null, { code: 'NOPE' })).status, 401);
  check('ending a room that is gone is 404', (await post(end, env, 'mod', { code: 'NOPE' })).status, 404);
  check('calling into a room that is gone is 404', (await post(call, env, 'mod', { code: 'NOPE', eventId: 1 })).status, 404);
  check('calling with no session is 401', (await post(call, env, null, { code: 'NOPE', eventId: 1 })).status, 401);

  await post(create, env, 'mod', { code: 'STAT' });
  await post(join, env, 'p1', { code: 'STAT', name: 'PlayerOne' });
  await post(join, env, 'p2', { code: 'STAT', name: 'PlayerTwo' });

  const h = await get(env, 'mod', 'code=STAT');
  check('the host gets the live roster', (h.data.roster || []).map(r => r.name).sort(), ['PlayerOne', 'PlayerTwo']);
  check('the roster is counts, not cards', Object.keys(h.data.roster[0]).sort(),
    ['bingos', 'cardCount', 'id', 'marked', 'name', 'wildcardsUsed']);
  check('and the player count', h.data.playerCount, 2);
  const p = await get(env, 'p1', 'code=STAT');
  check('a player gets no roster', p.data.roster, undefined);
  check('nor prizes', p.data.prizes, undefined);
  const a = await get(env, null, 'code=STAT');
  check('anonymous gets no roster', a.data.roster, undefined);

  await post(end, env, 'mod', { code: 'STAT' });
  await post(award, env, 'mod', { code: 'STAT', playerId: 'u_303', rarity: 'rare' });
  const ended = await get(env, 'mod', 'code=STAT');
  check('an ended room is still returned to its host', ended.data.status, 'ended');
  check('with its standings', ended.data.roster.length, 2);
  check('and the prizes already paid', ended.data.prizes, [{ playerId: 'u_303', name: 'PlayerOne', rarity: 'rare', entries: 15 }]);

  const g = room(env, 'STAT');
  check('a call into an ended room is refused', (await post(call, env, 'mod', { code: 'STAT', eventId: 1 })).status, 400);
  check('and does not change it', room(env, 'STAT').calledEvents, g.calledEvents);
}

/* ══ The host page, run for real ═══════════════════════════════════════ */

function stubEl(id) {
  const classes = new Set();
  return {
    id, textContent: '', innerHTML: '', hidden: false, disabled: false, value: '',
    href: '', title: '', className: '', style: {}, dataset: {},
    classList: {
      add: (...c) => c.forEach(x => classes.add(x)),
      remove: (...c) => c.forEach(x => classes.delete(x)),
      toggle: (c, on) => { const v = on === undefined ? !classes.has(c) : !!on; if (v) classes.add(c); else classes.delete(c); return v; },
      contains: (c) => classes.has(c),
    },
    addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; }, focus() {},
  };
}

function loadHost({ storage = {}, routes }) {
  const src = fs.readFileSync(path.join(REPO, 'games/commander-bingo/host.html'), 'utf8');
  const scripts = [...src.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const inline = scripts[scripts.length - 1];
  const events = fs.readFileSync(path.join(REPO, 'games/commander-bingo/events.js'), 'utf8');

  const els = new Map();
  const el = (id) => { if (!els.has(id)) els.set(id, stubEl(id)); return els.get(id); };
  ['createScreen', 'hostScreen', 'resultsScreen'].forEach(id => el(id));
  el('createScreen').classList.add('active');

  const store = new Map(Object.entries(storage));
  const requests = [];
  const ctx = {
    console, JSON, Math, Date, Set, Map, Promise, Array, Object, String, Number, Error, encodeURIComponent, URL,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    confirm: () => true, alert: () => {},
    location: { pathname: '/games/commander-bingo/host.html', search: '', href: 'https://t.local/games/commander-bingo/host.html' },
    navigator: { clipboard: { writeText: async () => {} } },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    document: {
      hidden: false,
      getElementById: el,
      querySelector: () => null,
      querySelectorAll: (sel) => (sel === '.screen' ? ['createScreen', 'hostScreen', 'resultsScreen'].map(el) : []),
      createElement: () => {
        const d = { _t: '' };
        Object.defineProperty(d, 'textContent', { set(v) { d._t = String(v); } });
        Object.defineProperty(d, 'innerHTML', { get() { return d._t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); } });
        return d;
      },
      addEventListener() {},
      documentElement: { setAttribute() {}, removeAttribute() {} },
    },
    addEventListener() {},
    fetch: async (url, opts = {}) => {
      const body = opts.body ? JSON.parse(opts.body) : null;
      requests.push({ url, body });
      const r = await routes(url, body, requests.length);
      if (r === 'network') throw new TypeError('Failed to fetch');
      return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.data || {} };
    },
  };
  ctx.window = ctx;
  ctx.window.parent = ctx;
  vm.createContext(ctx);
  vm.runInContext(events, ctx);
  vm.runInContext(inline, ctx);
  const screen = () => ['createScreen', 'hostScreen', 'resultsScreen'].find(id => el(id).classList.contains('active'));
  const ev = (expr) => vm.runInContext(expr, ctx);
  return { ctx, el, store, requests, screen, ev };
}

const tick = () => new Promise(r => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 10; i++) await tick(); };

/* Create: a 409 retries ONCE with a different code. */
{
  const h = loadHost({ routes: (url, body, n) => {
    if (url.startsWith('/api/bingo/create')) return n === 1 ? { status: 409, data: { error: 'Code already in use' } } : { status: 200, data: { success: true, onOverlay: false } };
    return { status: 200, data: { status: 'active', isHost: true, roster: [], calledEvents: [], playerCount: 0 } };
  } });
  await h.ctx.createGame(); await settle();
  const creates = h.requests.filter(r => r.url.startsWith('/api/bingo/create'));
  check('create: a 409 is retried once', creates.length, 2);
  ok('create: with a new code', creates[0].body.code !== creates[1].body.code);
  check('create: then lands on the host panel', h.screen(), 'hostScreen');
  check('create: in API mode', h.ev('useApi'), true);
  check('create: remembering the code that actually succeeded', h.store.get('bingo_host_code'), creates[1].body.code);
  ok('create: and starts polling the room', h.requests.some(r => r.url.startsWith('/api/bingo/state')));
}

{
  const h = loadHost({ routes: (url) => url.startsWith('/api/bingo/create') ? { status: 409, data: {} } : { status: 200, data: {} } });
  await h.ctx.createGame(); await settle();
  check('create: two collisions stop after the retry', h.requests.filter(r => r.url.startsWith('/api/bingo/create')).length, 2);
  check('create: and stay on the create screen', h.screen(), 'createScreen');
  check('create: with no local room', [...h.store.keys()].some(k => k.startsWith('bingo_game_')), false);
  check('create: and no saved host code', h.store.has('bingo_host_code'), false);
  check('create: and the error is shown', h.el('authMsg').hidden, false);
}

{
  const h = loadHost({ routes: () => ({ status: 503, data: { error: 'Service unavailable' } }) });
  await h.ctx.createGame(); await settle();
  check('create: a 5xx does NOT go local', [...h.store.keys()].some(k => k.startsWith('bingo_game_')), false);
  check('create: stays on the create screen', h.screen(), 'createScreen');
  ok('create: and says what happened', /503/.test(h.el('authMsg').textContent));
  check('create: a 5xx is not offered a login', h.el('loginBtn').hidden, true);
}

{
  const h = loadHost({ routes: () => ({ status: 401, data: { error: 'Log in with Twitch to host a game.' } }) });
  await h.ctx.createGame(); await settle();
  check('create: a 401 offers the login', h.el('loginBtn').hidden, false);
  check('create: and stays put', h.screen(), 'createScreen');
}

{
  const h = loadHost({ routes: () => 'network' });
  await h.ctx.createGame(); await settle();
  check('create: only an unreachable server falls back to local', h.ev('useApi'), false);
  check('create: on the host panel', h.screen(), 'hostScreen');
  check('create: and the host is TOLD it is local', h.el('hostError').hidden, false);
  ok('create: in so many words', /LOCAL/.test(h.el('hostErrorText').textContent));
}

/* Call: a refusal is reverted and explained. */
async function apiHost(callReply) {
  const h = loadHost({ routes: (url) => {
    if (url.startsWith('/api/bingo/create')) return { status: 200, data: { success: true, onOverlay: true } };
    if (url.startsWith('/api/bingo/call')) return callReply();
    if (url.startsWith('/api/bingo/end')) return h._endReply ? h._endReply() : { status: 200, data: {} };
    return { status: 200, data: { status: 'active', isHost: true, roster: [], calledEvents: h._called || [], playerCount: 0 } };
  } });
  await h.ctx.createGame(); await settle();
  return h;
}

{
  const h = await apiHost(() => ({ status: 401, data: { error: 'Your login has expired.' } }));
  await h.ctx.toggleEvent(7);
  check('call 401: the square is put back', h.ev('calledEvents.has(7)'), false);
  check('call 401: the count is put back', h.el('calledCount').textContent, 0);
  check('call 401: an error is shown', h.el('hostError').hidden, false);
  check('call 401: with a re-login', h.el('hostErrorLogin').hidden, false);
  ok('call 401: saying the square was not called', /NOT called/.test(h.el('hostErrorText').textContent));
}

{
  const h = await apiHost(() => ({ status: 404, data: { error: 'Game not found' } }));
  await h.ctx.toggleEvent(7);
  check('call 404: reverted', h.ev('calledEvents.has(7)'), false);
  ok('call 404: says the room is gone', /no longer exists/.test(h.el('hostErrorText').textContent));
  check('call 404: offers a way back', h.el('hostErrorBack').hidden, false);
  check('call 404: no re-login (it would not help)', h.el('hostErrorLogin').hidden, true);
}

{
  const h = await apiHost(() => 'network');
  await h.ctx.toggleEvent(7);
  check('call offline: reverted', h.ev('calledEvents.has(7)'), false);
  ok('call offline: says so', /Could not reach/.test(h.el('hostErrorText').textContent));
}

{
  const h = await apiHost(() => ({ status: 200, data: { success: true, calledEvents: [7] } }));
  await h.ctx.toggleEvent(7);
  check('call ok: the square stays called', h.ev('calledEvents.has(7)'), true);
  check('call ok: no error', h.el('hostError').hidden, true);
  await h.ctx.toggleEvent(7);
  ok('call ok: an undo sends uncall', h.requests.filter(r => r.url === '/api/bingo/call').pop().body.action === 'uncall');
}

/* Poll: the live count/roster, and the server's called list wins. */
{
  const h = await apiHost(() => ({ status: 200, data: {} }));
  h._called = [3, 9];
  h.ctx.fetch = async () => ({ ok: true, status: 200, json: async () => ({
    status: 'active', isHost: true, playerCount: 2, calledEvents: [3, 9],
    roster: [{ id: 'u_1', name: 'Alice', bingos: 1, marked: 7 }, { id: 'u_2', name: '<b>Eve</b>', bingos: 0, marked: 3 }],
  }) });
  await h.ctx.pollRoom();
  check('poll: shows the live player count', h.el('playerCount').textContent, 2);
  check('poll: shows the roster', h.el('roster').hidden, false);
  ok('poll: with names', /Alice/.test(h.el('rosterList').innerHTML));
  ok('poll: escaped', !/<b>Eve/.test(h.el('rosterList').innerHTML));
  check('poll: adopts the server called list', h.ev('[...calledEvents].sort((a,b)=>a-b)'), [3, 9]);

  h.ctx.fetch = async () => ({ ok: true, status: 200, json: async () => ({ status: 'active', playerCount: 2, calledEvents: [3, 9] }) });
  await h.ctx.pollRoom();
  check('poll: a lapsed session is flagged', h.el('hostError').hidden, false);
  check('poll: with a re-login', h.el('hostErrorLogin').hidden, false);
  h.ctx.fetch = async () => ({ ok: true, status: 200, json: async () => ({ status: 'active', isHost: true, playerCount: 2, calledEvents: [3, 9], roster: [] }) });
  await h.ctx.pollRoom();
  check('poll: and cleared once the session is back', h.el('hostError').hidden, true);

  h.ctx.fetch = async () => ({ ok: false, status: 404, json: async () => ({ error: 'Game not found' }) });
  await h.ctx.pollRoom();
  ok('poll: a vanished room is flagged', /no longer exists/.test(h.el('hostErrorText').textContent));
}

/* End: a failure keeps everything; success keeps the code for awards. */
{
  const h = await apiHost(() => ({ status: 200, data: {} }));
  const code = h.store.get('bingo_host_code');
  h._endReply = () => ({ status: 500, data: { error: 'Database unavailable' } });
  await h.ctx.endGame();
  check('end 500: the saved code is kept', h.store.get('bingo_host_code'), code);
  check('end 500: still on the host panel', h.screen(), 'hostScreen');
  ok('end 500: told it is still live', /NOT ended/.test(h.el('hostErrorText').textContent));

  h._endReply = () => 'network';
  await h.ctx.endGame();
  check('end offline: the saved code is kept', h.store.get('bingo_host_code'), code);
  check('end offline: still on the host panel', h.screen(), 'hostScreen');

  h._endReply = () => ({ status: 200, data: {
    success: true,
    standings: [{ id: 'u_303', name: 'PlayerOne', bingos: 2, marked: 12, cardCount: 1, wildcardsUsed: 0 },
                { id: 'u_304', name: 'PlayerTwo', bingos: 0, marked: 5, cardCount: 1, wildcardsUsed: 0 }],
    prizes: [],
  } });
  await h.ctx.endGame();
  check('end ok: results shown', h.screen(), 'resultsScreen');
  check('end ok: the code is KEPT for the award screen', h.store.get('bingo_host_code'), code);
  ok('end ok: from the server standings', /PlayerOne/.test(h.el('lbBody').innerHTML));
  ok('end ok: not "No players"', !/No players/.test(h.el('lbBody').innerHTML));

  h.ctx.backToCreate();
  check('leaving the results drops the code', h.store.has('bingo_host_code'), false);
}

/* Resume: an ended room comes back to its award screen, paid rows marked. */
{
  const h = loadHost({
    storage: { bingo_host_code: 'ENDD' },
    routes: () => ({ status: 200, data: {
      code: 'ENDD', status: 'ended', isHost: true, calledEvents: [1, 2, 3],
      roster: [{ id: 'u_303', name: 'PlayerOne', bingos: 2, marked: 12, cardCount: 1, wildcardsUsed: 0 },
               { id: 'u_304', name: 'PlayerTwo', bingos: 1, marked: 9, cardCount: 1, wildcardsUsed: 0 }],
      prizes: [{ playerId: 'u_303', name: 'PlayerOne', rarity: 'rare', entries: 15 }],
    } }),
  });
  await settle();
  check('resume ended: the award screen is back', h.screen(), 'resultsScreen');
  check('resume ended: the code is kept', h.store.get('bingo_host_code'), 'ENDD');
  ok('resume ended: the paid player shows as paid', /lb-award-done">Rare · \+15/.test(h.el('lbBody').innerHTML));
  check('resume ended: and only the unpaid player keeps an Award button',
    (h.el('lbBody').innerHTML.match(/lb-award-btn/g) || []).length, 1);
}

{
  const h = loadHost({
    storage: { bingo_host_code: 'ENDD' },
    routes: () => ({ status: 200, data: { code: 'ENDD', status: 'ended', calledEvents: [] } }),
  });
  await settle();
  check('resume ended, logged out: the code is kept for after login', h.store.get('bingo_host_code'), 'ENDD');
  check('resume ended, logged out: the login is offered', h.el('loginBtn').hidden, false);
}

{
  const h = loadHost({
    storage: { bingo_host_code: 'LIVE' },
    routes: () => ({ status: 200, data: {
      code: 'LIVE', status: 'active', isHost: true, calledEvents: [4], playerCount: 3, onOverlay: true,
      roster: [{ id: 'u_1', name: 'A', bingos: 0, marked: 2 }],
    } }),
  });
  await settle();
  check('resume active: the panel is back', h.screen(), 'hostScreen');
  check('resume active: with the live count', h.el('playerCount').textContent, 3);
  check('resume active: and the roster', h.el('roster').hidden, false);
}

{
  const h = loadHost({ storage: { bingo_host_code: 'GONE' }, routes: () => ({ status: 404, data: {} }) });
  await settle();
  check('resume gone: a room the server no longer has drops the code', h.store.has('bingo_host_code'), false);
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[bingo-recovery] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[bingo-recovery] ${passed} assertions passed.`);
console.log('');
