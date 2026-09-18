#!/usr/bin/env node
/* ══════════════════════════════════════════════
   RARITY GIVEAWAY DRAWS — test suite

     node server/scripts/test-giveaway-draw.js

   A draw now has a rarity, and that one fact has to reach three places that
   were previously independent: the channel points reward that gets switched
   on, the redemptions that count as entries, and what the winner's code is
   worth. Every assertion here is about one of those three staying in step.

   THE BUG THIS SUITE EXISTS FOR. `send-code` pulled a code from the pool
   and whispered it, and nothing ever registered it as claimable. The winner
   pasted a real code into the box on /giveaway and was told it was not
   valid. It is invisible to any test of the pool, of the whisper, or of the
   panel — only driving the whole path and then trying to claim the code
   catches it, which is what the "a won code is claimable" block does.

   No database: the KV shim is faked in memory, and Helix is intercepted so
   the PATCH calls can be counted rather than sent.
   ══════════════════════════════════════════════ */

import { signEventSub } from '../lib/eventsub.js';
import { entryRarityForTitle, addEntrant } from '../../functions/api/bot/giveaway-entry.js';
import {
  registerDropCode, redeemDropCode, recordPrize, getPrize,
  getGiveawaySummary, PRIZE_WINDOW_SECONDS, DROP_WINDOW_SECONDS,
} from '../../functions/api/giveaway-entries.js';
import * as control from '../../functions/api/bot/giveaway.js';
import * as channelPoints from '../../functions/api/channel-points.js';

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

const BROADCASTER = '900';
const SECRET = 'a-test-eventsub-secret';

/* ── The fake channel ─────────────────────────────────────────────────── */

const REWARDS = [
  { id: 'rw-rare', title: 'Enter Rare Giveaway' },
  { id: 'rw-mythic', title: 'Enter Mythic Giveaway' },
  { id: 'rw-legacy', title: 'Enter Giveaway' },
];

let patches = [];       // { id, is_enabled }
let whispers = [];      // { to, message }
let settlements = [];   // { redemptionId, rewardId, status }

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = opts.method || 'GET';

  if (u.includes('/helix/channel_points/custom_rewards/redemptions')) {
    const q = new URL(u).searchParams;
    settlements.push({
      redemptionId: q.get('id'),
      rewardId: q.get('reward_id'),
      status: JSON.parse(opts.body).status,
    });
    return new Response(JSON.stringify({ data: [{ id: q.get('id') }] }), { status: 200 });
  }
  if (u.includes('/helix/channel_points/custom_rewards')) {
    if (method === 'GET') {
      /* Every one of these is MANAGEABLE in the fake, so only_manageable
         does not change the answer — the flag is asserted on separately. */
      return new Response(JSON.stringify({ data: REWARDS }), { status: 200 });
    }
    const id = new URL(u).searchParams.get('id');
    patches.push({ id, ...JSON.parse(opts.body) });
    return new Response(JSON.stringify({ data: [{ id }] }), { status: 200 });
  }
  if (u.includes('/helix/whispers')) {
    whispers.push({ to: new URL(u).searchParams.get('to_user_id'), message: JSON.parse(opts.body).message });
    return new Response(null, { status: 204 });
  }
  if (u.includes('oauth2/token') || u.includes('oauth2/validate')) {
    return new Response(JSON.stringify({ access_token: 't', expires_in: 3600, scopes: [] }), { status: 200 });
  }
  return new Response('{}', { status: 200 });
};

function makeEnv({ pools = { rare: 3, mythic: 2, common: 3 } } = {}) {
  const store = new Map();
  const chains = new Map();
  const codePools = {};
  for (const [tier, n] of Object.entries(pools)) {
    codePools[tier] = Array.from({ length: n }, (_, i) => `${tier.slice(0, 2).toUpperCase()}CODE${i + 1}`);
  }

  store.set('twitch_bot_token', JSON.stringify({ access_token: 'x', expiresAt: Date.now() + 3600e3 }));
  store.set('twitch_bot_user_id', '555');
  store.set('twitch_broadcaster_token', JSON.stringify({ access_token: 'b', expiresAt: Date.now() + 3600e3 }));

  return {
    TWITCH_BROADCASTER_ID: BROADCASTER,
    TWITCH_CLIENT_ID: 'cid',
    TWITCH_CLIENT_SECRET: 'secret',
    TWITCH_EVENTSUB_SECRET: SECRET,
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
      async listValues({ prefix }) {
        const out = [];
        for (const [name, raw] of store) {
          if (name.startsWith(prefix)) out.push({ name, value: JSON.parse(raw) });
        }
        return out;
      },
      async pullGiveawayCode(tier) {
        const pool = codePools[tier];
        return (pool && pool.length) ? pool.shift() : null;
      },
    },
    _store: store,
    _pools: codePools,
  };
}

