#!/usr/bin/env node
/* ══════════════════════════════════════════════
   ROLES AND SUB TIER — test suite

     node server/scripts/test-roles.js

   A person can be a moderator AND a Tier 1 subscriber. Those are
   independent facts, and the session used to carry one string for both, so
   whichever was written last erased the other. It failed in both directions
   and neither said anything:

     - recheck-roles set `role` from the live subscription check
       unconditionally, so a moderator who subscribes was demoted to
       sub_tier1 the moment any page called it — and Phamily Time calls it on
       load. Every moderator-only control then vanished, because the reissued
       cookie said sub_tier1.

     - When moderator DID win, it erased the tier. BOOST_RATES had no
       'moderator' key, so `BOOST_RATES[role] || 1` quietly paid 1x instead
       of 1.33x, and Dino Park handed out three incubator slots instead of
       six. Nobody looks at an incubator and suspects a role string.

   So the thing under test is that both facts survive together.
   ══════════════════════════════════════════════ */

import * as recheck from '../../functions/api/auth/recheck-roles.js';

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}

/* ── Twitch, faked at the fetch boundary ─────────────────────────────── */
const realFetch = globalThis.fetch;
let twitch = { sub: null, follows: false, subOk: true };

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/helix/subscriptions/user')) {
    if (!twitch.subOk) return new Response('{}', { status: 500 });
    const data = twitch.sub ? [{ tier: twitch.sub }] : [];
    return new Response(JSON.stringify({ data }), { status: 200 });
  }
  if (u.includes('/helix/channels/followed')) {
    return new Response(JSON.stringify({ data: twitch.follows ? [{ followed_at: 'x' }] : [] }), { status: 200 });
  }
  if (u.includes('oauth2/token')) {
    return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 });
  }
  return realFetch(url);
};

