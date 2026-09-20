#!/usr/bin/env node
/* ══════════════════════════════════════════════
   COMMANDER BINGO — the overlay parity with MTGBBB

     node server/scripts/test-commander-bingo-overlay.js

   MTGBBB has two overlay halves: a standing panel that finds its own live
   room and shows progress + who's winning, and alerts pushed to the shared
   queue for each pull and each bingo. This gives Commander Bingo the same
   shape. The game has no per-player score, so "who's winning" is the winners
   board (whoever the host awarded), and the two alerts are a square being
   called and a prize being awarded. These tests are that contract:

     - create points bingo_current at the room; end takes it down, but only
       if it still names that room;
     - state?current=1 resolves the live room and carries the panel summary;
     - a genuinely new call pushes exactly one bingo-call alert — never an
       uncall, never a re-call;
     - awarding a prize pushes a bingo-win alert;
     - the client wiring (overlay describe, panel, sample) is present.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { onRequestPost as create } from '../../functions/api/bingo/create.js';
import { onRequestPost as call } from '../../functions/api/bingo/call.js';
import { onRequestPost as award } from '../../functions/api/bingo/award.js';
import { onRequestPost as end } from '../../functions/api/bingo/end.js';
import { onRequestPost as overlay } from '../../functions/api/bingo/overlay.js';
import { onRequestGet as state } from '../../functions/api/bingo/state.js';

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

function fakeKV(seed = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    store,
    read(k) { return store.has(k) ? JSON.parse(store.get(k)) : null; },
    async get(k, t) { const v = store.get(k); return v === undefined ? null : (t === 'json' ? JSON.parse(v) : v); },
    async put(k, v) { store.set(k, String(v)); },
    async delete(k) { store.delete(k); },
    async mutate(k, fn) {
      const cur = store.has(k) ? JSON.parse(store.get(k)) : null;
      const out = await fn(cur);
      if (out === undefined) return;
      store.set(k, JSON.stringify(out));
    },
  };
}

const HOST = '555';
const cookie = (id) => ({ Cookie: 'pham_session=' + encodeURIComponent(JSON.stringify({ user_id: id, display_name: 'U' + id })) });
const POST = (fn, e, body, h) => fn({ env: e, request: new Request('https://x/api/bingo', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(body) }) });
const GET = (e, qs, h) => state({ env: e, request: new Request('https://x/api/bingo/state?' + qs, {
  method: 'GET', headers: { ...h } }) });

/* The host is also the broadcaster, so award's moderator gate passes without
   a moderator list to seed. */
const envWith = (seed) => ({ MARKETPLACE: fakeKV(seed), TWITCH_BROADCASTER_ID: HOST });
const events = (e) => { const r = e.MARKETPLACE.read('overlay_events'); return (r && r.events) || []; };
const ofType = (e, t) => events(e).filter(ev => ev.type === t);

/* ══ create points the overlay at the room ═════════════════════════════ */
{
  const e = envWith();
  const res = await (await POST(create, e, { code: 'aaa' }, cookie(HOST))).json();
  check('create succeeds', res.success, true);
  check('and bingo_current names the room', e.MARKETPLACE.read('bingo_current').code, 'AAA');
}

/* ══ state?current=1 resolves the live room and carries the summary ════ */
{
  const e = envWith();
  const miss = await GET(e, 'current=1');
  check('current with no game running is 404', miss.status, 404);
}
{
  const e = envWith();
  await POST(create, e, { code: 'aaa' }, cookie(HOST));
  const g = await (await GET(e, 'current=1')).json();
  check('current resolves the room code', g.code, 'AAA');
  check('the panel total is the full square count', g.total, 68);
  check('with nothing called yet', g.calledCount, 0);
  check('no players yet', g.playerCount, 0);
  check('and no winners yet', g.winners, []);
  check('a fresh game shows on the overlay by default', g.showOnOverlay, true);
}

/* ══ isHost: the host is told, so a dropped connection can resume ══════ */
{
  const e = envWith();
  await POST(create, e, { code: 'aaa' }, cookie(HOST));
  const asHost = await (await GET(e, 'code=AAA', cookie(HOST))).json();
  check('state tells the host they are the host', asHost.isHost, true);
  const asOther = await (await GET(e, 'code=AAA', cookie('999'))).json();
  /* Explicit false, not merely absent — the host page needs to tell a real
     "not the host" apart from an older server that never sent the field. */
  check('and tells a logged-in non-host they are not', asOther.isHost, false);
  const anon = await (await GET(e, 'code=AAA')).json();
  ok('an anonymous poll is told nothing either way', anon.isHost === undefined);
}

