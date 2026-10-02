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
    /* end.js settles last month before writing lb_bingo. */
    async claimMonthlyAward() { return false; },
    async listValues({ prefix } = {}) {
      const out = [];
      for (const [k, v] of store) {
        if (prefix && !k.startsWith(prefix)) continue;
        /* bingo_current is a singleton in a different table — the real DAL's
           prefix listing never returns it. */
        if (k === 'bingo_current') continue;
        out.push({ name: k, value: JSON.parse(v) });
      }
      return out;
    },
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
const liveCode = (e) => (e.MARKETPLACE.read('bingo_current') || {}).code || null;
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
  check('ending the current game clears the pointer', liveCode(e), null);
  check('but remembers the room it ended on, for the prize alerts', e.MARKETPLACE.read('bingo_current').ended, 'AAA');
}
{
  const e = envWith();
  await POST(create, e, { code: 'aaa' }, cookie(HOST));
  /* A newer game opened and claimed the pointer. */
  await e.MARKETPLACE.put('bingo_current', JSON.stringify({ code: 'BBB', at: Date.now() }));
  await POST(end, e, { code: 'aaa' }, cookie(HOST));
  check('ending an old game does not steal the newer pointer', e.MARKETPLACE.read('bingo_current').code, 'BBB');
}

/* ══ ?list=1 — the dashboard room picker ═══════════════════════════════ */
{
  const e = envWith();
  await POST(create, e, { code: 'aaa' }, cookie('111'));  /* a viewer's room: no pointer */
  await POST(create, e, { code: 'bbb' }, cookie(HOST));   /* staff room claims it -> BBB */

  const anon = await GET(e, 'list=1');
  check('listing without a session is 401', anon.status, 401);

  const stranger = await GET(e, 'list=1', cookie('999'));
  check('a stranger who hosts no room cannot list', stranger.status, 403);

  const asMod = await (await GET(e, 'list=1', cookie(HOST))).json(); /* HOST is broadcaster */
  check('the broadcaster gets both active rooms', asMod.rooms.length, 2);
  check('the newest room is marked current', asMod.rooms.find(r => r.code === 'BBB').isCurrent, true);
  check('the other is not current', asMod.rooms.find(r => r.code === 'AAA').isCurrent, false);
  check('and the current room sorts first', asMod.rooms[0].code, 'BBB');
  check('each row carries the host name', asMod.rooms.find(r => r.code === 'AAA').hostName, 'U111');
  check('and whether its host has it switched on', asMod.rooms.find(r => r.code === 'BBB').showOnOverlay, true);

  /* A non-moderator host may still list — they host a room. */
  const asHost = await GET(e, 'list=1', cookie('111'));
  check('a room host (non-mod) may list', asHost.status, 200);
}
{
  /* Ended games are left out. */
  const e = envWith();
  await POST(create, e, { code: 'aaa' }, cookie(HOST));
  await POST(end, e, { code: 'aaa' }, cookie(HOST));
  const d = await (await GET(e, 'list=1', cookie(HOST))).json();
  check('an ended game is not listed', d.rooms.length, 0);
}

/* ══ makeCurrent repoints the overlay; clear takes it down ═════════════ */
{
  const e = envWith();
  await POST(create, e, { code: 'aaa' }, cookie(HOST));   /* bingo_current -> AAA */
  await POST(create, e, { code: 'bbb' }, cookie('111'));  /* a viewer's room — pointer stays AAA */
  check('a viewer room does not take the pointer', liveCode(e), 'AAA');
  await POST(overlay, e, { code: 'bbb', makeCurrent: true }, cookie(HOST));
  check('the broadcaster can put it on stream', liveCode(e), 'BBB');

  /* Point it back at AAA. */
  const res = await (await POST(overlay, e, { code: 'aaa', makeCurrent: true }, cookie(HOST))).json();
  check('makeCurrent reports the room', res.code, 'AAA');
  check('and turns that room on', res.showOnOverlay, true);
  check('bingo_current now names AAA', e.MARKETPLACE.read('bingo_current').code, 'AAA');
  check('and AAA shows on the overlay', e.MARKETPLACE.read('bingo_AAA').showOnOverlay, true);
  check('state?current=1 follows the repoint', (await (await GET(e, 'current=1')).json()).code, 'AAA');

  /* The broadcaster may repoint a game they did not host. */
  const byBroadcaster = await POST(overlay, e, { code: 'bbb', makeCurrent: true }, cookie(HOST));
  check('the broadcaster can repoint to another host\'s game', byBroadcaster.status, 200);
  check('and the pointer followed', e.MARKETPLACE.read('bingo_current').code, 'BBB');

  /* A stranger cannot repoint. */
  const byStranger = await POST(overlay, e, { code: 'aaa', makeCurrent: true }, cookie('999'));
  check('a stranger cannot repoint', byStranger.status, 403);
}
{
  const e = envWith();
  await POST(create, e, { code: 'aaa' }, cookie(HOST));
  const cleared = await (await POST(overlay, e, { clear: true }, cookie(HOST))).json();
  check('clear succeeds', cleared.cleared, true);
  check('and points bingo_current at nothing', liveCode(e), null);

  /* makeCurrent with no code is treated as a clear. */
  await POST(create, e, { code: 'ccc' }, cookie(HOST));  /* pointer -> CCC */
  await POST(overlay, e, { makeCurrent: true, code: '' }, cookie(HOST));
  check('makeCurrent with no room clears too', liveCode(e), null);

  /* A stranger cannot clear. */
  await POST(create, e, { code: 'ddd' }, cookie(HOST));
  const byStranger = await POST(overlay, e, { clear: true }, cookie('999'));
  check('a stranger cannot clear', byStranger.status, 403);
}

