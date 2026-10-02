#!/usr/bin/env node
/* ══════════════════════════════════════════════
   COSMETIC GIFTING — duplicate-only, atomic two-sided transfer

     node server/scripts/test-gift.js   (run from server/)

   The gift handler is run against a fake store that serialises mutate()
   per name exactly as the Postgres advisory lock does, yields between every
   read and write so concurrent gifts interleave, and implements claim() as
   an atomic take — the same harness shape as test-dino-market.js.
   ══════════════════════════════════════════════ */

import * as Gift from '../../functions/api/gift.js';

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

/* ── Fake store ─────────────────────────────────────────────────────── */
const tick = () => new Promise(r => setImmediate(r));

function fakeKV(seed = {}) {
  /* Objects are stored as JSON; bare strings (loginidx_) are stored as-is,
     exactly as the real DAL keeps them. */
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  const locks = new Map();
  async function locked(name, fn) {
    const prev = locks.get(name) || Promise.resolve();
    let release;
    const mine = new Promise(r => { release = r; });
    const tail = prev.then(() => mine);
    locks.set(name, tail);
    await prev;
    try { return await fn(); } finally {
      release();
      if (locks.get(name) === tail) locks.delete(name);
    }
  }
  const read = (k) => {
    if (!store.has(k)) return null;
    try { return JSON.parse(store.get(k)); } catch { return store.get(k); }
  };
  const write = (k, v) => store.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  const listValues = async ({ prefix = '' } = {}) => {
    await tick();
    return [...store.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name, value: read(name) }));
  };
  return {
    store, read,
    async get(k, t) { await tick(); const v = store.get(k); return v === undefined ? null : (t === 'json' ? JSON.parse(v) : v); },
    async put(k, v) { await tick(); write(k, v); },
    async delete(k) { await tick(); store.delete(k); },
    listValues,
    async claim(k) { await tick(); const v = read(k); store.delete(k); return v; },
    mutate(k, fn, _options) {
      return locked(k, async () => {
        await tick();
        const cur = read(k);
        const next = await fn(cur);
        if (next === undefined) return cur;
        await tick();
        write(k, next);
        return next;
      });
    },
    withLock(name, fn) {
      return locked(name, () => fn({
        async get(k, t) { await tick(); const v = store.get(k); return v === undefined ? null : (t === 'json' ? JSON.parse(v) : v); },
        async put(k, v) { await tick(); write(k, v); },
        async delete(k) { await tick(); store.delete(k); },
        listValues,
      }));
    },
  };
}

/* ── Request helpers ────────────────────────────────────────────────── */
const cookie = (id, name) => ({ Cookie: 'pham_session=' + encodeURIComponent(JSON.stringify({ user_id: id, display_name: name || ('P' + id) })) });
async function call(handler, env, url, { method = 'GET', body, as } = {}) {
  const init = { method, headers: { 'Content-Type': 'application/json', ...(as ? cookie(as) : {}) } };
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  const res = await handler({ env, request: new Request('https://phantomace.tv' + url, init) });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}
const giftPost = (env, body, as) => call(Gift.onRequestPost, env, '/api/gift', { method: 'POST', body, as });
const giftGet = (env, as) => call(Gift.onRequestGet, env, '/api/gift', { as });

/* Build one inventory item. */
const item = (id, type, extra = {}) => ({
  id, game: extra.game || 'profile', type, name: extra.name || id,
  rarity: extra.rarity || 'rare', consumable: !!extra.consumable,
  grantedAt: 1, source: 'phamily-time', ...extra,
});
const inv = (userId, items) => ({ userId, items, equips: {} });

/* A world with a sender who owns two of one cosmetic and a real recipient. */
function world(senderItems, { recipient = true } = {}) {
  const seed = {
    inv_sender: inv('sender', senderItems),
    inv_rcpt: inv('rcpt', []),
  };
  if (recipient) {
    seed.loginidx_bob = 'rcpt';
    seed.profile_rcpt = { login: 'bob', displayName: 'Bob' };
  }
  seed.loginidx_alice = 'sender';
  seed.profile_sender = { login: 'alice', displayName: 'Alice' };
  return { MARKETPLACE: fakeKV(seed) };
}
const copies = (env, user, id, type) =>
  env.MARKETPLACE.read('inv_' + user).items.filter(i => i.id === id && i.type === type).length;