const session = (userId = BROADCASTER, name = 'PhantomACE') =>
  encodeURIComponent(JSON.stringify({ user_id: userId, display_name: name }));

function panelRequest(body, userId = BROADCASTER) {
  return new Request('https://phantomace.tv/api/bot/giveaway', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `pham_session=${session(userId)}` },
    body: JSON.stringify(body),
  });
}

const post = (env, body, userId) => control.onRequestPost({ env, request: panelRequest(body, userId) });

async function redemptionRequest(title, userId, username) {
  const raw = JSON.stringify({
    subscription: { type: 'channel.channel_points_custom_reward_redemption.add' },
    event: {
      id: 'r-' + userId, user_id: String(userId), user_name: username,
      reward: { id: 'rw', title },
    },
  });
  const messageId = 'mid-' + userId + '-' + title;
  const ts = new Date().toISOString();
  return new Request('https://phantomace.tv/api/channel-points', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'twitch-eventsub-message-type': 'notification',
      'twitch-eventsub-message-id': messageId,
      'twitch-eventsub-message-timestamp': ts,
      'twitch-eventsub-message-signature': await signEventSub(SECRET, messageId, ts, raw),
    },
    body: raw,
  });
}

const entrants = (env) => {
  const rec = env._store.get('giveaway_entrants');
  return rec ? JSON.parse(rec).entrants.map(e => e.username) : [];
};

const fresh = (pools) => { patches = []; whispers = []; settlements = []; return makeEnv(pools ? { pools } : undefined); };

/* ── Title → rarity ──────────────────────────────────────────────────── */
{
  check('the rare reward enters a rare draw', entryRarityForTitle('Enter Rare Giveaway'), 'rare');
  check('the mythic reward enters a mythic draw', entryRarityForTitle('Enter Mythic Giveaway'), 'mythic');
  /* The legacy reward predates rarities, so it matches whatever is open —
     null, which is a different answer from "this is not an entry reward". */
  check('the legacy reward has no rarity of its own', entryRarityForTitle('Enter Giveaway'), null);
  check('casing and stray spaces do not matter', entryRarityForTitle('  enter MYTHIC giveaway '), 'mythic');
  check('an unrelated reward is not an entry', entryRarityForTitle('Hydrate!'), false);
  check('a missing title is not an entry', entryRarityForTitle(undefined), false);
}

/* ── Opening a draw ──────────────────────────────────────────────────── */
{
  const env = fresh();
  const noRarity = await post(env, { action: 'toggle', open: true });
  check('opening without a rarity is refused', noRarity.status, 400);
  check('and nothing was switched on', patches.length, 0);

  const bad = await post(env, { action: 'toggle', open: true, rarity: 'legendary' });
  check('an unknown rarity is refused', bad.status, 400);

  const r = await post(env, { action: 'toggle', open: true, rarity: 'mythic' });
  const body = await r.json();
  check('opening a mythic draw succeeds', body.success, true);
  check('and records the rarity', body.rarity, 'mythic');
  check('the state carries it too', JSON.parse(env._store.get('giveaway_state')).rarity, 'mythic');

  /* ONE DRAW AT A TIME: the mythic reward on, the rare one explicitly off. */
  check('the mythic reward was enabled', patches.find(p => p.id === 'rw-mythic'), { id: 'rw-mythic', is_enabled: true });
  check('and the rare one disabled', patches.find(p => p.id === 'rw-rare'), { id: 'rw-rare', is_enabled: false });
  check('nothing else was touched', patches.length, 2);
  check('no stray reward was left on', body.strays, []);

  /* Resolved by title once, then cached — the second open must not re-list. */
  check('the reward id was cached by title', env._store.get('giveaway_reward_mythic_id'), 'rw-mythic');
}

