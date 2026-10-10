#!/usr/bin/env node
/* ══════════════════════════════════════════════
   REWARDS #8 — next-month preview, past winners, duplicate→entries

     node server/scripts/test-phamily-preview-winners.js   (from server/)

   Covers the four parts added in Rewards #8:

   PART 1 — the tables endpoint now ships `next`, the month AFTER the live one,
     equal to the canonical rewardTablesFor(nextMonthKey) — the data behind the
     locked "Next month" preview tab. (current/prev are already pinned by
     test-phamily-tables.js; this adds next.)

   PART 3 — GET /api/hype-train?action=winners returns recent MONTHLY-ledger
     winners, newest first, bounded, ONLY the ones whose prize code went out
     (sent), and WITHOUT leaking the code or the userId. Names are returned raw
     (JSON, not HTML); the giveaway page escapes them on render — asserted here
     as a drift guard against giveaway.js.

   PART 4 — claiming a NON-giveaway cosmetic the viewer already owns converts
     grantItem's no-op into a rarity-based giveaway-entry credit (common 2,
     uncommon 5, rare 15, mythic 50), exactly once: a second claim is refused by
     the claim ratchet before it can credit again. A not-yet-owned cosmetic still
     grants the item and credits nothing. Giveaway-type rewards are untouched
     (they are auto-credited on the heartbeat, and a manual claim no-ops).

   Fake KV stands in for MARKETPLACE exactly as test-phamily-autocredit.js does:
   per-key serialised mutate(), unlocked get/put, and a prefix-filtering
   listValues() for the winners read.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* ── A clock the tests control: noon Pacific on Oct 15, so monthKey() is
   '2026-10' and nextMonthKey() is '2026-11'. ──────────────────────────────── */
const RealDate = Date;
let FAKE_NOW = RealDate.parse('2026-10-15T19:00:00Z');
globalThis.Date = class extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(FAKE_NOW); }
  static now() { return FAKE_NOW; }
};

import * as R from '../../functions/api/phamily-rewards.js';
import * as phamilyTime from '../../functions/api/phamily-time.js';
import { onRequestGet as hypeGet } from '../../functions/api/hype-train.js';
import { ledgerKey } from '../../functions/api/giveaway-entries.js';
import { monthKey, nextMonthKey, nextMonthOf } from '../../functions/api/season-time.js';

const MK = monthKey();
const NEXT = nextMonthKey();

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
  const chains = new Map();
  return {
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
      async listValues({ prefix = '' } = {}) {
        const out = [];
        for (const [k, v] of store) if (k.startsWith(prefix)) out.push({ name: k, value: JSON.parse(v) });
        return out;
      },
    },
    _store: store,
  };
}

const USERS = {
  sub: { user_id: '501', display_name: 'Subby', role: 'sub_tier1', subTier: 1 },
  viewer: { user_id: '202', display_name: 'Viewer', role: 'follower', subTier: 0 },
};
const cookie = (who) => `pham_session=${encodeURIComponent(JSON.stringify(USERS[who]))}`;

function seedUser(env, userId, { level = 0, month = MK } = {}) {
  env._store.set(`pt_${userId}_${month}`, JSON.stringify({
    userId, month, hours: level, level,
    claimedRewards: [], claimedMilestones: [], attendance: {}, lastHeartbeat: 0,
  }));
}
function seedItem(env, userId, item) {
  const key = `inv_${userId}`;
  const inv = env._store.has(key) ? JSON.parse(env._store.get(key)) : { userId, items: [], equips: {} };
  inv.items.push(item);
  env._store.set(key, JSON.stringify(inv));
}
const userData = (env, userId, month = MK) => {
  const raw = env._store.get(`pt_${userId}_${month}`);
  return raw ? JSON.parse(raw) : null;
};
const ledgerEntries = (env, userId) => {
  const raw = env._store.get(ledgerKey(userId, MK));
  return raw ? JSON.parse(raw).entries : 0;
};
const inventory = (env, userId) => {
  const raw = env._store.get(`inv_${userId}`);
  return raw ? JSON.parse(raw) : { items: [] };
};

async function post(env, who, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (who) headers.Cookie = cookie(who);
  const res = await phamilyTime.onRequestPost({
    env, request: new Request('https://t.local/api/phamily-time', { method: 'POST', headers, body: JSON.stringify(body) }),
  });
  return { status: res.status, data: await res.json() };
}

