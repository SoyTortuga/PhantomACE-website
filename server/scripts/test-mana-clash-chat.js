#!/usr/bin/env node
/* ══════════════════════════════════════════════
   STREAMER vs CHAT — Mana Clash stream event — test suite

     node server/scripts/test-mana-clash-chat.js

   The event is server-authoritative: a mod starts it, chat rolls into a pool
   with `!clash`, and the round resolves with the SAME Farkle scorer the rooms
   pay from. The things that would be embarrassing live and are asserted here:

     - start is behind the broadcaster/moderator gate, never public;
     - `!clash` is one die per chatter per clash (the rate limit) and the
       record stays counters, not a per-message log (bounded);
     - the round resolves with the real scoring and names the right winner;
     - chat's aggregate rule is deterministic given the pool;
     - the session self-clears once the reveal is over;
     - it never touches an mc_room_ room.

   No database, no browser: a fake MARKETPLACE holds keys in a Map, and the
   dice are made deterministic by queueing Math.random the same way
   test-mana-clash.js does.
   ══════════════════════════════════════════════ */

import {
  CLASH_KEY, CLASH_COLLECT_MS, CLASH_REVEAL_MS,
  bestChatHand, resolveClash, advanceClash, publicClash, clashFromChat,
  onRequestGet, onRequestPost,
} from '../../functions/api/mana-clash-chat.js';
import { FACES } from '../../functions/api/mana-clash-scoring.js';

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

/* ── A KV stand-in ───────────────────────────────────────────────────────
   mutate() ignores the expirationTtl options object the handlers pass — the
   TTL is a storage policy, not behaviour the logic depends on. Values
   round-trip through JSON so object-identity bugs surface here. */
function makeEnv(seed = {}) {
  const store = new Map();
  for (const [k, v] of Object.entries(seed)) store.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  return {
    TWITCH_BROADCASTER_ID: '900',
    MARKETPLACE: {
      async get(key, type) {
        if (!store.has(key)) return null;
        const raw = store.get(key);
        return type === 'json' ? JSON.parse(raw) : raw;
      },
      async put(key, value) { store.set(key, typeof value === 'string' ? value : JSON.stringify(value)); },
      async delete(key) { store.delete(key); },
      async mutate(key, fn) {
        const current = store.has(key) ? JSON.parse(store.get(key)) : null;
        const next = await fn(current);
        if (next === undefined) return current;
        store.set(key, JSON.stringify(next));
        return JSON.parse(store.get(key));
      },
      async listValues({ prefix }) {
        const out = [];
        for (const [name, raw] of store) if (name.startsWith(prefix)) out.push({ name, value: JSON.parse(raw) });
        return out;
      },
    },
    _store: store,
  };
}

/* ── Loaded dice ─────────────────────────────────────────────────────────
   rollDice picks FACES[floor(random * 6)] and FACES is in value order, so a
   face letter is requested by feeding its index / 6 plus a nudge. */
const realRandom = Math.random;
let randomQueue = [];
Math.random = () => (randomQueue.length ? randomQueue.shift() : realRandom());
function loadFaces(str) {
  randomQueue = [...str].map(ch => FACES.indexOf(ch.toUpperCase()) / FACES.length + 0.001);
}
function clearDice() { randomQueue = []; }

const KEY = 'test-overlay-key';
const cookie = (userId) => `pham_session=${encodeURIComponent(JSON.stringify({ user_id: userId, display_name: 'u' + userId }))}`;

const post = (env, body, userId) => onRequestPost({
  env,
  request: new Request('https://phantomace.tv/api/mana-clash-chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(userId ? { Cookie: cookie(userId) } : {}) },
    body: JSON.stringify(body),
  }),
});
const getOverlay = (env, qs) => onRequestGet({
  env,
  request: new Request('https://phantomace.tv/api/mana-clash-chat' + (qs || '')),
});

function session(env) {
  const raw = env._store.get(CLASH_KEY);
  return raw ? JSON.parse(raw) : null;
}
function setSession(env, s) { env._store.set(CLASH_KEY, JSON.stringify(s)); }

/* ══ The aggregate rule is pure and deterministic ══════════════════════════ */
{
  /* Six C's (the pip-1 face) is six 1s — nOfAKind(1,6) = 1000 * 2^3 = 8000. */
  const hand = bestChatHand({ C: 6, W: 0, U: 0, B: 0, R: 0, G: 0 });
  check('chat keeps six C for its best six', hand.faces, ['C', 'C', 'C', 'C', 'C', 'C']);
  check('scored with the real engine', hand.points, 8000);

  /* From a deep pool it still takes only the best six, deterministically. */
  const a = bestChatHand({ C: 20, W: 5, U: 0, B: 0, R: 3, G: 0 });
  const b = bestChatHand({ C: 20, W: 5, U: 0, B: 0, R: 3, G: 0 });
  check('the same pool always resolves the same hand', a, b);
  check('and it is chat\'s best six', a.points, 8000);

  /* A pool of a single non-scoring die is a bust — zero, not a crash. */
  const bust = bestChatHand({ C: 0, W: 1, U: 0, B: 0, R: 0, G: 0 });
  check('a lone non-scoring die scores nothing', bust.points, 0);

  /* resolveClash is a pure function of the frozen roll and the pool. */
  const s = { streamer: { roll: ['R', 'R', 'R', 'R', 'R', 'R'] }, chatCounts: { C: 6, W: 0, U: 0, B: 0, R: 0, G: 0 } };
  const r1 = resolveClash(s);
  const r2 = resolveClash(s);
  check('resolveClash is deterministic', r1, r2);
  check('six R is 4000 for the streamer', r1.streamerScore, 4000);   // 500 * 2^3
  check('six C is 8000 for chat', r1.chatScore, 8000);
  check('so chat wins this one', r1.winner, 'chat');
}