/* ══ A duplicate moves exactly one copy ═════════════════════════════ */
{
  const env = world([item('oct-banner', 'banner'), item('oct-banner', 'banner')]);
  const r = await giftPost(env, { action: 'gift', itemId: 'oct-banner', type: 'banner', toLogin: 'bob' }, 'sender');
  check('gifting a duplicate succeeds', r.status, 200);
  check('the response names the recipient', r.data.to, { login: 'bob', displayName: 'Bob' });
  check('the sender is left with exactly one copy', copies(env, 'sender', 'oct-banner', 'banner'), 1);
  check('the recipient gains exactly one copy', copies(env, 'rcpt', 'oct-banner', 'banner'), 1);
  const got = env.MARKETPLACE.read('inv_rcpt').items[0];
  check('the delivered copy is marked as a gift from the sender', [got.source, got.giftedFrom], ['gift', 'sender']);
  ok('and it is non-consumable with a fresh grant time', got.consumable === false && got.grantedAt > 1);
}

/* ── artwork and real fields ride along, request body cannot forge them ── */
{
  const env = world([
    item('crimson', 'dice', { game: 'mana-clash', name: 'Crimson Dice', rarity: 'rare', meta: { image: '/a/dice.png' } }),
    item('crimson', 'dice', { game: 'mana-clash', name: 'Crimson Dice', rarity: 'rare', meta: { image: '/a/dice.png' } }),
  ]);
  const r = await giftPost(env, {
    action: 'gift', itemId: 'crimson', type: 'dice', toLogin: 'bob',
    name: 'HACKED', rarity: 'mythic', game: 'profile',   // ignored — server reads its own copy
  }, 'sender');
  check('a cross-game duplicate (dice) gifts', r.status, 200);
  const got = env.MARKETPLACE.read('inv_rcpt').items[0];
  check('name/rarity/game come from the stored item, not the body', [got.name, got.rarity, got.game], ['Crimson Dice', 'rare', 'mana-clash']);
  check('artwork meta is carried so the recipient can draw it', got.meta.image, '/a/dice.png');
}

/* ══ The last copy can never be gifted ══════════════════════════════ */
{
  const env = world([item('solo-title', 'title')]);
  const r = await giftPost(env, { action: 'gift', itemId: 'solo-title', type: 'title', toLogin: 'bob' }, 'sender');
  check('gifting your only copy is refused', r.status, 400);
  check('the sender keeps it', copies(env, 'sender', 'solo-title', 'title'), 1);
  check('the recipient gets nothing', env.MARKETPLACE.read('inv_rcpt').items.length, 0);
}
{
  /* After gifting one of two, the remaining single copy is protected. */
  const env = world([item('dup', 'badge'), item('dup', 'badge')]);
  await giftPost(env, { action: 'gift', itemId: 'dup', type: 'badge', toLogin: 'bob' }, 'sender');
  const again = await giftPost(env, { action: 'gift', itemId: 'dup', type: 'badge', toLogin: 'bob' }, 'sender');
  check('the now-last copy cannot be gifted', again.status, 400);
  check('and the recipient still has only one', copies(env, 'rcpt', 'dup', 'badge'), 1);
}

/* ══ Two concurrent gifts of the same duplicate cannot dupe ═════════ */
{
  const env = {
    MARKETPLACE: fakeKV({
      inv_sender: inv('sender', [item('cb', 'cardback', { game: 'memory-match' }), item('cb', 'cardback', { game: 'memory-match' })]),
      inv_rcpt: inv('rcpt', []),
      inv_rcpt2: inv('rcpt2', []),
      loginidx_bob: 'rcpt', profile_rcpt: { login: 'bob', displayName: 'Bob' },
      loginidx_cara: 'rcpt2', profile_rcpt2: { login: 'cara', displayName: 'Cara' },
      loginidx_alice: 'sender', profile_sender: { login: 'alice', displayName: 'Alice' },
    }),
  };
  const [a, b] = await Promise.all([
    giftPost(env, { action: 'gift', itemId: 'cb', type: 'cardback', toLogin: 'bob' }, 'sender'),
    giftPost(env, { action: 'gift', itemId: 'cb', type: 'cardback', toLogin: 'cara' }, 'sender'),
  ]);
  check('exactly one of two concurrent gifts wins', [a.status, b.status].sort(), [200, 400]);
  check('the sender keeps the protected last copy', copies(env, 'sender', 'cb', 'cardback'), 1);
  const delivered = copies(env, 'rcpt', 'cb', 'cardback') + copies(env, 'rcpt2', 'cb', 'cardback');
  check('exactly one copy was delivered in total', delivered, 1);
}

