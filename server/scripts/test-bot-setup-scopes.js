#!/usr/bin/env node
/* ══════════════════════════════════════════════
   AN UNGRANTED SCOPE COSTS ITS OWN FEATURE, AND NOTHING ELSE

     node server/scripts/test-bot-setup-scopes.js

   RUNS OFFLINE. Stubs Helix and drives the real create-eventsub action.

   WHY THIS EXISTS. Step 4 used to refuse the entire request with a 409 when
   channel:read:hype_train was missing. Pressing Create Subscriptions then
   created NOTHING — not channel.update, which needs no scope at all, not the
   chat message subscription, nothing — while the page went on showing the
   count of subscriptions that already existed. It looked like a partial
   success and was a total no-op.

   The ad-break and bits scopes were already handled the right way: skip that
   one type, report a row naming the button to press, carry on. Hype train was
   the lone hard abort. So what is asserted here is the RULE, for every gated
   scope: the gated type is skipped, a row says which permission is missing,
   and every ungated type still goes up.
   ══════════════════════════════════════════════ */

import { createEventSubSubscriptions } from '../../functions/api/admin/bot-setup.js';

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

let created = [];

function stubFetch(scopes) {
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('oauth2/validate')) {
      return scopes === null
        ? new Response('{}', { status: 401 })
        : new Response(JSON.stringify({ scopes }), { status: 200 });
    }
    if (u.includes('oauth2/token')) {
      return new Response(JSON.stringify({ access_token: 'app-token', expires_in: 3600 }), { status: 200 });
    }
    if (u.includes('/helix/eventsub/subscriptions')) {
      created.push(JSON.parse(opts.body).type);
      return new Response(JSON.stringify({ data: [{ id: 'x' }] }), { status: 202 });
    }
    return new Response('{}', { status: 200 });
  };
}

