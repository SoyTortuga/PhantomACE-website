#!/usr/bin/env node
/* ══════════════════════════════════════════════
   BADGE CLAIM CODES — test suite

     node server/scripts/test-badge-code.js

   Drives the real item-code handlers against a fake store. The thing under
   test is mostly one field.

   A badge's artwork lives in `meta.image`, and the path from "mint a code"
   to "it shows up in an inventory" rebuilds the item THREE times — in
   createItemCode, in handleRedeem, and in handleGrant. Each one picks fields
   explicitly, which is the right instinct, and each one had silently dropped
   the artwork. The failure is quiet: the badge still grants, the tile still
   renders, it just falls back to the slot emoji and looks like a missing
   asset rather than a discarded field. Nothing errors, so nothing tells you.
   ══════════════════════════════════════════════ */

import {
  createItemCode, activateItemCode, onRequestPost,
} from '../../functions/api/item-codes.js';

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

function makeEnv() {
  const store = new Map();
  return {
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

const USERS = {
  a: { user_id: '101', display_name: 'Ash', role: 'member' },
  b: { user_id: '202', display_name: 'Bry', role: 'member' },
};

async function redeem(env, who, code) {
  const res = await onRequestPost({
    env,
    request: new Request('https://test.local/api/item-codes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `pham_session=${encodeURIComponent(JSON.stringify(USERS[who]))}`,
      },
      body: JSON.stringify({ action: 'redeem', code }),
    }),
  });
  return { status: res.status, data: await res.json() };
}

const BADGE = {
  id: 'dino-park-beta', game: 'profile', type: 'badge',
  name: 'Dino Park Beta', rarity: 'rare', image: '/assets/badges/dino-park-beta.png',
};

const DAY = 24 * 60 * 60;

/* ── The artwork survives the whole round trip ───────────────────────── */
{
  const env = makeEnv();
  const rec = await createItemCode(env, BADGE);
  check('the code record keeps the artwork', rec.item.image, BADGE.image);
  check('and it is public by default', rec.restrictedTo, null);
  check('and inactive until activated', rec.active, false);

  const active = await activateItemCode(env, rec.code, 7 * DAY);
  ok('activation sets an expiry', active.expiresAt > Date.now());
  const days = (active.expiresAt - Date.now()) / (DAY * 1000);
  ok('seven days, not seven minutes', days > 6.9 && days < 7.1);

  const r = await redeem(env, 'a', rec.code);
  check('redeeming succeeds', r.status, 200);

  const inv = await env.MARKETPLACE.get('inv_101', 'json');
  const item = inv.items.find(i => i.id === BADGE.id);
  ok('the badge reached the inventory', !!item);
  check('WITH its artwork', item && item.meta && item.meta.image, BADGE.image);
  check('and is marked as code-sourced', item.source, 'item-code');
}

/* ── Open to everyone, once each ─────────────────────────────────────── */
{
  const env = makeEnv();
  const rec = await createItemCode(env, BADGE);
  await activateItemCode(env, rec.code, 7 * DAY);

  check('the first claim works', (await redeem(env, 'a', rec.code)).status, 200);
  check('a different account may also claim', (await redeem(env, 'b', rec.code)).status, 200);
  /* The point of a chat code: not spent by the first person to use it. */
  check('the same account cannot claim twice', (await redeem(env, 'a', rec.code)).status, 409);

  const stored = await env.MARKETPLACE.get(`item_code_${rec.code}`, 'json');
  check('both claims are recorded', stored.redeemedBy.sort(), ['101', '202']);

  const invB = await env.MARKETPLACE.get('inv_202', 'json');
  const itemB = invB.items.find(i => i.id === BADGE.id);
  check('the second claimer got the artwork too',
    itemB && itemB.meta && itemB.meta.image, BADGE.image);
}

/* ── The window actually closes ──────────────────────────────────────── */
{
  const env = makeEnv();
  const rec = await createItemCode(env, BADGE);
  await activateItemCode(env, rec.code, 7 * DAY);

  /* Wind the expiry into the past rather than waiting a week. */
  const key = `item_code_${rec.code}`;
  const stored = await env.MARKETPLACE.get(key, 'json');
  stored.expiresAt = Date.now() - 1000;
  await env.MARKETPLACE.put(key, JSON.stringify(stored));

  const r = await redeem(env, 'a', rec.code);
  check('an expired code is refused', r.status, 410);
  check('and says so plainly', r.data.error, 'Code has expired');
  check('nothing was granted', await env.MARKETPLACE.get('inv_101', 'json'), null);
}

/* ── An unactivated code is not claimable ────────────────────────────── */
{
  const env = makeEnv();
  const rec = await createItemCode(env, BADGE);
  const r = await redeem(env, 'a', rec.code);
  check('a minted but unannounced code cannot be used', r.status, 400);
}

/* ── Artwork paths are constrained ───────────────────────────────────────
   A code record is rendered in a viewer's browser, so an off-site URL would
   be an image address of someone else's choosing loaded by everyone who
   redeems. */
{
  const env = makeEnv();
  for (const bad of ['https://evil.example/x.png', '//evil.example/x.png', 'assets/x.png', 42]) {
    let threw = false;
    try { await createItemCode(env, { ...BADGE, image: bad }); } catch { threw = true; }
    ok(`rejects artwork "${String(bad).slice(0, 28)}"`, threw);
  }
  let fine = true;
  try { await createItemCode(env, { ...BADGE, image: '/assets/badges/x.png' }); } catch { fine = false; }
  ok('accepts a site-relative path', fine);

  /* An item with no artwork at all must still work — most items have none. */
  const plain = await createItemCode(env, { id: 'x', game: 'profile', type: 'title', name: 'Title' });
  check('an item without artwork stores null', plain.item.image, null);
  await activateItemCode(env, plain.code, DAY);
  await redeem(env, 'b', plain.code);
  const inv = await env.MARKETPLACE.get('inv_202', 'json');
  const it = inv.items.find(i => i.id === 'x');
  ok('and lands in the inventory with no meta key at all', it && it.meta === undefined);
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[badge-code] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[badge-code] ${passed} assertions passed.`);
console.log('');
