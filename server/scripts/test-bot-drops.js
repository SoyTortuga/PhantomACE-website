#!/usr/bin/env node
/* ══════════════════════════════════════════════
   CODE DROPS — test suite

     node server/scripts/test-bot-drops.js

   Drops spend a finite pool and post to a live chat, so the things worth
   asserting are the ones that would otherwise be discovered mid-stream:
   that asking for five codes sends five separate messages and burns five
   from the pool, that a pool running dry partway says so rather than
   quietly sending fewer, and that the cooldown is charged once per action
   rather than once per code.

   The half-second cooldown is only safe because the bot account is a
   MODERATOR — Twitch rates those at 100 messages per 30 seconds against a
   normal account's 20. If that is ever revoked the limit silently drops and
   throttled messages come back as HTTP 200 with is_sent false, so the panel
   would report success for codes nobody saw.
   ══════════════════════════════════════════════ */

import { dropCodeAction, MAX_DROP_COUNT, TIER_INFO } from '../../functions/api/bot/send-chat.js';

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

/* Chat is captured rather than sent. */
const realFetch = globalThis.fetch;
let chat = [];
let refuseSend = false;

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('/helix/chat/messages')) {
    const body = JSON.parse(opts.body);
    chat.push(body.message);
    /* Twitch's real shape: accepted, with a separate verdict on whether it
       was actually posted. */
    return new Response(JSON.stringify({ data: [{ is_sent: !refuseSend }] }), { status: 200 });
  }
  if (u.includes('oauth2/token')) {
    return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 });
  }
  return new Response('{}', { status: 200 });
};

function makeEnv({ pools = {} } = {}) {
  const store = new Map();
  const chains = new Map();
  const codePools = {};
  for (const [tier, n] of Object.entries(pools)) {
    codePools[tier] = Array.from({ length: n }, (_, i) => `${tier.slice(0, 2).toUpperCase()}${i + 1}`);
  }

  /* access_token, not accessToken — getBotToken reads the snake_case
     field, and the camelCase spelling falls silently through to the
     refresh path, which then returns null and skips the send entirely. */
  store.set('twitch_bot_token', JSON.stringify({ access_token: 'x', expiresAt: Date.now() + 3600e3 }));
  store.set('twitch_bot_user_id', '555');

  return {
    TWITCH_BROADCASTER_ID: '900',
    TWITCH_CLIENT_ID: 'cid',
    TWITCH_CLIENT_SECRET: 'secret',
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
          store.set(k, JSON.stringify(next));
          return JSON.parse(store.get(k));
        });
        chains.set(k, run.then(() => {}, () => {}));
        return run;
      },
      async listValues() { return []; },
      /* The real one claims atomically from a normalised table; here it is
         just a shift off the front, which is enough to count pulls. */
      async pullGiveawayCode(tier) {
        const pool = codePools[tier];
        return (pool && pool.length) ? pool.shift() : null;
      },
      async giveawayPoolLevels() {
        return Object.fromEntries(Object.entries(codePools).map(([t, p]) => [t, p.length]));
      },
    },
    _store: store,
    _pools: codePools,
  };
}

/* The cooldown is real, so each case gets a fresh store — otherwise the
   second drop in a file would be refused by the first one's timestamp. */
const fresh = (pools) => { chat = []; refuseSend = false; return makeEnv({ pools }); };

/* ── One code, as before ─────────────────────────────────────────────── */
{
  const env = fresh({ rare: 5 });
  const r = await dropCodeAction(env, 'rare', 'tester');
  check('a plain drop succeeds', r.success, true);
  check('and sends one message', chat.length, 1);
  check('taking one from the pool', env._pools.rare.length, 4);
  check('reporting the code', r.codes, [r.code]);
  ok('the message carries the code', chat[0].includes(r.code));
  check('in the terse "<Rarity> - <code> phantomace.tv/giveaway" format a manual drop uses',
    chat[0], `Rare - ${r.code} phantomace.tv/giveaway`);
}

/* ── A milestone drop (sub/giftsub/raid) keeps its richer, headlined
   message -- that format is what says WHY the drop fired, which a bare
   manual drop from the control panel has no need to explain. ──────────── */
{
  const env = fresh({ rare: 5 });
  const r = await dropCodeAction(env, 'rare', 'milestone:sub', {
    headline: 'Ash just subscribed! Thank you!',
  });
  ok('the headline reaches chat', chat[0].includes('Ash just subscribed! Thank you!'));
  ok('alongside the code', chat[0].includes(r.code));
  ok('and the entry value', chat[0].includes(String(TIER_INFO.rare.entries)));
}