function makeEnv({ moderators = [] } = {}) {
  const store = new Map();
  store.set('site_moderators', JSON.stringify({
    entries: moderators.map(id => ({ userId: String(id), name: 'Mod', addedBy: 'test' })),
  }));
  return {
    TWITCH_BROADCASTER_ID: '900',
    TWITCH_CLIENT_ID: 'cid',
    TWITCH_CLIENT_SECRET: 'secret',
    SESSION_SECRET: 'x'.repeat(48),
    MARKETPLACE: {
      async get(k, t) { if (!store.has(k)) return null; const r = store.get(k); return t === 'json' ? JSON.parse(r) : r; },
      async put(k, v) { store.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
      async delete(k) { store.delete(k); },
      async mutate(k, fn) {
        const cur = store.has(k) ? JSON.parse(store.get(k)) : null;
        const next = await fn(cur);
        if (next === undefined) return cur;
        store.set(k, JSON.stringify(next));
        return JSON.parse(store.get(k));
      },
      async listValues() { return []; },
    },
  };
}

async function doRecheck(env, session) {
  const res = await recheck.onRequestGet({
    env,
    request: new Request('https://t.local/api/auth/recheck-roles', {
      headers: { Cookie: `pham_session=${encodeURIComponent(JSON.stringify(session))}` },
    }),
  });
  return { status: res.status, data: await res.json() };
}

const MOD_SUB = { user_id: '101', display_name: 'Mod', role: 'moderator', subTier: 1 };

/* ── A subscription must not demote a moderator ──────────────────────── */
{
  const env = makeEnv({ moderators: ['101'] });
  twitch = { sub: '1000', follows: true, subOk: true };

  const r = await doRecheck(env, MOD_SUB);
  check('a subscribing moderator stays a moderator', r.data.role, 'moderator');
  check('and keeps their tier', r.data.subTier, 1);
}

{
  /* The exact sequence that was reported: logged in as a moderator, opened a
     page that rechecks, came back a Tier 1 subscriber. */
  const env = makeEnv({ moderators: ['101'] });
  twitch = { sub: '1000', follows: true, subOk: true };

  let session = { user_id: '101', display_name: 'Mod', role: 'moderator', subTier: 1 };
  for (let i = 0; i < 3; i++) {
    const r = await doRecheck(env, session);
    session = { ...session, role: r.data.role, subTier: r.data.subTier };
  }
  check('three rechecks do not wear the role away', session.role, 'moderator');
  check('and the tier is still there', session.subTier, 1);
}

/* ── Tier still tracks reality ───────────────────────────────────────── */
{
  const env = makeEnv({ moderators: ['101'] });

  twitch = { sub: '3000', follows: true, subOk: true };
  let r = await doRecheck(env, MOD_SUB);
  check('an upgrade to tier 3 is picked up', r.data.subTier, 3);
  check('while they remain a moderator', r.data.role, 'moderator');

  twitch = { sub: null, follows: true, subOk: true };
  r = await doRecheck(env, MOD_SUB);
  check('letting the sub lapse drops the tier', r.data.subTier, 0);
  check('but not the moderator role', r.data.role, 'moderator');
}

/* ── Ordinary subscribers are unaffected ─────────────────────────────── */
{
  const env = makeEnv();
  twitch = { sub: '2000', follows: true, subOk: true };

  const r = await doRecheck(env, { user_id: '202', display_name: 'Sub', role: 'follower', subTier: 0 });
  check('a plain subscriber gets the sub role', r.data.role, 'sub_tier2');
  check('and the matching tier', r.data.subTier, 2);
}

{
  const env = makeEnv();
  twitch = { sub: null, follows: true, subOk: true };
  const r = await doRecheck(env, { user_id: '202', display_name: 'Sub', role: 'sub_tier1', subTier: 1 });
  check('a lapsed subscriber falls back to follower', r.data.role, 'follower');
  check('with no tier', r.data.subTier, 0);
}

/* ── Being added to the list takes effect without logging out ────────── */
{
  const env = makeEnv({ moderators: ['303'] });
  twitch = { sub: '1000', follows: true, subOk: true };

  /* Their cookie predates the promotion and says sub_tier1. */
  const r = await doRecheck(env, { user_id: '303', display_name: 'New', role: 'sub_tier1', subTier: 1 });
  check('a newly listed moderator is promoted on recheck', r.data.role, 'moderator');
  check('keeping their tier', r.data.subTier, 1);
}

/* ── Removal takes effect too ────────────────────────────────────────── */
{
  const env = makeEnv();                       // no longer on the list
  twitch = { sub: '1000', follows: true, subOk: true };

  const r = await doRecheck(env, { user_id: '101', display_name: 'Ex', role: 'moderator', subTier: 1 });
  check('a removed moderator loses the role', r.data.role, 'sub_tier1');
  check('and is left with what they actually are', r.data.subTier, 1);
}

/* ── A check that cannot check must change nothing ───────────────────── */
{
  const env = makeEnv({ moderators: ['101'] });
  twitch = { sub: '1000', follows: false, subOk: false };

  const r = await doRecheck(env, MOD_SUB);
  check('an unavailable check reports unverified', r.data.verified, false);
  check('and leaves the role alone', r.data.role, 'moderator');
  check('and the tier alone', r.data.subTier, 1);
}

/* ── Cookies issued before subTier existed ───────────────────────────── */
{
  const env = makeEnv();
  twitch = { sub: null, follows: true, subOk: true };

  /* No subTier field at all. It must fall back to the role rather than
     reading undefined and treating a tier 3 sub as tier 0. */
  const r = await doRecheck(env, { user_id: '404', display_name: 'Old', role: 'sub_tier3' });
  check('an old cookie still resolves its tier', r.data.subTier, 0);   // sub has lapsed
  check('and its role follows', r.data.role, 'follower');
}

{
  const env = makeEnv();
  twitch = { sub: '3000', follows: true, subOk: false };
  const r = await doRecheck(env, { user_id: '404', display_name: 'Old', role: 'sub_tier3' });
  check('an old cookie with no check available keeps its derived tier', r.data.subTier, 3);
}

/* ── The broadcaster outranks everything ─────────────────────────────── */
{
  const env = makeEnv({ moderators: ['900'] });
  twitch = { sub: '1000', follows: true, subOk: true };

  const r = await doRecheck(env, { user_id: '900', display_name: 'PhantomACE', role: 'broadcaster', subTier: 3 });
  check('the broadcaster is never demoted', r.data.role, 'broadcaster');
}

/* ── Report ──────────────────────────────────────────────────────────── */
globalThis.fetch = realFetch;

console.log('');
if (failures.length) {
  console.log(`[roles] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[roles] ${passed} assertions passed.`);
console.log('');