check('the test clock is October', MK, '2026-10');
check('nextMonthKey rolls to November', NEXT, '2026-11');
check('nextMonthOf rolls a December into the next year', nextMonthOf('2026-12'), '2027-01');

/* ══ PART 1 — the tables endpoint ships `next` = rewardTablesFor(nextMonthKey) ═ */
{
  const res = await phamilyTime.onRequestGet({
    env: {},
    request: new Request('https://phantomace.tv/api/phamily-time?action=tables'),
  });
  ok('tables served without a session', res.status === 200);
  const data = await res.json();

  const shape = (t) => ({ month: t.month, follower: t.follower, phamily: t.phamily, milestones: t.milestones });
  ok('the response carries a next month', !!data.next);
  check('next.month is the month after the live one', data.next.month, NEXT);
  check('next follower track is the canonical next-month one',
    data.next.follower, shape(R.rewardTablesFor(NEXT)).follower);
  check('next phamily track is the canonical next-month one',
    data.next.phamily, shape(R.rewardTablesFor(NEXT)).phamily);
  check('next milestones are the canonical next-month ones',
    data.next.milestones, shape(R.rewardTablesFor(NEXT)).milestones);
  /* November is itself a themed month, so the preview really is skinned. */
  check('next shows November\'s themed card back', data.next.follower
    .find(r => r.level === 10 && r.type === 'cardback').name, 'Withered Wheat Card Back');
  ok('no byKey leaks into next', !('byKey' in data.next));
}

/* ══ PART 3 — the past-winners read ═══════════════════════════════════════ */
{
  const env = makeEnv();
  /* Three per-month records across months, plus a legacy single key. */
  env._store.set('giveaway_monthly_winner_2026-09', JSON.stringify({
    userId: 'u9', username: '<b>NineWinner</b>', month: '2026-09', entries: 30,
    rarity: 'mythic', sent: true, code: 'SECRET-NINE',
  }));
  env._store.set('giveaway_monthly_winner_2026-08', JSON.stringify({
    userId: 'u8', username: 'EightWinner', month: '2026-08', entries: 12,
    rarity: 'mythic', sent: true, code: 'SECRET-EIGHT',
  }));
  /* Drawn but not yet sent — still provisional, must NOT be public. */
  env._store.set('giveaway_monthly_winner_2026-07', JSON.stringify({
    userId: 'u7', username: 'SevenPending', month: '2026-07', entries: 5,
    rarity: 'mythic', sent: false,
  }));
  /* The legacy exact key (no trailing month) must not be swept in by the
     prefix read. */
  env._store.set('giveaway_monthly_winner', JSON.stringify({
    userId: 'u6', username: 'LegacySix', month: '2026-06', sent: true,
  }));

  const res = await hypeGet({
    env, request: new Request('https://phantomace.tv/api/hype-train?action=winners'),
  });
  ok('winners read answers 200', res.status === 200);
  const { winners } = await res.json();

  check('only the two SENT per-month winners are returned', winners.map(w => w.month), ['2026-09', '2026-08']);
  check('they are newest-first', winners[0].month, '2026-09');
  check('the display name is carried through (raw — the page escapes it)',
    winners[0].username, '<b>NineWinner</b>');
  check('the prize tier and entries come through', [winners[0].rarity, winners[0].entries], ['mythic', 30]);
  ok('the prize CODE never leaves the server', winners.every(w => !('code' in w)));
  ok('the winner userId never leaves the server', winners.every(w => !('userId' in w)));
}

/* Drift guard: the giveaway page escapes the winner name on render, never
   interpolating it raw — the server returns it unescaped by design. */
{
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const REPO = path.resolve(HERE, '../..');
  const js = fs.readFileSync(path.join(REPO, 'js/pages/giveaway.js'), 'utf8');
  ok('giveaway.js renders the winner name through esc()', /esc\(\s*w\.username\s*\)/.test(js));
  ok('giveaway.js never interpolates the winner name raw', !/\+\s*w\.username\s*\+/.test(js));
}

/* ══ PART 4 — duplicate cosmetic → +N entries (exactly once) ═══════════════ */

/* The real table, not a copy: a pass reward and a chat drop pay from the
   same economy, and that is the thing worth checking. */
const { ENTRIES_BY_RARITY } = await import('../../functions/api/giveaway-entries.js');

/* The follower level-10 card back: a non-giveaway cosmetic, common (2 entries),
   keyed by the item NAME it is granted under. */