/* ── Closing reuses the open draw's rarity ───────────────────────────── */
{
  const env = fresh();
  await post(env, { action: 'toggle', open: true, rarity: 'rare' });
  patches = [];
  const r = await post(env, { action: 'toggle', open: false });
  const body = await r.json();
  check('closing needs no rarity', body.success, true);
  /* A moderator who closes without naming a rarity must not close the WRONG
     reward and leave the open one redeemable. */
  check('and closes the reward that was open', patches, [{ id: 'rw-rare', is_enabled: false }]);
  check('the rarity survives the close', body.rarity, 'rare');
}

/* ── Entries come in through the catch-all subscription ──────────────── */
{
  const env = fresh();
  await post(env, { action: 'toggle', open: true, rarity: 'mythic' });

  const res = await channelPoints.onRequestPost({ env, request: await redemptionRequest('Enter Mythic Giveaway', '1', 'alice') });
  check('a mythic redemption is accepted', res.status, 200);
  check('and puts the viewer on the wheel', entrants(env), ['alice']);

  /* ONE SLICE PER PERSON. Twitch happily allows repeat redemptions. */
  await channelPoints.onRequestPost({ env, request: await redemptionRequest('Enter Mythic Giveaway', '1', 'alice') });
  check('redeeming twice is still one slice', entrants(env), ['alice']);

  /* THE WRONG RARITY. Both rewards are never enabled at once, but a
     redemption in flight when the draw changed would otherwise land on a
     wheel its owner did not pay into. */
  await channelPoints.onRequestPost({ env, request: await redemptionRequest('Enter Rare Giveaway', '2', 'bob') });
  check('a rare redemption does not join a mythic draw', entrants(env), ['alice']);

  /* The legacy reward has its own subscription pointed elsewhere; routing it
     here as well would be two paths to keep in step for no gain. */
  await channelPoints.onRequestPost({ env, request: await redemptionRequest('Enter Giveaway', '3', 'carol') });
  check('the legacy reward is not routed through channel-points', entrants(env), ['alice']);

  /* An unrelated reward must not enter anyone. */
  await channelPoints.onRequestPost({ env, request: await redemptionRequest('Hydrate!', '4', 'dave') });
  check('an unrelated reward enters nobody', entrants(env), ['alice']);
}

/* ── THE POINT FOLLOWS THE ANSWER ────────────────────────────────────── */
{
  /* The wheel always held one slice per person; Twitch kept charging for
     every extra redemption because nothing answered it. Now the first
     entry is FULFILLED (spent) and everything refused — a duplicate, a
     redemption after the draw closed, the wrong rarity — is CANCELED,
     which refunds the point. This is why the entry rewards leave the
     request queue open: a skipped-queue redemption is fulfilled on arrival
     and can never be refunded. */
  const env = fresh();
  await post(env, { action: 'toggle', open: true, rarity: 'mythic' });
  settlements = [];

  await channelPoints.onRequestPost({ env, request: await redemptionRequest('Enter Mythic Giveaway', '1', 'alice') });
  check('the first entry is fulfilled, spending the point',
    settlements.map(s => s.status), ['FULFILLED']);

  await channelPoints.onRequestPost({ env, request: await redemptionRequest('Enter Mythic Giveaway', '1', 'alice') });
  check('a duplicate is cancelled, refunding it',
    settlements.map(s => s.status), ['FULFILLED', 'CANCELED']);
  check('while the wheel still holds one slice', entrants(env), ['alice']);

  await channelPoints.onRequestPost({ env, request: await redemptionRequest('Enter Rare Giveaway', '2', 'bob') });
  check('the wrong rarity is refunded too',
    settlements[settlements.length - 1].status, 'CANCELED');

  await post(env, { action: 'toggle', open: false });
  settlements = [];
  await channelPoints.onRequestPost({ env, request: await redemptionRequest('Enter Mythic Giveaway', '3', 'carol') });
  check('a redemption after the draw closes is refunded',
    settlements.map(s => s.status), ['CANCELED']);

  /* The refund mechanism only exists if the rewards keep their queue open.
     A future edit flipping COMMON back to skip would pass every test above
     — the stub cannot tell — and silently make every CANCELED call 400
     against real Twitch. */
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const script = fs.readFileSync(path.join(REPO, 'server/scripts/giveaway-rewards.js'), 'utf8');
  ok('the entry rewards leave the redemption queue open',
    /should_redemptions_skip_request_queue: false/.test(script));
}