/* ── Several codes, one message each ─────────────────────────────────── */
{
  const env = fresh({ common: 20 });
  const r = await dropCodeAction(env, 'common', 'tester', { count: 5 });
  check('five were requested and five sent', r.codes.length, 5);
  /* ONE MESSAGE PER CODE. A line carrying five codes is one thing to miss —
     it scrolls past as a unit and takes all five with it. */
  check('as five separate messages', chat.length, 5);
  check('five came out of the pool', env._pools.common.length, 15);
  check('every code is different', new Set(r.codes).size, 5);
  check('nothing was short', r.short, 0);

  for (let i = 0; i < 5; i++) {
    ok(`message ${i + 1} carries exactly its own code`,
      chat.filter(m => m.includes(r.codes[i])).length === 1);
  }
}

/* ── A pool that runs dry partway ────────────────────────────────────── */
{
  const env = fresh({ mythic: 2 });
  const r = await dropCodeAction(env, 'mythic', 'tester', { count: 5 });
  check('it still succeeds with what it had', r.success, true);
  check('sending only what existed', r.codes.length, 2);
  check('and only two messages', chat.length, 2);
  /* SAYS SO. Quietly sending two when five were asked for is the version of
     this that gets noticed a week later when the pool is empty. */
  check('reporting how many were missing', r.short, 3);
  check('and what was asked for', r.requested, 5);
}

{
  const env = fresh({ rare: 0 });
  const r = await dropCodeAction(env, 'rare', 'tester', { count: 3 });
  check('an empty pool fails outright', r.success, false);
  ok('naming the pool', /rare/.test(r.error));
  check('and sends nothing', chat.length, 0);
}

/* ── The cooldown is per ACTION, not per code ────────────────────────── */
{
  const env = fresh({ common: 50 });
  const first = await dropCodeAction(env, 'common', 'tester', { count: 8 });
  check('eight codes go out on one action', first.codes.length, 8);

  /* Immediately after, the gate is closed — half a second has not passed. */
  const second = await dropCodeAction(env, 'common', 'tester');
  check('a second drop is refused straight away', second.success, false);
  ok('and says it is cooling down', /cool/i.test(second.error));
  check('having sent nothing extra', chat.length, 8);
  check('and taken nothing more from the pool', env._pools.common.length, 42);
}

{
  /* Half a second later it opens again. Short enough to wait out in a test. */
  const env = fresh({ common: 10 });
  await dropCodeAction(env, 'common', 'tester');
  await new Promise(r => setTimeout(r, 600));
  const again = await dropCodeAction(env, 'common', 'tester');
  check('the gate reopens after half a second', again.success, true);
  check('and both drops sent', chat.length, 2);
}

/* ── Bounds ──────────────────────────────────────────────────────────── */
{
  const env = fresh({ common: 100 });
  const r = await dropCodeAction(env, 'common', 'tester', { count: 999 });
  check('an absurd count is capped', r.codes.length, MAX_DROP_COUNT);
}

/* Anything unusable means one code, not zero and not a crash. 1.7 floors to
   1 rather than rounding up — a fractional count is a bug upstream, and
   sending more than asked for is the worse way to be wrong. */
for (const bad of [0, -3, 'abc', null, undefined, 1.7, NaN, Infinity]) {
  const env = fresh({ common: 10 });
  const r = await dropCodeAction(env, 'common', 'tester', { count: bad });
  check(`count ${String(bad)} falls back to one`, r.codes.length, 1);
}

/* But a fractional count above one floors rather than failing. */
{
  const env = fresh({ common: 10 });
  const r = await dropCodeAction(env, 'common', 'tester', { count: 3.9 });
  check('3.9 floors to three', r.codes.length, 3);
}

{
  const env = fresh({ common: 10 });
  const r = await dropCodeAction(env, 'nonsense', 'tester', { count: 3 });
  check('an unknown rarity is refused', r.success, false);
  check('before anything is pulled', env._pools.common.length, 10);
}

/* ── A refused message is reported, not hidden ───────────────────────── */
{
  const env = fresh({ common: 10 });
  refuseSend = true;
  const r = await dropCodeAction(env, 'common', 'tester', { count: 3 });
  check('the codes are still created', r.codes.length, 3);
  /* Twitch accepted the request and declined to post. Saying "dropped to
     chat" here is the lie sendChatMessage used to tell. */
  check('but sent is false', r.sent, false);
  check('and none were actually posted', r.sentCount, 0);
}

/* ── Report ──────────────────────────────────────────────────────────── */
globalThis.fetch = realFetch;

console.log('');
if (failures.length) {
  console.log(`[bot-drops] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[bot-drops] ${passed} assertions passed.`);
console.log('');