const CARDBACK_KEY = '10_follower_cardback_common';
const cardbackReward = R.findReward(CARDBACK_KEY, MK);
const cardbackItemId = R.nameKeyedItemId('cardback', cardbackReward.name);

/* ── P4a — a cosmetic the viewer ALREADY owns credits entries once ───────── */
{
  const env = makeEnv();
  seedUser(env, USERS.viewer.user_id, { level: 10 });
  /* Pre-own the exact card back this claim would grant. */
  seedItem(env, USERS.viewer.user_id, { id: cardbackItemId, type: 'cardback', name: cardbackReward.name, consumable: false });

  const claim = await post(env, 'viewer', { action: 'claim-reward', rewardKey: CARDBACK_KEY });
  check('the duplicate-cosmetic claim answers 200', claim.status, 200);
  check('a common duplicate credits 2 entries', ledgerEntries(env, USERS.viewer.user_id), ENTRIES_BY_RARITY.common);
  check('no second card back was added to the inventory',
    inventory(env, USERS.viewer.user_id).items.filter(i => i.type === 'cardback').length, 1);
  check('the key is recorded as claimed', userData(env, USERS.viewer.user_id).claimedRewards, [CARDBACK_KEY]);

  /* The ledger history labels it as a duplicate conversion. */
  const led = JSON.parse(env._store.get(ledgerKey(USERS.viewer.user_id, MK)));
  ok('the ledger source marks it a duplicate conversion',
    led.history.some(h => String(h.source || '').startsWith('phamily-dupe:')));

  /* A second claim is refused by the ratchet — it must NOT credit again. */
  const again = await post(env, 'viewer', { action: 'claim-reward', rewardKey: CARDBACK_KEY });
  check('a second claim is refused', again.status, 400);
  check('and credits nothing further', ledgerEntries(env, USERS.viewer.user_id), ENTRIES_BY_RARITY.common);
}

/* ── P4b — a NOT-yet-owned cosmetic still grants the item, no conversion ──── */
{
  const env = makeEnv();
  seedUser(env, USERS.viewer.user_id, { level: 10 });

  const claim = await post(env, 'viewer', { action: 'claim-reward', rewardKey: CARDBACK_KEY });
  check('the first-time claim answers 200', claim.status, 200);
  check('the card back lands in the inventory',
    inventory(env, USERS.viewer.user_id).items.filter(i => i.type === 'cardback').length, 1);
  check('and NO entries were credited (no duplicate conversion)', ledgerEntries(env, USERS.viewer.user_id), 0);
}

/* ── P4c — a rare duplicate credits the rare amount ──────────────────────── */
{
  /* Follower level 95 dice is rare (15 entries), granted by cosmeticId. */
  const DICE_KEY = '95_follower_dice_rare';
  const diceReward = R.findReward(DICE_KEY, MK);
  const env = makeEnv();
  seedUser(env, USERS.viewer.user_id, { level: 95 });
  seedItem(env, USERS.viewer.user_id, { id: diceReward.cosmeticId, type: 'dice', consumable: false });

  await post(env, 'viewer', { action: 'claim-reward', rewardKey: DICE_KEY });
  check('a rare duplicate credits 15 entries', ledgerEntries(env, USERS.viewer.user_id), ENTRIES_BY_RARITY.rare);
}

/* ── P4d — giveaway-type rewards are untouched by the dupe path ───────────── */
{
  const env = makeEnv();
  seedUser(env, USERS.viewer.user_id, { level: 2 });

  const claim = await post(env, 'viewer', { action: 'claim-reward', rewardKey: '2_follower_giveaway_common' });
  check('a giveaway-reward claim answers 200', claim.status, 200);
  ok('and reports it was auto-credited', claim.data.autoCredited === true);
  check('the manual claim adds NOTHING to the ledger (heartbeat does the credit)',
    ledgerEntries(env, USERS.viewer.user_id), 0);
  check('no inventory item was granted for a giveaway reward',
    inventory(env, USERS.viewer.user_id).items.length, 0);
  check('and nothing was recorded as claimed', userData(env, USERS.viewer.user_id).claimedRewards, []);
}

/* ── Report ──────────────────────────────────────────────────────────── */
FAKE_NOW = RealDate.parse('2026-10-15T19:00:00Z');
globalThis.Date = RealDate;

console.log('');
if (failures.length) {
  console.log(`[phamily-preview-winners] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[phamily-preview-winners] ${passed} assertions passed.`);
console.log('');