/* ══ start is behind the broadcaster/moderator gate ════════════════════════ */
{
  const env = makeEnv({ overlay_key: KEY, site_moderators: { entries: [{ userId: '222' }] } });

  const anon = await post(env, { action: 'start' });
  check('an unauthenticated start is refused', anon.status, 403);

  const viewer = await post(env, { action: 'start' }, '111');
  check('a viewer cannot start a clash', viewer.status, 403);
  check('and nothing was written', session(env), null);

  loadFaces('CCCCCC');
  const mod = await post(env, { action: 'start' }, '222');
  check('a moderator can start one', mod.status, 200);

  loadFaces('CCCCCC');
  const bc = await post(env, { action: 'start' }, '900');   // the broadcaster
  check('and so can the broadcaster', bc.status, 200);
  const d = await bc.json();
  check('the clash is collecting', d.clash.status, 'collecting');
  check('with the streamer already rolled', d.clash.streamer.roll.length, 6);

  /* Starting puts Mana Clash on the unified "what's on stream" pointer. */
  const whatsOn = JSON.parse(env._store.get('stream_now'));
  check('starting sets the stream pointer to mana-clash', whatsOn.game, 'mana-clash');

  clearDice();
}

/* ══ `!clash` — one die per chatter, bounded to counters ═══════════════════ */
{
  const env = makeEnv({ overlay_key: KEY });
  loadFaces('GGGGGG');
  await post(env, { action: 'start' }, '900');

  /* No active-session guard: a strike with no clash is a quiet no-op. */
  const envOff = makeEnv({ overlay_key: KEY });
  const none = await clashFromChat(envOff, { userId: 'x', name: 'x' });
  check('no clash means a no-op', none.status, 'none');
  check('and nothing is written', envOff._store.get(CLASH_KEY), undefined);

  loadFaces('C');
  const first = await clashFromChat(env, { userId: 'aaa', name: 'Aaa' });
  check('a chatter\'s first !clash lands a die', first.ok, true);
  check('and counts them in', first.chatters, 1);

  /* A second !clash from the SAME chatter adds nothing — the rate limit. */
  loadFaces('C');
  const again = await clashFromChat(env, { userId: 'aaa', name: 'Aaa' });
  check('a repeat from the same chatter is ignored', again.ok, false);
  check('the chatter count does not climb', session(env).chatters, 1);
  check('and no second die was pooled', Object.values(session(env).chatCounts).reduce((a, b) => a + b, 0), 1);

  /* A different chatter does count. */
  loadFaces('C');
  const second = await clashFromChat(env, { userId: 'bbb', name: 'Bbb' });
  check('a different chatter lands their own die', second.chatters, 2);

  /* BOUNDED: the pool is six integer counters plus a dedupe map, never a
     per-message log. Fifty distinct chatters do not grow an array of rolls. */
  for (let i = 0; i < 50; i++) {
    loadFaces('C');
    await clashFromChat(env, { userId: 'c' + i, name: 'C' + i });
  }
  const s = session(env);
  check('every distinct chatter is counted', s.chatters, 52);
  check('the pool is six counters, nothing more', Object.keys(s.chatCounts).sort(), ['B', 'C', 'G', 'R', 'U', 'W']);
  /* The only dice array is the streamer's six, nested under `streamer`; the top
     level grows no per-message list however many chatters strike. */
  check('no top-level per-message array', Object.values(s).some(v => Array.isArray(v)), false);
  check('the dedupe map holds one entry per chatter', Object.keys(s.seen).length, 52);

  clearDice();
}

