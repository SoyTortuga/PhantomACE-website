#!/usr/bin/env node
/* ══════════════════════════════════════════════
   COMMANDER BINGO — `!bingo` VERIFIED IN CHAT (Epic D #9)

     node server/scripts/test-bingo-chat-claim.js

   A viewer types `!bingo`; the server checks THEIR card against the called
   squares and only a genuine bingo verifies. The whole point is that this is
   server-authoritative — the card and the calls both live on the server — so
   these tests are that contract:

     - a chatter with a genuine winning card verifies: an overlay 'bingo-claim'
       event fires and a claim is recorded on the room;
     - a chatter with a non-winning card gets neither — no event, no claim;
     - a chatter with no card in the room gets a helpful, rate-limited reply and
       no claim;
     - `!bingo` when bingo is NOT the game on stream is ignored in silence;
     - the per-chatter rate limit blocks rapid repeats;
     - the win check matches the on-site rule (standings() in end.js) exactly;
     - the wiring (command route, overlay render, toggle, host claim list) is
       present.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { onRequestPost as create } from '../../functions/api/bingo/create.js';
import { verifyBingoClaim, bestBingos } from '../../functions/api/bingo/verify.js';
import { standings } from '../../functions/api/bingo/end.js';
import { readStreamNow, clearStreamNow } from '../../functions/api/stream-now.js';

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

/* A fake KV with per-key serialised mutate, matching the real DAL's
   pg_advisory_xact_lock contract (see test-chat-game.js for why an unlocked
   fake reports a correct implementation as broken). */
function fakeKV(seed = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
  const chains = new Map();
  return {
    store,
    read(k) { return store.has(k) ? JSON.parse(store.get(k)) : null; },
    async get(k, t) { const v = store.get(k); return v === undefined ? null : (t === 'json' ? JSON.parse(v) : v); },
    async put(k, v) { store.set(k, String(v)); },
    async delete(k) { store.delete(k); },
    async claimMonthlyAward() { return false; },
    async listValues({ prefix } = {}) {
      const out = [];
      for (const [k, v] of store) {
        if (prefix && !k.startsWith(prefix)) continue;
        if (k === 'bingo_current') continue;
        out.push({ name: k, value: JSON.parse(v) });
      }
      return out;
    },
    async mutate(k, fn) {
      const prev = chains.get(k) || Promise.resolve();
      const run = prev.then(async () => {
        const cur = store.has(k) ? JSON.parse(store.get(k)) : null;
        const out = await fn(cur);
        if (out === undefined) return;
        store.set(k, JSON.stringify(out));
      });
      chains.set(k, run.then(() => {}, () => {}));
      return run;
    },
  };
}

const HOST = '555';
const cookie = (id) => ({ Cookie: 'pham_session=' + encodeURIComponent(JSON.stringify({ user_id: id, display_name: 'U' + id })) });
const POST = (fn, e, body, h) => fn({ env: e, request: new Request('https://x/api/bingo', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(body) }) });

/* HOST is the broadcaster, so create (as HOST) takes the overlay and the unified
   stream_now pointer without a moderator list to seed. */
const envWith = (seed) => ({ MARKETPLACE: fakeKV(seed), TWITCH_BROADCASTER_ID: HOST });
const events = (e) => { const r = e.MARKETPLACE.read('overlay_events'); return (r && r.events) || []; };
const ofType = (e, t) => events(e).filter(ev => ev.type === t);
const claimsOf = (e, code) => (e.MARKETPLACE.read('bingo_' + code) || {}).claims || [];

/* A 5x5 card whose top row is squares 1..5 and whose centre (index 12) is the
   free space — exactly the shape join.js deals. With 1..5 called, the top row is
   a complete line. */
const WIN_CARD = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 0, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24];
/* A card sharing no called square, so with 1..5 called only its free centre is
   marked — never a line. */
const LOSE_CARD = [40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 0, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63];
const CALLED = [1, 2, 3, 4, 5];

/* Create a live, staff-hosted room (so stream_now names it) and seat players. */
async function liveRoom(players, called = CALLED) {
  const e = envWith();
  await POST(create, e, { code: 'aaa' }, cookie(HOST));
  const g = e.MARKETPLACE.read('bingo_AAA');
  g.players = players;
  g.calledEvents = called;
  await e.MARKETPLACE.put('bingo_AAA', JSON.stringify(g));
  return e;
}

