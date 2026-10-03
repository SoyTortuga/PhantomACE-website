#!/usr/bin/env node
/* ══════════════════════════════════════════════
   STREAM-NOW — the one "what's on stream" pointer (Epic D #10)

     node server/scripts/test-stream-now.js

   The four games used to each keep their own live-on-stream signal, and
   bingo/mtgbbb never stopped on their own. `stream_now` is the single pointer
   that replaced them, retired by a sliding TTL rather than an explicit clear.
   This suite is that contract:

     - starting each game (bingo/mtgbbb/maze/scramble) sets whatsOn.game;
     - activity slides lastActiveAt and the TTL forward;
     - the writer refresh extends the TTL; a plain READ never does (the whole
       inactivity fix — the public overlay poll must not keep a game on stream);
     - letting the TTL lapse with no refresh clears it (whatsOn -> null);
     - a second game's start REPLACES the pointer (one game on stream);
     - an explicit end clears it immediately, guarded by game and code;
     - the overlay poll payload carries whatsOn.
   ══════════════════════════════════════════════ */

import {
  refreshStreamNow, readStreamNow, clearStreamNow,
  STREAM_NOW_KEY, STREAM_NOW_TTL_SECONDS,
} from '../../functions/api/stream-now.js';
import { onRequestGet as overlayEvents } from '../../functions/api/overlay/events.js';

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

/* A fake KV that models a real expiry clock. `clock.now` is the time the store
   reads; a put/mutate with expirationTtl stamps expiresAt = clock.now + ttl, and
   a get past that returns null (and evicts). advance() moves the clock WITHOUT
   touching any row — that is how a lapse (no refresh) is simulated. Date.now()
   the helper stamps into the value is irrelevant to expiry; the store's own
   clock is. */
function fakeKV() {
  const store = new Map();   // key -> { raw, expiresAt|null }
  const clock = { now: 1_000_000_000_000 };
  function live(k) {
    const row = store.get(k);
    if (!row) return null;
    if (row.expiresAt != null && clock.now >= row.expiresAt) { store.delete(k); return null; }
    return row;
  }
  return {
    clock,
    advance(ms) { clock.now += ms; },
    expiryOf(k) { const r = store.get(k); return r ? r.expiresAt : undefined; },
    rawOf(k) { const r = live(k); return r ? JSON.parse(r.raw) : null; },
    async get(k, t) {
      const r = live(k);
      if (!r) return null;
      return t === 'json' ? JSON.parse(r.raw) : r.raw;
    },
    async put(k, v, opts) {
      const ttl = opts && opts.expirationTtl;
      store.set(k, { raw: String(v), expiresAt: ttl ? clock.now + ttl * 1000 : null });
    },
    async delete(k) { store.delete(k); },
    async mutate(k, fn, opts) {
      const cur = live(k) ? JSON.parse(live(k).raw) : null;
      const out = await fn(cur);
      if (out === undefined) return;
      const ttl = opts && opts.expirationTtl;
      store.set(k, { raw: JSON.stringify(out), expiresAt: ttl ? clock.now + ttl * 1000 : null });
    },
  };
}
const envWith = () => ({ MARKETPLACE: fakeKV() });
const TTL_MS = STREAM_NOW_TTL_SECONDS * 1000;

/* ══ starting each game sets whatsOn.game ══════════════════════════════ */
for (const game of ['bingo', 'mtgbbb', 'maze', 'scramble']) {
  const e = envWith();
  await refreshStreamNow(e, { game, code: 'AAA' });
  const w = await readStreamNow(e);
  check(`starting ${game} sets whatsOn.game`, w && w.game, game);
}

/* light header fields ride along, and carry over when the same game refreshes
   without re-sending them. */
{
  const e = envWith();
  await refreshStreamNow(e, { game: 'maze', level: 3 });
  await refreshStreamNow(e, { game: 'maze' });                 // activity, no level re-sent
  check('a same-game refresh carries the prior level over', (await readStreamNow(e)).level, 3);
  await refreshStreamNow(e, { game: 'mtgbbb', setName: 'Bloomburrow' });
  const w = await readStreamNow(e);
  check('switching game drops the old light fields', w.level, null);
  check('and carries the new one', w.setName, 'Bloomburrow');
}

/* a game outside the known set is refused. */
{
  const e = envWith();
  check('an unknown game is not written', await refreshStreamNow(e, { game: 'poker' }), null);
  check('and nothing is on stream', await readStreamNow(e), null);
}

/* ══ activity slides lastActiveAt and the TTL forward ══════════════════ */
{
  const e = envWith();
  /* lastActiveAt is stamped with Date.now(); point it at this env's clock for
     the block so the stamp tracks the same time the TTL does. */
  const realNow = Date.now;
  Date.now = () => e.MARKETPLACE.clock.now;
  try {
    await refreshStreamNow(e, { game: 'bingo', code: 'AAA' });
    const firstActive = (await readStreamNow(e)).lastActiveAt;
    const firstExpiry = e.MARKETPLACE.expiryOf(STREAM_NOW_KEY);
    e.MARKETPLACE.advance(60_000);                             // a minute of play
    await refreshStreamNow(e, { game: 'bingo', code: 'AAA' }); // activity
    const w = await readStreamNow(e);
    ok('activity moves lastActiveAt forward', w.lastActiveAt > firstActive);
    ok('and slides the TTL forward', e.MARKETPLACE.expiryOf(STREAM_NOW_KEY) > firstExpiry);
  } finally {
    Date.now = realNow;
  }
}