/* ══ N9 — a viewer's room never takes the overlay ══════════════════════ */
const seatWinner = async (e, code) => {
  const g = e.MARKETPLACE.read('bingo_' + code);
  g.players = [{ id: 'u_777', name: 'Winner777' }];
  await e.MARKETPLACE.put('bingo_' + code, JSON.stringify(g));
};
{
  const MOD = '444';
  const e = envWith({ site_moderators: { entries: [{ userId: MOD, name: 'Mod', addedBy: 'test' }] } });

  const viewer = await (await POST(create, e, { code: 'vvv' }, cookie('999'))).json();
  check('a non-staff login can still host a room', viewer.success, true);
  check('but it does not take bingo_current', e.MARKETPLACE.read('bingo_current'), null);
  check('and the host is told it is not on stream', viewer.onOverlay, false);

  const asHostOfV = await (await GET(e, 'code=VVV', cookie('999'))).json();
  check('state tells that host the room is not on the overlay', asHostOfV.onOverlay, false);
  ok('and players are not told at all', (await (await GET(e, 'code=VVV')).json()).onOverlay === undefined);

  const mod = await (await POST(create, e, { code: 'mmm' }, cookie(MOD))).json();
  check('a site moderator creating a room takes the overlay', liveCode(e), 'MMM');
  check('and is told so', mod.onOverlay, true);

  const again = await (await POST(create, e, { code: 'www' }, cookie('999'))).json();
  check('a later viewer room does not steal it back', liveCode(e), 'MMM');
  check('(created fine)', again.success, true);

  /* The viewer's own calls never reach the stream, even switched "on". */
  await POST(overlay, e, { code: 'vvv', show: true }, cookie('999'));
  await POST(call, e, { code: 'vvv', eventId: 4, action: 'call' }, cookie('999'));
  check('a viewer room call pushes no alert', ofType(e, 'bingo-call').length, 0);

  /* And a viewer cannot point the overlay at their own room. */
  const self = await POST(overlay, e, { code: 'vvv', makeCurrent: true }, cookie('999'));
  check('a non-staff host cannot makeCurrent their own room', self.status, 403);
  check('so the pointer is untouched', liveCode(e), 'MMM');
}

/* ══ N9 — the call label is the server's, never the body's ═════════════ */
{
  const e = envWith();
  await POST(create, e, { code: 'aaa' }, cookie(HOST));
  await POST(call, e, { code: 'aaa', eventId: 12, action: 'call', text: 'FOLLOW MY CHANNEL <b>now</b>' }, cookie(HOST));
  const alerts = ofType(e, 'bingo-call');
  check('a call pushes one alert', alerts.length, 1);
  check('labelled from the canonical square list, ignoring body.text', alerts[0].label, 'Sol Ring on turn 1');

  await POST(call, e, { code: 'aaa', eventId: 1, action: 'call' }, cookie(HOST));
  check('a call with no text at all still gets the square label', ofType(e, 'bingo-call')[1].label, 'Board wipe played');

  for (const bad of [0, 69, -1, 1.5, '12', null]) {
    const r = await POST(call, e, { code: 'aaa', eventId: bad, action: 'call', text: 'x' }, cookie(HOST));
    check('an unknown eventId is refused: ' + JSON.stringify(bad), r.status, 400);
  }
  check('and refused ids push nothing', ofType(e, 'bingo-call').length, 2);
  check('nor are they recorded', e.MARKETPLACE.read('bingo_AAA').calledEvents, [12, 1]);
}