function makeEnv() {
  const store = new Map([
    ['twitch_bot_user_id', '555'],
    ['giveaway_reward_id', 'reward-1'],
    ['twitch_broadcaster_token', JSON.stringify({ access_token: 'b-token' })],
  ]);
  return {
    TWITCH_CLIENT_ID: 'cid',
    TWITCH_CLIENT_SECRET: 'csec',
    TWITCH_BROADCASTER_ID: '900',
    TWITCH_EVENTSUB_SECRET: 'sec',
    MARKETPLACE: {
      async get(k, t) { const v = store.get(k); if (v == null) return null; return t === 'json' ? JSON.parse(v) : v; },
      async put(k, v) { store.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
      async delete(k) { store.delete(k); },
    },
  };
}

const request = new Request('https://phantomace.tv/api/admin/bot-setup', { method: 'POST' });

async function run(scopes) {
  created = [];
  stubFetch(scopes);
  const res = await createEventSubSubscriptions(makeEnv(), request);
  return { status: res.status, body: await res.json(), created: [...created] };
}

/* Every scope any subscription on the list depends on. If a new gated type
   is added and this is not updated, the "fully granted" block below fails
   with that type's own row — which is the intended way to find out. */
const ALL = [
  'channel:read:hype_train', 'channel:read:ads', 'bits:read',
  'channel:read:redemptions', 'channel:read:predictions', 'moderator:read:followers',
];

/* ── With every scope, everything goes up ────────────────────────────────── */
{
  const r = await run(ALL);
  check('a fully granted channel succeeds', r.status, 200);
  ok('all three hype train phases subscribe', ['begin', 'progress', 'end']
    .every(p => r.created.includes(`channel.hype_train.${p}`)));
  ok('ad breaks subscribe', r.created.includes('channel.ad_break.begin'));
  ok('bits subscribe', r.created.includes('channel.bits.use'));
  ok('predictions subscribe', r.created.includes('channel.prediction.begin'));
  ok('follows subscribe', r.created.includes('channel.follow'));
  ok('cheers subscribe', r.created.includes('channel.cheer'));
  ok('nothing is reported as failed', r.body.results.every(x => x.ok));

  /* The gate is per subscription, not per handler: every entry that depends
     on a channel permission must declare it, or it gets posted anyway and
     comes back as Twitch's unactionable "subscription missing proper
     authorization". That is exactly how predictions, follows and cheers
     produced six bare red crosses naming neither a scope nor a button. */
  const ungated = await run([]);
  for (const type of [
    'channel.prediction.begin', 'channel.prediction.progress',
    'channel.prediction.lock', 'channel.prediction.end',
    'channel.follow', 'channel.cheer', 'channel.ad_break.begin',
    'channel.bits.use', 'channel.hype_train.begin',
    'channel.channel_points_custom_reward_redemption.add',
  ]) {
    ok(`${type} declares the scope it needs`, !ungated.created.includes(type));
  }
  ok('and with nothing granted, only the unscoped types are posted',
    ungated.created.every(t => ['channel.update', 'channel.chat.message', 'channel.subscribe',
      'channel.subscription.gift', 'channel.subscription.message', 'channel.raid'].includes(t)));

  /* Grouped: four prediction types are one problem and one button press. */
  const predRow = ungated.body.results.filter(x => /prediction/.test(x.type));
  check('four prediction types make ONE row', predRow.length, 1);
  ok('naming all four', ['begin', 'progress', 'lock', 'end']
    .every(ph => predRow[0].type.includes(ph)));
  ok('and saying what it costs', /overlay prediction panel/.test(predRow[0].error));
}

/* ── THE REGRESSION: no hype train scope must not block the rest ─────────── */
{
  const r = await run(ALL.filter(s => s !== 'channel:read:hype_train'));

  check('the request still succeeds', r.status, 200);
  ok('it is NOT a 409 refusal', !r.body.error);

  /* The one that made this visible: it needs no scope whatsoever, so there is
     no reading under which a missing hype train grant should stop it. */
  ok('channel.update still subscribes', r.created.includes('channel.update'));
  ok('chat messages still subscribe', r.created.includes('channel.chat.message'));
  ok('ad breaks still subscribe', r.created.includes('channel.ad_break.begin'));
  ok('bits still subscribe', r.created.includes('channel.bits.use'));
  ok('something was actually created', r.created.length >= 5);

  ok('no hype train subscription is attempted',
    !r.created.some(t => t.startsWith('channel.hype_train')));

  const row = r.body.results.find(x => /hype_train/.test(x.type));
  ok('a row reports the missing grant', row && row.ok === false);
  ok('and it names the scope', row && /channel:read:hype_train/.test(row.error));
  ok('and it names the button to press', row && /Authorize Channel Points/.test(row.error));
}

/* ── Each gated scope behaves the same way ───────────────────────────────── */
for (const [scope, type] of [
  ['channel:read:hype_train', 'channel.hype_train.begin'],
  ['channel:read:ads', 'channel.ad_break.begin'],
  ['bits:read', 'channel.bits.use'],
  ['channel:read:predictions', 'channel.prediction.begin'],
  ['moderator:read:followers', 'channel.follow'],
  ['channel:read:redemptions', 'channel.channel_points_custom_reward_redemption.add'],
]) {
  const r = await run(ALL.filter(s => s !== scope));
  ok(`without ${scope}, its own type is skipped`, !r.created.includes(type));
  ok(`without ${scope}, channel.update still goes up`, r.created.includes('channel.update'));
  ok(`without ${scope}, a row explains why`,
    r.body.results.some(x => x.ok === false && x.error.includes(scope)));
}

/* ── An unreadable broadcaster token is the same story ───────────────────
   Not "no scopes granted" — no token to ask. The unscoped types still work,
   and the page must say which it is rather than silently subscribing less. */
{
  const r = await run(null);
  check('an unreadable token still succeeds', r.status, 200);
  ok('channel.update still subscribes', r.created.includes('channel.update'));
  ok('no scope-gated type is attempted',
    !r.created.some(t => /hype_train|ad_break|bits\.use|prediction|follow|cheer|redemption/.test(t)));
  ok('and a row names the token, not a scope',
    r.body.results.some(x => x.ok === false && /broadcaster token/i.test(x.type)));
}

/* ── Only successes are recorded ─────────────────────────────────────────
   The stored list drives the "N active" count on the page. Counting the
   skipped rows is how a missing grant comes to look like a working one. */
{
  created = [];
  stubFetch(ALL.filter(s => s !== 'channel:read:hype_train'));
  const env = makeEnv();
  await createEventSubSubscriptions(env, request);
  const stored = JSON.parse(await env.MARKETPLACE.get('eventsub_subscriptions'));
  ok('the stored list holds no failed row',
    !stored.some(x => /hype_train/.test(x.type)));
  check('and counts exactly what went up', stored.length, created.length);
}

console.log('');
if (failures.length) {
  console.log(`[bot-setup-scopes] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[bot-setup-scopes] ${passed} assertions passed.`);
console.log('');
