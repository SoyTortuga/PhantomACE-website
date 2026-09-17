#!/usr/bin/env node
/* ══════════════════════════════════════════════
   MANA CLASH ON THE OVERLAY — test suite

     node server/scripts/test-overlay-mana-clash.js

   Two callers prove themselves two different ways in one file, which is
   exactly the shape of mistake worth testing: the OBS browser source has
   no cookie and carries the overlay key in its URL, while the control
   panel has a moderator session and no key. Getting that backwards would
   either lock the overlay out or publish the room list to anyone.

   THE PRIVACY LINE. viewFor() is the players' own view with a `you` block
   holding the only genuinely private thing in the room. The overlay asks
   for it with no user, and this checks that `you` really is absent —
   because it is one argument away from being present, and nobody watching
   a stream would ever notice it leaking into a payload.

   No database: the KV shim is faked in memory.
   ══════════════════════════════════════════════ */

import * as route from '../../functions/api/overlay/mana-clash.js';

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

const BROADCASTER = '900';
const KEY = 'a-test-overlay-key';

/** A room the way mana-clash.js stores one. */
function room(over = {}) {
  return {
    code: 'ABCD',
    status: 'playing',
    goal: 4000,
    round: 3,
    host: '1',
    hostName: 'host',
    players: {
      1: { displayName: 'alice', profileImage: 'a.png', total: 2200, turn: { pending: 450, dice: [5, 3, 2], kept: [5, 5], remaining: 3, awaitingSelection: false, done: null, gained: null, event: null } },
      2: { displayName: 'bob', profileImage: 'b.png', total: 1800, turn: { pending: 0, dice: [], kept: [], remaining: 6, awaitingSelection: false, done: true, gained: 300, event: null } },
    },
    ...over,
  };
}

function makeEnv(seed = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  return {
    TWITCH_BROADCASTER_ID: BROADCASTER,
    MARKETPLACE: {
      async get(k, t) { if (!store.has(k)) return null; const r = store.get(k); return t === 'json' ? JSON.parse(r) : r; },
      async put(k, v) { store.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
      async delete(k) { store.delete(k); },
      async listValues({ prefix }) {
        const out = [];
        for (const [name, raw] of store) if (name.startsWith(prefix)) out.push({ name, value: JSON.parse(raw) });
        return out;
      },
    },
    _store: store,
  };
}

const cookie = (userId) => `pham_session=${encodeURIComponent(JSON.stringify({ user_id: userId, display_name: 'u' + userId }))}`;

const get = (env, query, userId) => route.onRequestGet({
  env,
  request: new Request('https://phantomace.tv/api/overlay/mana-clash' + query, {
    headers: userId ? { Cookie: cookie(userId) } : {},
  }),
});

const post = (env, body, userId) => route.onRequestPost({
  env,
  request: new Request('https://phantomace.tv/api/overlay/mana-clash', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(userId ? { Cookie: cookie(userId) } : {}) },
    body: JSON.stringify(body),
  }),
});

/* ── The key is the overlay's only credential ────────────────────────── */
{
  const env = makeEnv({ overlay_key: KEY });

  const none = await get(env, '');
  check('no key is refused', none.status, 403);

  const wrong = await get(env, '?key=nope');
  check('a wrong key is refused', wrong.status, 403);

  /* A SESSION IS NOT A SUBSTITUTE. An OBS browser source cannot hold one,
     so accepting one here would only ever help somebody who is not the
     overlay. */
  const withCookie = await get(env, '', BROADCASTER);
  check('a moderator session does not open the overlay feed', withCookie.status, 403);

  const right = await get(env, '?key=' + KEY);
  check('the right key is accepted', right.status, 200);
}

/* ── Switched off is an ordinary answer ──────────────────────────────── */
{
  const env = makeEnv({ overlay_key: KEY });
  const d = await (await get(env, '?key=' + KEY)).json();
  /* Not an error: the panel hides and slows down, and nothing on stream
     suggests anything is broken. */
  check('with no pointer the panel is told nothing is on', d.enabled, false);
  check('and given no room', d.room, null);
}

/* ── Choosing a room ─────────────────────────────────────────────────── */
{
  const env = makeEnv({ overlay_key: KEY, mc_room_ABCD: room() });

  const viewer = await post(env, { action: 'show', code: 'ABCD' }, '12345');
  check('a viewer cannot point the overlay at a room', viewer.status, 403);

  const missing = await post(env, { action: 'show', code: 'ZZZZ' }, BROADCASTER);
  /* Answered here rather than by an empty panel on stream that nobody can
     explain. */
  check('a room that does not exist is refused', missing.status, 404);

  const shown = await (await post(env, { action: 'show', code: 'abcd' }, BROADCASTER)).json();
  check('a moderator can point it at a room', shown.success, true);
  check('and the code is upper-cased on the way in', shown.code, 'ABCD');
  check('the pointer is stored', JSON.parse(env._store.get('overlay_mana_clash')).code, 'ABCD');

  const feed = await (await get(env, '?key=' + KEY)).json();
  check('the overlay now sees the room', feed.room.code, 'ABCD');
  check('at the right round', feed.room.round, 3);
  check('with both players', feed.room.players.map(p => p.name), ['alice', 'bob']);
}