/* ══ the round resolves with the real scoring and names the winner ═════════ */
{
  /* Chat wins: streamer six R (4000) vs chat pooling six C (8000). */
  const env = makeEnv({ overlay_key: KEY });
  loadFaces('RRRRRR');
  await post(env, { action: 'start' }, '900');
  for (let i = 0; i < 6; i++) { loadFaces('C'); await clashFromChat(env, { userId: 'p' + i, name: 'P' + i }); }

  /* Force the collect window closed, then let the overlay poll resolve it. */
  const s = session(env);
  s.collectUntil = Date.now() - 1;
  setSession(env, s);

  const res = await getOverlay(env, '?key=' + KEY);
  const d = await res.json();
  check('the overlay poll resolves the window', d.status, 'resolved');
  check('the streamer\'s six R scored 4000', d.streamer.score, 4000);
  check('chat\'s pooled six C scored 8000', d.chat.score, 8000);
  check('and chat is declared the winner', d.winner, 'chat');
  check('the stored session is resolved', session(env).status, 'resolved');

  clearDice();
}
{
  /* Streamer wins: six C (8000) vs a lone non-scoring chat die (0). */
  const env = makeEnv({ overlay_key: KEY });
  loadFaces('CCCCCC');
  await post(env, { action: 'start' }, '900');
  loadFaces('W');                                  // one W — a bust on its own
  await clashFromChat(env, { userId: 'solo', name: 'Solo' });

  const s = session(env);
  s.collectUntil = Date.now() - 1;
  setSession(env, s);
  const d = await (await getOverlay(env, '?key=' + KEY)).json();
  check('the streamer\'s six C scored 8000', d.streamer.score, 8000);
  check('chat\'s lone non-scoring die is nothing', d.chat.score, 0);
  check('the streamer wins', d.winner, 'streamer');

  clearDice();
}

/* ══ the overlay is key-gated ══════════════════════════════════════════════ */
{
  const env = makeEnv({ overlay_key: KEY });
  loadFaces('CCCCCC');
  await post(env, { action: 'start' }, '900');

  check('no key is refused', (await getOverlay(env, '')).status, 403);
  check('a wrong key is refused', (await getOverlay(env, '?key=nope')).status, 403);
  check('the right key is accepted', (await getOverlay(env, '?key=' + KEY)).status, 200);
  clearDice();
}

/* ══ the session self-clears once the reveal is over ═══════════════════════ */
{
  const env = makeEnv({ overlay_key: KEY });
  loadFaces('CCCCCC');
  await post(env, { action: 'start' }, '900');

  /* advanceClash walks the clock through its two deadlines. */
  const s = session(env);
  check('a fresh session is collecting', s.status, 'collecting');

  const afterCollect = Date.now() + CLASH_COLLECT_MS + 1;
  check('the window closing resolves it', advanceClash(s, afterCollect), true);
  check('status becomes resolved', s.status, 'resolved');

  const afterReveal = s.revealUntil + 1;
  check('the reveal ending ends the session', advanceClash(s, afterReveal), true);
  check('status becomes ended', s.status, 'ended');
  check('and the overlay then sees nothing on', publicClash(s, afterReveal + 1).status, 'none');

  /* Driven through the real overlay poll: an ended session reads as none and
     the stream pointer is cleared. */
  const env2 = makeEnv({ overlay_key: KEY });
  loadFaces('CCCCCC');
  await post(env2, { action: 'start' }, '900');
  const s2 = session(env2);
  s2.status = 'resolved';
  s2.result = resolveClash(s2);
  s2.revealUntil = Date.now() - 1;
  setSession(env2, s2);
  const gone = await (await getOverlay(env2, '?key=' + KEY)).json();
  check('a poll past the reveal shows nothing on', gone.status, 'none');
  const ptr = JSON.parse(env2._store.get('stream_now'));
  check('and the stream pointer is cleared', ptr.game, null);

  clearDice();
}

/* ══ an explicit end clears it immediately ═════════════════════════════════ */
{
  const env = makeEnv({ overlay_key: KEY });
  loadFaces('CCCCCC');
  await post(env, { action: 'start' }, '900');
  const ended = await post(env, { action: 'end' }, '900');
  check('a moderator can end a clash', ended.status, 200);
  check('the overlay then shows nothing', (await (await getOverlay(env, '?key=' + KEY)).json()).status, 'none');
  check('and the stream pointer is cleared', JSON.parse(env._store.get('stream_now')).game, null);

  const viewerEnd = await post(env, { action: 'end' }, '111');
  check('a viewer cannot end one', viewerEnd.status, 403);
  clearDice();
}

/* ══ it never touches an mc_room_ room ═════════════════════════════════════ */
{
  const roomDoc = { code: 'ZZZZ', status: 'playing', players: {}, goal: 10000 };
  const env = makeEnv({ overlay_key: KEY, mc_room_ZZZZ: roomDoc });
  const before = env._store.get('mc_room_ZZZZ');

  loadFaces('CCCCCC');
  await post(env, { action: 'start' }, '900');
  for (let i = 0; i < 3; i++) { loadFaces('C'); await clashFromChat(env, { userId: 'r' + i, name: 'R' + i }); }
  const s = session(env);
  s.collectUntil = Date.now() - 1;
  setSession(env, s);
  await getOverlay(env, '?key=' + KEY);
  await post(env, { action: 'end' }, '900');

  check('the mc_room_ room is byte-identical after a whole clash', env._store.get('mc_room_ZZZZ'), before);
  const rooms = await env.MARKETPLACE.listValues({ prefix: 'mc_room_' });
  check('and no mc_room_ key was created', rooms.length, 1);
  clearDice();
}

/* ── Report ──────────────────────────────────────────────────────────────── */
Math.random = realRandom;
console.log('');
if (failures.length) {
  console.log(`[mana-clash-chat] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[mana-clash-chat] ${passed} assertions passed.`);
console.log('');