/* ══ N9 — toggling a square alerts once per square per game ════════════ */
{
  const e = envWith();
  await POST(create, e, { code: 'aaa' }, cookie(HOST));
  for (let i = 0; i < 4; i++) {
    await POST(call, e, { code: 'aaa', eventId: 20, action: 'call' }, cookie(HOST));
    await POST(call, e, { code: 'aaa', eventId: 20, action: 'uncall' }, cookie(HOST));
  }
  await POST(call, e, { code: 'aaa', eventId: 20, action: 'call' }, cookie(HOST));
  check('call/undo x5 pushes exactly one alert', ofType(e, 'bingo-call').length, 1);
  check('the square ends up called', e.MARKETPLACE.read('bingo_AAA').calledEvents, [20]);
  check('and the room remembers it alerted', e.MARKETPLACE.read('bingo_AAA').alertedEvents, [20]);

  await POST(call, e, { code: 'aaa', eventId: 21, action: 'call' }, cookie(HOST));
  check('a different square still alerts', ofType(e, 'bingo-call').length, 2);
}

/* ══ N10 — "None (hide)" silences the room ═════════════════════════════ */
{
  const e = envWith();
  await POST(create, e, { code: 'aaa' }, cookie(HOST));
  await seatWinner(e, 'AAA');
  await POST(overlay, e, { clear: true }, cookie(HOST));
  check('clear turns the cleared room\'s flag off', e.MARKETPLACE.read('bingo_AAA').showOnOverlay, false);

  await POST(call, e, { code: 'aaa', eventId: 3, action: 'call' }, cookie(HOST));
  check('a hidden room posts no call alert', ofType(e, 'bingo-call').length, 0);

  /* Even with its host flipping its own switch back on: it is not current. */
  await POST(overlay, e, { code: 'aaa', show: true }, cookie(HOST));
  await POST(call, e, { code: 'aaa', eventId: 4, action: 'call' }, cookie(HOST));
  check('nor after its host switches it back on', ofType(e, 'bingo-call').length, 0);

  await POST(award, e, { code: 'aaa', playerId: 'u_777', rarity: 'rare' }, cookie(HOST));
  check('and posts no win alert', ofType(e, 'bingo-win').length, 0);
}

/* ══ N10 — switching rooms stops the old room's alerts ═════════════════ */
{
  const e = envWith();
  await POST(create, e, { code: 'aaa' }, cookie(HOST));
  await POST(create, e, { code: 'bbb' }, cookie(HOST));   /* staff create takes over */
  check('a staff create switches the previous room off', e.MARKETPLACE.read('bingo_AAA').showOnOverlay, false);

  await POST(call, e, { code: 'aaa', eventId: 5, action: 'call' }, cookie(HOST));
  check('the replaced room posts no alert', ofType(e, 'bingo-call').length, 0);
  await POST(call, e, { code: 'bbb', eventId: 5, action: 'call' }, cookie(HOST));
  check('the current room does', ofType(e, 'bingo-call').length, 1);

  await POST(overlay, e, { code: 'aaa', makeCurrent: true }, cookie(HOST));
  check('makeCurrent switches the previous room off', e.MARKETPLACE.read('bingo_BBB').showOnOverlay, false);
  check('and the picked room on', e.MARKETPLACE.read('bingo_AAA').showOnOverlay, true);

  await POST(call, e, { code: 'bbb', eventId: 6, action: 'call' }, cookie(HOST));
  check('the old room is silent after the switch', ofType(e, 'bingo-call').length, 1);
  await POST(call, e, { code: 'aaa', eventId: 6, action: 'call' }, cookie(HOST));
  check('the new room alerts', ofType(e, 'bingo-call').length, 2);

  await seatWinner(e, 'BBB');
  await POST(award, e, { code: 'bbb', playerId: 'u_777', rarity: 'rare' }, cookie(HOST));
  check('the old room posts no win alert either', ofType(e, 'bingo-win').length, 0);
}

/* ══ N10 — prizes after the end still alert, until the overlay moves ══ */
{
  const e = envWith();
  await POST(create, e, { code: 'aaa' }, cookie(HOST));
  await seatWinner(e, 'AAA');
  await POST(end, e, { code: 'aaa' }, cookie(HOST));
  await POST(award, e, { code: 'aaa', playerId: 'u_777', rarity: 'mythic' }, cookie(HOST));
  check('a prize awarded on the results screen still alerts', ofType(e, 'bingo-win').length, 1);
}
{
  const e = envWith();
  await POST(create, e, { code: 'aaa' }, cookie(HOST));
  await seatWinner(e, 'AAA');
  await POST(end, e, { code: 'aaa' }, cookie(HOST));
  await POST(overlay, e, { clear: true }, cookie(HOST));
  await POST(award, e, { code: 'aaa', playerId: 'u_777', rarity: 'mythic' }, cookie(HOST));
  check('but not once the overlay was cleared after the end', ofType(e, 'bingo-win').length, 0);
}
{
  const e = envWith();
  await POST(create, e, { code: 'aaa' }, cookie(HOST));
  await seatWinner(e, 'AAA');
  await POST(end, e, { code: 'aaa' }, cookie(HOST));
  await POST(create, e, { code: 'bbb' }, cookie(HOST));
  await POST(award, e, { code: 'aaa', playerId: 'u_777', rarity: 'mythic' }, cookie(HOST));
  check('nor once a newer room took the overlay', ofType(e, 'bingo-win').length, 0);
}