/* ══ Show-on-overlay toggle — host only, gates panel and alerts ════════ */
{
  const e = envWith();
  await POST(create, e, { code: 'aaa' }, cookie(HOST));

  /* A stranger cannot flip it. */
  const denied = await POST(overlay, e, { code: 'aaa', show: false }, cookie('999'));
  check('a non-host cannot change the overlay', denied.status, 403);

  /* The host switches it off. */
  const off = await (await POST(overlay, e, { code: 'aaa', show: false }, cookie(HOST))).json();
  check('the host can switch it off', off.showOnOverlay, false);
  check('and the panel state reflects it', (await (await GET(e, 'current=1')).json()).showOnOverlay, false);

  /* With it off, a call pushes NO alert. */
  await POST(call, e, { code: 'aaa', eventId: 3, action: 'call', text: 'Someone tutors' }, cookie(HOST));
  check('a call with the overlay off pushes no alert', ofType(e, 'bingo-call').length, 0);

  /* Back on, and calls alert again. */
  await POST(overlay, e, { code: 'aaa', show: true }, cookie(HOST));
  await POST(call, e, { code: 'aaa', eventId: 7, action: 'call', text: 'Land destruction' }, cookie(HOST));
  check('a call with the overlay on pushes the alert', ofType(e, 'bingo-call').length, 1);
}

/* ══ The broadcaster/moderator can toggle from Bot Control ═════════════ */
{
  /* A game hosted by someone else entirely. */
  const e = envWith();
  await POST(create, e, { code: 'aaa' }, cookie('111'));

  /* The broadcaster (HOST is the broadcaster id here) is not this game's
     host, but produces the stream — so they may flip the switch. */
  const byBroadcaster = await POST(overlay, e, { code: 'aaa', show: false }, cookie(HOST));
  check('the broadcaster can toggle a game they did not host', byBroadcaster.status, 200);

  /* A random logged-in stranger still cannot. */
  const byStranger = await POST(overlay, e, { code: 'aaa', show: true }, cookie('999'));
  check('a stranger still cannot', byStranger.status, 403);
}

/* ══ A win alert is suppressed while the overlay is off ════════════════ */
{
  const e = envWith();
  await POST(create, e, { code: 'aaa' }, cookie(HOST));
  await POST(overlay, e, { code: 'aaa', show: false }, cookie(HOST));
  const game = e.MARKETPLACE.read('bingo_AAA');
  game.players = [{ id: 'u_777', name: 'Winner777' }];
  await e.MARKETPLACE.put('bingo_AAA', JSON.stringify(game));

  await POST(award, e, { code: 'aaa', playerId: 'u_777', rarity: 'rare' }, cookie(HOST));
  check('a win with the overlay off pushes no alert', ofType(e, 'bingo-win').length, 0);
}

/* ══ a new call pushes exactly one alert; uncall/re-call push none ═════ */
{
  const e = envWith();
  await POST(create, e, { code: 'aaa' }, cookie(HOST));

  await POST(call, e, { code: 'aaa', eventId: 12, action: 'call', text: 'Sol Ring on turn 1' }, cookie(HOST));
  check('a new call pushes one bingo-call alert', ofType(e, 'bingo-call').length, 1);
  check('carrying the square label', ofType(e, 'bingo-call')[0].label, 'Sol Ring on turn 1');
  check('and the running progress', ofType(e, 'bingo-call')[0].called, 1);

  /* The panel reads the called squares off the state to show the game in
     progress; the ids are there, and the overlay names them from events.js. */
  const live = await (await GET(e, 'current=1')).json();
  check('state carries the called square ids for the board', live.calledEvents, [12]);
  check('and the called count advanced', live.calledCount, 1);

  await POST(call, e, { code: 'aaa', eventId: 12, action: 'call', text: 'Sol Ring on turn 1' }, cookie(HOST));
  check('re-calling the same square pushes nothing new', ofType(e, 'bingo-call').length, 1);

  await POST(call, e, { code: 'aaa', eventId: 12, action: 'uncall' }, cookie(HOST));
  check('an uncall pushes nothing', ofType(e, 'bingo-call').length, 1);

  /* Only the host may call — a stranger's call is refused and silent. */
  const outsider = await POST(call, e, { code: 'aaa', eventId: 5, action: 'call', text: 'x' }, cookie('999'));
  check('a non-host call is refused', outsider.status, 403);
  check('and pushes no alert', ofType(e, 'bingo-call').length, 1);
}

/* ══ awarding a prize pushes a win alert ═══════════════════════════════ */
{
  const e = envWith();
  await POST(create, e, { code: 'aaa' }, cookie(HOST));
  /* Seat a real logged-in player so the award has someone to credit. */
  const game = e.MARKETPLACE.read('bingo_AAA');
  game.players = [{ id: 'u_777', name: 'Winner777' }];
  await e.MARKETPLACE.put('bingo_AAA', JSON.stringify(game));

  const res = await (await POST(award, e, { code: 'aaa', playerId: 'u_777', rarity: 'mythic' }, cookie(HOST))).json();
  check('the award succeeds', res.success, true);
  const wins = ofType(e, 'bingo-win');
  check('and pushes one bingo-win alert', wins.length, 1);
  check('naming the winner', wins[0].who, 'Winner777');
  check('with the prize rarity', wins[0].rarity, 'mythic');

  /* The winner now shows on the panel summary. */
  const g = await (await GET(e, 'current=1')).json();
  check('the winners board carries the awarded player', g.winners, [{ name: 'Winner777', rarity: 'mythic' }]);
}