/* ══ a refresh extends the TTL; a READ never does ══════════════════════ */
{
  const e = envWith();
  await refreshStreamNow(e, { game: 'bingo', code: 'AAA' });
  const expiry = e.MARKETPLACE.expiryOf(STREAM_NOW_KEY);

  /* Many viewer/overlay reads, well before the TTL — none may slide it. */
  e.MARKETPLACE.advance(TTL_MS - 1000);
  for (let i = 0; i < 5; i++) await readStreamNow(e);
  check('a read does not extend the TTL', e.MARKETPLACE.expiryOf(STREAM_NOW_KEY), expiry);
  ok('and the game is still on (TTL not yet reached)', (await readStreamNow(e)) !== null);

  /* Cross the original TTL with only reads since the last refresh: it lapses.
     This is the inactivity fix — the host stopped polling, so nothing kept it
     alive, and the public overlay read did not. */
  e.MARKETPLACE.advance(2000);
  check('once the TTL passes with no refresh, nothing is on', await readStreamNow(e), null);
}

/* ══ host poll keeps it alive across the TTL; reads alone do not ═══════ */
{
  const e = envWith();
  await refreshStreamNow(e, { game: 'bingo', code: 'AAA' });   // start

  /* Simulate the host page polling every ~2s for well past one TTL. */
  for (let t = 0; t < TTL_MS * 2; t += 2000) {
    e.MARKETPLACE.advance(2000);
    await readStreamNow(e);                                    // viewer/overlay read (no effect)
    await refreshStreamNow(e, { game: 'bingo', code: 'AAA' }); // host poll keep-alive
  }
  ok('a game stays on stream while the host keeps polling', (await readStreamNow(e)) !== null);

  /* The host closes the tab: only reads now. It lapses within one TTL. */
  e.MARKETPLACE.advance(TTL_MS + 1000);
  check('and lapses once the host stops (tab closed)', await readStreamNow(e), null);
}

/* ══ letting the TTL lapse clears it ═══════════════════════════════════ */
{
  const e = envWith();
  await refreshStreamNow(e, { game: 'scramble' });
  e.MARKETPLACE.advance(TTL_MS + 1);
  check('no refresh for a full TTL clears the pointer', await readStreamNow(e), null);
}

/* ══ a second game's start replaces the pointer (one game on stream) ═══ */
{
  const e = envWith();
  await refreshStreamNow(e, { game: 'bingo', code: 'AAA' });
  await refreshStreamNow(e, { game: 'mtgbbb', code: 'BBB' });
  const w = await readStreamNow(e);
  check('the newer game replaces the pointer', w.game, 'mtgbbb');
  check('and only one game is ever current', w.code, 'BBB');
}

/* ══ an explicit end clears immediately, guarded by game and code ══════ */
{
  const e = envWith();
  await refreshStreamNow(e, { game: 'maze' });
  await clearStreamNow(e, 'maze');
  check('clearing the current game ends it now', await readStreamNow(e), null);
}
{
  const e = envWith();
  await refreshStreamNow(e, { game: 'mtgbbb', code: 'BBB' });
  await clearStreamNow(e, 'bingo');                            // a stale bingo end
  ok('clearing a DIFFERENT game leaves the pointer', (await readStreamNow(e)) !== null);
  check('the live game is untouched', (await readStreamNow(e)).game, 'mtgbbb');
}
{
  const e = envWith();
  await refreshStreamNow(e, { game: 'bingo', code: 'AAA' });
  await clearStreamNow(e, 'bingo', 'OLD');                     // stale end on an old room
  ok('a stale end on an old code does not clear a newer room', (await readStreamNow(e)) !== null);
  await clearStreamNow(e, 'bingo', 'AAA');                     // the real end
  check('the matching code clears it', await readStreamNow(e), null);
}

/* ══ the overlay poll payload carries whatsOn ══════════════════════════ */
{
  const e = envWith();
  await e.MARKETPLACE.put('overlay_key', 'testkey');
  await refreshStreamNow(e, { game: 'mtgbbb', code: 'ZZZ', setName: 'Foundations' });

  const res = await overlayEvents({
    env: e,
    request: new Request('https://x/api/overlay/events?key=testkey'),
  });
  const body = await res.json();
  ok('the overlay payload has a whatsOn field', Object.prototype.hasOwnProperty.call(body, 'whatsOn'));
  check('and it names the live game', body.whatsOn && body.whatsOn.game, 'mtgbbb');
  check('with its light header fields', body.whatsOn && body.whatsOn.setName, 'Foundations');

  /* The payload read is the public overlay poll — it must not have refreshed
     the pointer (that read goes through readStreamNow). */
  const before = e.MARKETPLACE.expiryOf(STREAM_NOW_KEY);
  await overlayEvents({ env: e, request: new Request('https://x/api/overlay/events?key=testkey') });
  check('the overlay poll does not slide the TTL', e.MARKETPLACE.expiryOf(STREAM_NOW_KEY), before);
}
{
  const e = envWith();
  await e.MARKETPLACE.put('overlay_key', 'testkey');
  const res = await overlayEvents({
    env: e, request: new Request('https://x/api/overlay/events?key=testkey'),
  });
  const body = await res.json();
  check('with nothing on, whatsOn is null', body.whatsOn, null);
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[stream-now] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[stream-now] ${passed} assertions passed.`);
console.log('');