/* ══ N10 — makeCurrent refuses ended and missing rooms ═════════════════ */
{
  const e = envWith();
  await POST(create, e, { code: 'aaa' }, cookie(HOST));
  await POST(create, e, { code: 'bbb' }, cookie(HOST));   /* pointer -> BBB */
  await POST(end, e, { code: 'aaa' }, cookie(HOST));

  const ended = await POST(overlay, e, { code: 'aaa', makeCurrent: true }, cookie(HOST));
  check('makeCurrent on an ended room is refused', ended.status, 409);
  check('the pointer is untouched', liveCode(e), 'BBB');
  check('and the ended room stays off', e.MARKETPLACE.read('bingo_AAA').showOnOverlay, false);

  const missing = await POST(overlay, e, { code: 'zzz', makeCurrent: true }, cookie(HOST));
  check('makeCurrent on a missing room is 404', missing.status, 404);
  check('the pointer is still untouched', liveCode(e), 'BBB');
}

/* ══ N10 — a pointer at a missing room lists as none, and is cleaned ═══ */
{
  const e = envWith();
  await POST(create, e, { code: 'aaa' }, cookie(HOST));
  await e.MARKETPLACE.put('bingo_current', JSON.stringify({ code: 'GONE', at: Date.now() }));
  const d = await (await GET(e, 'list=1', cookie(HOST))).json();
  check('the live room is listed', d.rooms.length, 1);
  check('nothing is marked current', d.rooms.filter(r => r.isCurrent).length, 0);
  check('and the stale pointer is dropped', liveCode(e), null);
  check('so ?current=1 says no game', (await GET(e, 'current=1')).status, 404);
}

/* ══ The server's square list matches the client's ═════════════════════ */
{
  const { BINGO_SQUARES, TOTAL_EVENTS } = await import('../../functions/api/bingo/squares.js');
  const src = fs.readFileSync(path.join(REPO, 'games/commander-bingo/events.js'), 'utf8');
  const client = new Function(src + '; return BINGO_EVENTS;')();
  check('the server square list matches events.js exactly',
    BINGO_SQUARES.map(s => [s.id, s.text]), client.map(c => [c.id, c.text]));
  check('and its total is the square count', TOTAL_EVENTS, client.length);
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

  ok('the host no longer sends square text with a call (the server names it)', !/text:\s*\(BINGO_EVENTS\.find/.test(host));

  const odHtml = fs.readFileSync(path.join(REPO, 'overlay-dashboard.html'), 'utf8');
  ok('the overlay dashboard has the bingo room picker', /id="ovBingoSection"/.test(odHtml) && /id="ovBingoRoomPick"/.test(odHtml));

  const odJs = fs.readFileSync(path.join(REPO, 'js/pages/overlay-dashboard.js'), 'utf8');
  ok('the dashboard wires the bingo room picker', /function initOvBingo/.test(odJs) && /initOvBingo\(\)/.test(odJs));
  ok('and it lists rooms then repoints the overlay', /bingo\/state\?list=1/.test(odJs) && /makeCurrent/.test(odJs));
  ok('with a none option that clears the pointer', /clear:\s*true/.test(odJs) && /none \(hide\)/.test(odJs));
  const renderOvBingoSrc = (odJs.match(/function renderOvBingo\([\s\S]*?\n\}/) || [''])[0];
  ok('the picker preselects the room actually on the overlay',
     /pick\.value = ovBingoLive;/.test(renderOvBingoSrc) && !/const keep\b/.test(renderOvBingoSrc));
  ok('a failed repoint reverts the picker to the live room', /if \(!okay && pick\) pick\.value = ovBingoLive/.test(odJs));
  ok('the refresh tick leaves a focused picker alone', /!force && document\.activeElement === pick/.test(odJs));

  ok('the host overlay switch knows when the room is not on stream', /overlayLive/.test(host) && /created\.onOverlay/.test(host));
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