/* ── A closed draw takes nobody ──────────────────────────────────────── */
{
  const env = fresh();
  const r = await addEntrant(env, '1', 'alice', 'mythic');
  check('entering before a draw opens is refused', r, { ok: false, reason: 'closed' });

  await post(env, { action: 'toggle', open: true, rarity: 'rare' });
  await post(env, { action: 'toggle', open: false });
  const after = await addEntrant(env, '1', 'alice', 'rare');
  check('and refused again once it closes', after.ok, false);
  check('with nobody recorded', entrants(env), []);
}

/* ── The legacy reward matches whatever is open ──────────────────────── */
{
  const env = fresh();
  await post(env, { action: 'toggle', open: true, rarity: 'rare' });
  const r = await addEntrant(env, '7', 'erin', null);
  check('a rarity-less entry joins the open draw', r, { ok: true });
  check('and appears on the wheel', entrants(env), ['erin']);
}

/* ── Picking stamps the rarity on the winner ─────────────────────────── */
{
  const env = fresh();
  await post(env, { action: 'toggle', open: true, rarity: 'mythic' });
  await addEntrant(env, '1', 'alice', 'mythic');

  const r = await post(env, { action: 'pick-winner' });
  const body = await r.json();
  check('a winner is drawn', body.winner.username, 'alice');
  check('carrying the draw rarity', body.rarity, 'mythic');
  check('stored on the winner record', JSON.parse(env._store.get('giveaway_winner')).rarity, 'mythic');
}

/* ── An empty wheel does not spin ────────────────────────────────────── */
{
  const env = fresh();
  await post(env, { action: 'toggle', open: true, rarity: 'rare' });
  const r = await post(env, { action: 'pick-winner' });
  check('picking with nobody entered is refused', r.status, 400);
}

/* ── THE PRIZE: a won code is claimable, and only by its winner ──────── */
{
  const env = fresh({ mythic: 2 });
  await post(env, { action: 'toggle', open: true, rarity: 'mythic' });
  await addEntrant(env, '11', 'winner', 'mythic');
  await post(env, { action: 'pick-winner' });

  const r = await post(env, { action: 'send-code' });
  const body = await r.json();
  check('the code is sent', body.success, true);
  check('at the rarity of the draw', body.rarity, 'mythic');
  check('worth the mythic entry value', body.entries, 50);
  check('one code came out of the mythic pool', env._pools.mythic.length, 1);
  check('and a whisper went out as well', whispers.length, 1);

  const prize = await getPrize(env, '11');
  ok('the winner has a prize waiting', !!prize);
  check('not yet claimed', prize.claimed, false);
  check('at the draw rarity', prize.tier, 'mythic');

  /* THE BUG. Before this, the code existed only in a whisper. */
  const stranger = await redeemDropCode(env, '99', 'stranger', prize.code);
  check('a stranger cannot claim it', stranger, { ok: false, reason: 'locked' });

  const won = await redeemDropCode(env, '11', 'winner', prize.code);
  check('the winner can', won.ok, true);
  check('for the mythic entry value', won.entries, 50);

  const after = await getPrize(env, '11');
  check('and the card then reads as claimed', after.claimed, true);

  const again = await redeemDropCode(env, '11', 'winner', prize.code);
  check('claiming twice adds nothing', again, { ok: false, reason: 'already' });
}