/* ══ end clears the pointer — but only if it still names this room ═════ */
{
  const e = envWith();
  await POST(create, e, { code: 'aaa' }, cookie(HOST));
  await POST(end, e, { code: 'aaa' }, cookie(HOST));
  check('ending the current game clears the pointer', e.MARKETPLACE.read('bingo_current'), null);
}
{
  const e = envWith();
  await POST(create, e, { code: 'aaa' }, cookie(HOST));
  /* A newer game opened and claimed the pointer. */
  await e.MARKETPLACE.put('bingo_current', JSON.stringify({ code: 'BBB', at: Date.now() }));
  await POST(end, e, { code: 'aaa' }, cookie(HOST));
  check('ending an old game does not steal the newer pointer', e.MARKETPLACE.read('bingo_current').code, 'BBB');
}

/* ══ Wiring ════════════════════════════════════════════════════════════ */
{
  const overlay = fs.readFileSync(path.join(REPO, 'js/pages/overlay.js'), 'utf8');
  ok('overlay describes the call alert', /ev\.type === 'bingo-call'/.test(overlay));
  ok('overlay describes the win alert', /ev\.type === 'bingo-win'/.test(overlay));

  const html = fs.readFileSync(path.join(REPO, 'overlay.html'), 'utf8');
  ok('the overlay page has the Commander Bingo panel', /id="ovBingo"/.test(html));
  ok('and loads its poller', /overlay-commander-bingo\.js/.test(html));
  ok('the panel has a called-squares board', /id="ovBingoCalled"/.test(html));
  ok('and loads the square texts to name them', /games\/commander-bingo\/events\.js/.test(html));

  const poller = fs.readFileSync(path.join(REPO, 'js/pages/overlay-commander-bingo.js'), 'utf8');
  ok('the panel poller finds its own room', /function[\s\S]*bingo\/state\?current=1/.test(poller));
  ok('the poller names called squares from the shared list', /BINGO_EVENTS/.test(poller) && /function nameFor/.test(poller));
  ok('the poller renders the called board newest-first', /calledEvents[\s\S]*reverse\(\)/.test(poller));
  ok('the poller hides the panel when the host switched it off', /showOnOverlay === false/.test(poller));

  const host = fs.readFileSync(path.join(REPO, 'games/commander-bingo/host.html'), 'utf8');
  ok('the host page has the overlay toggle', /function toggleOverlay/.test(host) && /id="overlayToggleBtn"/.test(host));
  ok('the toggle posts to the host-only route', /\/api\/bingo\/overlay/.test(host));
  ok('the host can resume a dropped connection', /function resumeGame/.test(host) && /resumeGame\(\)/.test(host));
  ok('resume refuses only on an explicit non-host, else restores an active game',
     /g\.isHost === false/.test(host) && /g\.status === 'active'/.test(host));
  ok('resume falls back to a localStorage game when the API has none',
     /function resumeFromLocal/.test(host) && /bingo_game_'\s*\+\s*code/.test(host));
  ok('the hosted room is remembered and cleared', /HOST_CODE_KEY/.test(host) && /function clearHostCode/.test(host));

  const samples = fs.readFileSync(path.join(REPO, 'js/pages/overlay-samples.js'), 'utf8');
  ok('layout mode knows the panel', /id: 'ovBingo'/.test(samples) && /function bingo\(\)/.test(samples));
  ok('and the sample fills the called board', /ovBingoCalled/.test(samples));

  const reg = fs.readFileSync(path.join(REPO, 'server/lib/registry.js'), 'utf8');
  ok('bingo_current is a singleton (matched before the bingo_ family)',
     /bingo_current:\s*\{ table: 'singletons'/.test(reg));

  const css = fs.readFileSync(path.join(REPO, 'css/pages/overlay.css'), 'utf8');
  ok('the panel has styles', /\.ov-bingo\s*\{/.test(css));

  ok('the host sends the square text with a call', /text:\s*\(BINGO_EVENTS\.find/.test(host));

  const bcHtml = fs.readFileSync(path.join(REPO, 'bot-control.html'), 'utf8');
  ok('bot control has the bingo overlay section', /id="ovBingoSection"/.test(bcHtml) && /id="ovBingoShowBtn"/.test(bcHtml));

  const bcJs = fs.readFileSync(path.join(REPO, 'js/pages/bot-control.js'), 'utf8');
  ok('bot control wires the bingo overlay switch', /function initOvBingo/.test(bcJs) && /initOvBingo\(\)/.test(bcJs));
  ok('and it reads the live room then posts the switch', /bingo\/state\?current=1/.test(bcJs) && /\/api\/bingo\/overlay/.test(bcJs));
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[bingo-overlay] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[bingo-overlay] ${passed} assertions passed.`);
console.log('');