/* ══ Bad recipients ═════════════════════════════════════════════════ */
{
  const env = world([item('b', 'banner'), item('b', 'banner')]);
  const nobody = await giftPost(env, { action: 'gift', itemId: 'b', type: 'banner', toLogin: 'ghost' }, 'sender');
  check('gifting to a non-existent member is refused', nobody.status, 404);
  check('and nothing left the sender', copies(env, 'sender', 'b', 'banner'), 2);

  const self = await giftPost(env, { action: 'gift', itemId: 'b', type: 'banner', toLogin: 'alice' }, 'sender');
  check('gifting to yourself is refused', self.status, 400);
  check('and nothing left the sender', copies(env, 'sender', 'b', 'banner'), 2);
}

/* ══ A recipient who already owns it is refused (and the copy is returned) ══ */
{
  const env = {
    MARKETPLACE: fakeKV({
      inv_sender: inv('sender', [item('owned', 'banner'), item('owned', 'banner')]),
      inv_rcpt: inv('rcpt', [item('owned', 'banner')]),
      loginidx_bob: 'rcpt', profile_rcpt: { login: 'bob', displayName: 'Bob' },
      loginidx_alice: 'sender', profile_sender: { login: 'alice', displayName: 'Alice' },
    }),
  };
  const r = await giftPost(env, { action: 'gift', itemId: 'owned', type: 'banner', toLogin: 'bob' }, 'sender');
  check('gifting a cosmetic the recipient already owns is refused', r.status, 409);
  check('the copy is returned to the sender (refund, not vanish)', copies(env, 'sender', 'owned', 'banner'), 2);
  check('the recipient still has exactly one', copies(env, 'rcpt', 'owned', 'banner'), 1);
}

/* ══ Non-giftable kinds ═════════════════════════════════════════════ */
{
  const env = world([
    item('egg', 'egg', { game: 'dino-park', consumable: true, quantity: 2 }),
    item('egg', 'egg', { game: 'dino-park', consumable: true, quantity: 2 }),
  ]);
  const r = await giftPost(env, { action: 'gift', itemId: 'egg', type: 'egg', toLogin: 'bob' }, 'sender');
  check('a consumable type cannot be gifted', r.status, 400);
}
{
  const env = world([item('slot-2', 'room-slot', { id: 'room-slot-2' }), item('slot-2', 'room-slot', { id: 'room-slot-2' })]);
  const r = await giftPost(env, { action: 'gift', itemId: 'room-slot-2', type: 'room-slot', toLogin: 'bob' }, 'sender');
  check('a room-slot capacity unlock cannot be gifted', r.status, 400);
}

/* ══ Auth + bad input ═══════════════════════════════════════════════ */
{
  const env = world([item('b', 'banner'), item('b', 'banner')]);
  const out = await giftPost(env, { action: 'gift', itemId: 'b', type: 'banner', toLogin: 'bob' });
  check('a logged-out sender is refused', out.status, 401);
  const noItem = await giftPost(env, { action: 'gift', type: 'banner', toLogin: 'bob' }, 'sender');
  check('a gift with no item is refused', noItem.status, 400);
  const noWho = await giftPost(env, { action: 'gift', itemId: 'b', type: 'banner' }, 'sender');
  check('a gift with no recipient is refused', noWho.status, 400);
  const bad = await giftPost(env, { action: 'nope' }, 'sender');
  check('an unknown action is refused', bad.status, 400);
}

/* ══ The recipient's bell ═══════════════════════════════════════════ */
{
  const env = world([item('oct-badge', 'badge'), item('oct-badge', 'badge')]);
  await giftPost(env, { action: 'gift', itemId: 'oct-badge', type: 'badge', toLogin: 'bob' }, 'sender');
  const first = await giftGet(env, 'rcpt');
  check('the recipient reads one pending gift notice', first.data.gifts.length, 1);
  check('the notice names the sender and the item', [first.data.gifts[0].fromName, first.data.gifts[0].item.name], ['Psender', 'oct-badge']);
  const second = await giftGet(env, 'rcpt');
  check('the notice is cleared once read (read-and-clear)', second.data.gifts.length, 0);
  const sender = await giftGet(env, 'sender');
  check('the sender has no gift notices of their own', sender.data.gifts.length, 0);
}

/* ══ Report ═════════════════════════════════════════════════════════ */
console.log('');
if (failures.length) {
  console.log(`[gift] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[gift] ${passed} assertions passed.`);
console.log('');