/* ── An undelivered winner blocks the next draw ──────────────────────── */
{
  const env = fresh({ rare: 2, mythic: 2 });
  await post(env, { action: 'toggle', open: true, rarity: 'rare' });
  await addEntrant(env, '21', 'winner', 'rare');
  await post(env, { action: 'pick-winner' });
  patches = [];

  /* Opening entries clears the previous winner. That was harmless when a
     winner was a name on a screen; it destroys a real prize now. */
  const blocked = await post(env, { action: 'toggle', open: true, rarity: 'mythic' });
  check('reopening before the code is sent is refused', blocked.status, 409);
  check('and no reward was switched on', patches, []);
  check('the winner is still there', JSON.parse(env._store.get('giveaway_winner')).username, 'winner');

  /* The prize belongs to the draw that was won, whatever is open now. */
  const body = await (await post(env, { action: 'send-code' })).json();
  check('the code matches the draw that was won', body.rarity, 'rare');
  check('and is worth the rare value', body.entries, 15);
  check('the mythic pool is untouched', env._pools.mythic.length, 2);

  /* Once delivered, the next draw opens and starts clean. */
  const reopened = await post(env, { action: 'toggle', open: true, rarity: 'mythic' });
  const r = await reopened.json();
  check('a delivered draw no longer blocks the next one', r.success, true);
  check('and the wheel starts empty', entrants(env), []);
}

/* ── Reset is the escape hatch ───────────────────────────────────────── */
{
  const env = fresh({ rare: 2 });
  await post(env, { action: 'toggle', open: true, rarity: 'rare' });
  await addEntrant(env, '22', 'winner', 'rare');
  await post(env, { action: 'pick-winner' });

  await post(env, { action: 'reset' });
  const r = await (await post(env, { action: 'toggle', open: true, rarity: 'mythic' })).json();
  check('a reset draw does not block the next one', r.success, true);
  check('and no code was burned', env._pools.rare.length, 2);
}

/* ── A locked code stays off the public feed ─────────────────────────── */
{
  const env = fresh();
  await registerDropCode(env, 'LOCKED1', 'mythic', 50, {
    source: 'giveaway-win', lockedTo: '11', ttlSeconds: PRIZE_WINDOW_SECONDS, announce: false,
  });
  const feed = env._store.get('live_drops');
  /* Publishing a code nobody but one person may use is an invitation to
     try it, and every attempt is a refusal the viewer cannot explain. */
  check('a locked code is not announced', feed ? JSON.parse(feed).drops.length : 0, 0);

  await registerDropCode(env, 'PUBLIC1', 'common', 2, { source: 'manual' });
  check('an ordinary drop still is', JSON.parse(env._store.get('live_drops')).drops.map(d => d.code), ['PUBLIC1']);
}

/* ── Windows ─────────────────────────────────────────────────────────── */
{
  check('a drop is claimable for five minutes', DROP_WINDOW_SECONDS, 300);
  /* A prize is not a race, so it does not expire while its winner sleeps. */
  check('a prize is claimable for seven days', PRIZE_WINDOW_SECONDS, 7 * 86400);

  const env = fresh();
  const p = await recordPrize(env, '31', { code: 'abc123', tier: 'rare', entries: 15 });
  check('the code is stored upper-cased, as codes are claimed', p.code, 'ABC123');
  const week = 7 * 86400 * 1000;
  ok('and expires a week out', Math.abs(p.expiresAt - (Date.now() + week)) < 5000);
}

/* ── The giveaway page sees the prize ────────────────────────────────── */
{
  const env = fresh({ rare: 2 });
  await post(env, { action: 'toggle', open: true, rarity: 'rare' });
  await addEntrant(env, '41', 'winner', 'rare');
  await post(env, { action: 'pick-winner' });
  await post(env, { action: 'send-code' });

  const mine = await getGiveawaySummary(env, { user_id: '41', display_name: 'winner' });
  ok('the winner is shown their prize', !!mine.prize);
  check('with its rarity', mine.prize.tier, 'rare');
  check('and its entry value', mine.prize.entries, 15);

  const theirs = await getGiveawaySummary(env, { user_id: '42', display_name: 'someone-else' });
  /* The code is the prize. Anyone else reading it would make "locked" a
     formality. */
  check('nobody else sees it', theirs.prize, null);

  const anon = await getGiveawaySummary(env, null);
  check('and a logged-out visitor sees none', anon.prize, null);
}

/* ── Moderation gate ─────────────────────────────────────────────────── */
{
  const env = fresh();
  const r = await post(env, { action: 'toggle', open: true, rarity: 'rare' }, '12345');
  check('a viewer cannot open a draw', r.status, 403);
  check('and nothing was switched on', patches.length, 0);
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[giveaway-draw] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[giveaway-draw] ${passed} assertions passed.`);
console.log('');