const winner = { id: 'u_777', name: 'Winner777', cardIds: WIN_CARD, cards: [WIN_CARD], wildcards: [] };
const loser = { id: 'u_888', name: 'Loser888', cardIds: LOSE_CARD, cards: [LOSE_CARD], wildcards: [] };

/* ══ bingo is the game on stream after a staff create ═══════════════════ */
{
  const e = await liveRoom([winner]);
  const w = await readStreamNow(e);
  check('a staff create puts bingo on stream', w && w.game, 'bingo');
  check('and names the room', w && w.code, 'AAA');
}

/* ══ a genuine winning card verifies: alert + claim ════════════════════ */
{
  const e = await liveRoom([winner, loser]);
  const r = await verifyBingoClaim(e, { userId: '777', name: 'Winner777' });
  check('the winner is verified', r.verified, true);
  check('and a claim is recorded', r.claimed, true);
  check('exactly one claim on the room', claimsOf(e, 'AAA').length, 1);
  check('naming the player', claimsOf(e, 'AAA')[0].playerId, 'u_777');
  check('with their bingo count', claimsOf(e, 'AAA')[0].bingos, 1);
  const alerts = ofType(e, 'bingo-claim');
  check('and one VERIFIED BINGO overlay alert fires', alerts.length, 1);
  check('naming the winner', alerts[0].who, 'Winner777');

  /* A repeat `!bingo` from the same winner never claims or alerts twice. */
  const again = await verifyBingoClaim(e, { userId: '777', name: 'Winner777' });
  check('a second claim is deduped', again.claimed, false);
  check('still one claim', claimsOf(e, 'AAA').length, 1);
  check('and still one alert', ofType(e, 'bingo-claim').length, 1);
}

/* ══ a non-winning card verifies nothing ═══════════════════════════════ */
{
  const e = await liveRoom([winner, loser]);
  const r = await verifyBingoClaim(e, { userId: '888', name: 'Loser888' });
  check('a non-winner is not verified', r.verified, false);
  check('with a no-win reason', r.reason, 'no-win');
  check('no claim is recorded', claimsOf(e, 'AAA').length, 0);
  check('and no overlay alert fires', ofType(e, 'bingo-claim').length, 0);
}

/* ══ a chatter with no card gets a helpful, rate-limited reply ══════════ */
{
  const e = await liveRoom([winner]);
  const r = await verifyBingoClaim(e, { userId: '999', name: 'Ghost999' });
  check('a chatter not in the room is told so', r.reason, 'not-in-room');
  ok('with a join link', /games\/commander-bingo/.test(r.chat || ''));
  check('and no claim is recorded', claimsOf(e, 'AAA').length, 0);

  /* Rapid repeat is throttled — no second reply. */
  const again = await verifyBingoClaim(e, { userId: '999', name: 'Ghost999' });
  check('a rapid repeat is throttled', again.reason, 'throttled');
  check('and says nothing', again.chat, null);
}

/* ══ the rate limit is per chatter, and blocks rapid wrong `!bingo` ═════ */
{
  const e = await liveRoom([winner, loser]);
  const first = await verifyBingoClaim(e, { userId: '888', name: 'Loser888' });
  ok('the first wrong claim replies', !!first.chat);
  const second = await verifyBingoClaim(e, { userId: '888', name: 'Loser888' });
  check('a rapid repeat from the same chatter is throttled', second.reason, 'throttled');
  check('and silent', second.chat, null);

  /* A DIFFERENT chatter is unaffected by someone else's cooldown. */
  const other = await verifyBingoClaim(e, { userId: '888x', name: 'Other' });
  ok('a different chatter is not throttled', other.reason !== 'throttled');
}

/* ══ `!bingo` when bingo is NOT the game on stream is ignored ═══════════ */
{
  /* A viewer (non-staff) hosts, so stream_now is never set. */
  const e = envWith();
  await POST(create, e, { code: 'vvv' }, cookie('999'));
  const g = e.MARKETPLACE.read('bingo_VVV');
  g.players = [{ id: 'u_777', name: 'Winner777', cardIds: WIN_CARD, cards: [WIN_CARD], wildcards: [] }];
  g.calledEvents = CALLED;
  await e.MARKETPLACE.put('bingo_VVV', JSON.stringify(g));

  check('nothing is on stream', await readStreamNow(e), null);
  const r = await verifyBingoClaim(e, { userId: '777', name: 'Winner777' });
  check('a genuine winner is ignored when bingo is not on stream', r.reason, 'not-on-stream');
  check('with nothing said', r.chat, null);
  check('no claim recorded', claimsOf(e, 'VVV').length, 0);
  check('and no overlay alert', ofType(e, 'bingo-claim').length, 0);
}
{
  /* On stream, then explicitly cleared: a later `!bingo` is ignored. */
  const e = await liveRoom([winner]);
  await clearStreamNow(e, 'bingo', 'AAA');
  const r = await verifyBingoClaim(e, { userId: '777', name: 'Winner777' });
  check('a cleared stream ignores the claim', r.reason, 'not-on-stream');
  check('and records nothing', claimsOf(e, 'AAA').length, 0);
}