/* ── THE PRIVACY LINE ────────────────────────────────────────────────── */
{
  const env = makeEnv({ overlay_key: KEY, mc_room_ABCD: room(), overlay_mana_clash: { enabled: true, code: 'ABCD' } });
  const d = await (await get(env, '?key=' + KEY)).json();

  /* `you` is the players' own block and the only private thing in the
     room. It is one argument away from being included, and a leak here is
     invisible to everyone watching. */
  check('the spectator view carries no you block', d.room.you, undefined);
  /* The password is a boolean in this view and must stay one. */
  ok('and no password', !('password' in d.room));
  check('only whether there is one', d.room.hasPassword, false);
}

/* ── Dice, because rounds are simultaneous ───────────────────────────── */
{
  const env = makeEnv({ overlay_key: KEY, mc_room_ABCD: room(), overlay_mana_clash: { enabled: true, code: 'ABCD' } });
  const d = await (await get(env, '?key=' + KEY)).json();
  const alice = d.room.players.find(p => p.name === 'alice');

  /* Everyone rolls in the same round, so every row carries its own dice.
     A single tray would have to choose a player and be wrong most of the
     time. */
  check('the overlay is given the dice on the table', alice.dice, [5, 3, 2]);
  check('and what is already set aside', alice.kept, [5, 5]);
  check('and how many are left', alice.remaining, 3);
  check('and what they are holding', alice.pending, 450);
  check('and the banked total', alice.total, 2200);
}

/* ── The players' own payload is untouched ───────────────────────────── */
{
  /* Widening what every client receives to serve one spectator is how a
     contract drifts. The game page has never needed anyone else's dice. */
  const { viewFor } = await import('../../functions/api/mana-clash.js');
  const players = viewFor(room(), '1', Date.now()).players;
  const alice = players.find(p => p.name === 'alice');
  check('a player is not sent other players dice', alice.dice, undefined);
  check('nor what they have set aside', alice.kept, undefined);
  /* What was always public still is. */
  check('but totals and pending are as they were', [alice.total, alice.pending], [2200, 450]);
}

/* ── Hiding it ───────────────────────────────────────────────────────── */
{
  const env = makeEnv({ overlay_key: KEY, mc_room_ABCD: room(), overlay_mana_clash: { enabled: true, code: 'ABCD' } });
  const off = await (await post(env, { action: 'off' }, BROADCASTER)).json();
  check('a moderator can hide it', off.enabled, false);

  const d = await (await get(env, '?key=' + KEY)).json();
  check('and the overlay is told so', d.enabled, false);
}

/* ── A room that went away under the pointer ─────────────────────────── */
{
  const env = makeEnv({ overlay_key: KEY, overlay_mana_clash: { enabled: true, code: 'ABCD' } });
  const d = await (await get(env, '?key=' + KEY)).json();
  /* Rooms expire. The panel shows nothing rather than the feed erroring. */
  check('an expired room is not an error', d.enabled, true);
  check('there is simply no room to show', d.room, null);
}

/* ── The picker lists what is worth showing ──────────────────────────── */
{
  const env = makeEnv({
    overlay_key: KEY,
    mc_room_AAAA: room({ code: 'AAAA', status: 'lobby', round: 0 }),
    mc_room_BBBB: room({ code: 'BBBB', status: 'playing', round: 7 }),
    mc_room_CCCC: room({ code: 'CCCC', status: 'finished' }),
  });

  const anon = await get(env, '?rooms=1');
  check('the room list needs a session', anon.status, 403);
  const viewer = await get(env, '?rooms=1', '12345');
  check('and a moderator one', viewer.status, 403);

  const d = await (await get(env, '?rooms=1', BROADCASTER)).json();
  /* A game in progress is the only interesting answer, so it sorts first.
     The PUBLIC list deliberately shows only joinable lobbies, which is the
     opposite question. */
  check('games in progress come first', d.rooms.map(r => r.code), ['BBBB', 'AAAA', 'CCCC']);
  check('with the round, for picking between them', d.rooms[0].round, 7);
  check('and the current pointer, so the card can show its state', d.pointer.enabled, false);
}

/* ── The overlay page is wired up ────────────────────────────────────── */
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

  const html = fs.readFileSync(path.join(REPO, 'overlay.html'), 'utf8');
  ok('the overlay page has the panel', /id="ovMcList"/.test(html));
  ok('and loads the script that drives it', /overlay-mana-clash\.js/.test(html));

  /* YIELDING TO ALERTS. overlay.js publishes one class; the stylesheet
     does the rest. Both halves have to be there or the panel sits under a
     code drop, which is the one alert a viewer must not miss. */
  const js = fs.readFileSync(path.join(REPO, 'js/pages/overlay.js'), 'utf8');
  ok('an alert on screen is published', /classList\.add\('ov-alerting'\)/.test(js));
  ok('and unpublished when it leaves', /classList\.remove\('ov-alerting'\)/.test(js));

  const css = fs.readFileSync(path.join(REPO, 'css/pages/overlay.css'), 'utf8');
  ok('and the panel gets out of the way', /body\.ov-alerting \.ov-mc/.test(css));
  /* The project forbids box-shadow outright. */
  const mc = css.slice(css.indexOf('.ov-mc {'));
  ok('with no box-shadow anywhere in it', !/box-shadow/.test(mc));
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[overlay-mana-clash] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[overlay-mana-clash] ${passed} assertions passed.`);
console.log('');