/* ══ the verify win check matches the on-site rule exactly ══════════════ */
{
  const e = await liveRoom([winner, loser]);
  const game = e.MARKETPLACE.read('bingo_AAA');
  const called = new Set(game.calledEvents);
  const board = standings(game);
  const winRow = board.find(r => r.id === 'u_777');
  const loseRow = board.find(r => r.id === 'u_888');

  check('bestBingos agrees with standings for the winner', bestBingos(winner, called), winRow.bingos);
  check('and for the non-winner', bestBingos(loser, called), loseRow.bingos);
  ok('the winner has a bingo on both counts', winRow.bingos > 0 && bestBingos(winner, called) > 0);
  check('the non-winner has none on both counts', [loseRow.bingos, bestBingos(loser, called)], [0, 0]);

  /* And the claim the chatter path records carries that same count. */
  await verifyBingoClaim(e, { userId: '777', name: 'Winner777' });
  check('the recorded claim count equals the standings count', claimsOf(e, 'AAA')[0].bingos, winRow.bingos);
}

/* ══ the cooldown map stays bounded (pruned on write) ══════════════════ */
{
  const e = await liveRoom([winner, loser]);
  /* Many distinct wrong claimers, none winning. */
  for (let i = 0; i < 20; i++) await verifyBingoClaim(e, { userId: 'x' + i, name: 'x' + i });
  const cds = (e.MARKETPLACE.read('bingo_AAA') || {}).cmdCooldowns || {};
  ok('the cooldown map holds only recent chatters', Object.keys(cds).length <= 25);
  check('no claim was recorded from wrong guesses', claimsOf(e, 'AAA').length, 0);
}

/* ══ Wiring ════════════════════════════════════════════════════════════ */
{
  const commands = fs.readFileSync(path.join(REPO, 'functions/api/bot/commands.js'), 'utf8');
  ok('bot/commands.js routes the !bingo command', /parsed\.command === '!bingo'/.test(commands));
  ok('and delegates to verifyBingoClaim', /verifyBingoClaim/.test(commands));
  ok('!bingo is a public command (before the moderator gate)',
     commands.indexOf("'!bingo'") < commands.indexOf('Everything past here is broadcaster/moderator only'));

  const evsrc = fs.readFileSync(path.join(REPO, 'functions/api/overlay/events.js'), 'utf8');
  ok("'bingo-claim' is a toggleable alert type", /'bingo-claim'/.test(evsrc));

  const overlay = fs.readFileSync(path.join(REPO, 'js/pages/overlay.js'), 'utf8');
  ok('the overlay describes the verified-claim alert', /ev\.type === 'bingo-claim'/.test(overlay));
  ok('and shows VERIFIED BINGO', /VERIFIED BINGO/.test(overlay));

  const state = fs.readFileSync(path.join(REPO, 'functions/api/bingo/state.js'), 'utf8');
  ok('state.js returns the host claim list', /out\.claims/.test(state));

  const host = fs.readFileSync(path.join(REPO, 'games/commander-bingo/host.html'), 'utf8');
  ok('the host page has the claims panel', /id="claimsPanel"/.test(host) && /function renderClaims/.test(host));
  ok('and renders claims from the room poll', /renderClaims\(g\.claims/.test(host));
  ok('the claims list reuses the award flow', /renderClaims[\s\S]*awardPrize\(btn\)/.test(host));

  const router = fs.readFileSync(path.join(REPO, 'server/router.js'), 'utf8');
  ok('verify.js is declared a non-route library', /'api\/bingo\/verify\.js'/.test(router));
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[bingo-chat-claim] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[bingo-chat-claim] ${passed} assertions passed.`);
console.log('');
