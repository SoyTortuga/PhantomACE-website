#!/usr/bin/env node
/* ══════════════════════════════════════════════
   PHAMILY QUESTS — test suite

     node server/scripts/test-quests.js   (run from the server/ directory)

   The four things that actually matter about a quest are pinned here:

     - it completes ONLY when its goal is actually met (progress is read
       server-side from real signals, never from the request),
     - claiming it pays EXACTLY ONCE — a second claim, or two at the same
       instant, is a no-op, verified against the giveaway ledger and the
       Phamily minutes that must not move twice,
     - a new week (a different weekKey) is a fresh row: nothing stays claimed
       and last week's signals no longer count, and
     - a completed claim WRITES a notice, which the bell announces, and an ack
       clears it.

   No database: the KV shim is faked in memory with the same behaviour the real
   DAL has (serialised mutate() per key, listValues by prefix), and the clock is
   pinned so weekKey/monthKey are deterministic.
   ══════════════════════════════════════════════ */

/* ── A clock the tests control ───────────────────────────────────────────
   Thursday, Oct 15 2026, noon Pacific — mid-week and mid-month, so the ISO
   week (Mon Oct 12 – Sun Oct 18) sits entirely inside October. */
const RealDate = Date;
let FAKE_NOW = RealDate.parse('2026-10-15T19:00:00Z');
globalThis.Date = class extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(FAKE_NOW); }
  static now() { return FAKE_NOW; }
};
const setNow = (iso) => { FAKE_NOW = RealDate.parse(iso); };

import * as quests from '../../functions/api/quests.js';
import { weekKey, monthKey } from '../../functions/api/season-time.js';
import { ledgerKey } from '../../functions/api/giveaway-entries.js';

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
      async listValues({ prefix }) {
        const out = [];
        for (const [name, raw] of store) if (name.startsWith(prefix)) out.push({ name, value: JSON.parse(raw) });
        return out;
      },
    },
    _store: store,
  };
}

const UID = '42';
const USER = { user_id: UID, display_name: 'Quester' };
const cookie = () => `pham_session=${encodeURIComponent(JSON.stringify(USER))}`;

async function get(env, withSession = true) {
  const headers = {};
  if (withSession) headers.Cookie = cookie();
  const res = await quests.onRequestGet({ env, request: new Request('https://t.local/api/quests', { headers }) });
  return { status: res.status, data: await res.json() };
}
async function post(env, body, withSession = true) {
  const headers = { 'Content-Type': 'application/json' };
  if (withSession) headers.Cookie = cookie();
  const res = await quests.onRequestPost({
    env, request: new Request('https://t.local/api/quests', { method: 'POST', headers, body: JSON.stringify(body) }),
  });
  return { status: res.status, data: await res.json() };
}

/* Seed every signal the W42 quests read, all inside that week. */
function seedAll(env) {
  const streams = [];
  for (let day = 12; day <= 18; day++) streams.push({ streamId: 's' + day, at: Date.UTC(2026, 9, day, 19, 0, 0) });
  env._store.set(`ci_${UID}`, JSON.stringify({ userId: UID, username: 'Quester', streams }));
  env._store.set(`pt_${UID}_2026-10`, JSON.stringify({
    userId: UID, month: '2026-10', hours: 0, level: 0,
    claimedRewards: [], claimedMilestones: [], attendance: { '15': 7 }, lastHeartbeat: 0,
  }));
  env._store.set(`roomvisits_${UID}_2026-W42`, JSON.stringify({ count: 3 }));
  env._store.set('lb_memory_match', JSON.stringify([{ id: UID, name: 'Quester', score: 20, updatedAt: Date.UTC(2026, 9, 15, 19, 0, 0) }]));
}
const ledger = (env, month = monthKey()) => {
  const raw = env._store.get(ledgerKey(UID, month));
  return raw ? JSON.parse(raw) : null;
};
const ptHours = (env, month = monthKey()) => {
  const raw = env._store.get(`pt_${UID}_${month}`);
  return raw ? JSON.parse(raw).hours : null;
};

async function main() {
  const WK = weekKey();
  check('the test week is W42', WK, '2026-W42');
  const active = quests.questsForWeek(WK);
  check('W42 offers four quests', active.length, 4);
  ok('and includes the minutes-paying quest', active.some(q => q.reward.type === 'minutes'));
  ok('and at least one entries-paying quest', active.some(q => q.reward.type === 'entries'));

  /* ── 1. A quest is not complete, and cannot be claimed, until its goal is
     actually met ── */
  {
    const env = makeEnv();
    const g = await get(env);
    check('unmet: GET succeeds', g.status, 200);
    check('unmet: nothing reads complete', g.data.quests.filter(q => q.completed).map(q => q.id), []);
    check('unmet: nothing reads claimed', g.data.quests.filter(q => q.claimed).map(q => q.id), []);

    const claim = await post(env, { action: 'claim', questId: 'answer-call' });
    check('unmet: claim is refused', claim.status, 400);
    check('unmet: and says why', claim.data.error, 'Quest not complete yet');
    check('unmet: no entries were paid', ledger(env), null);
  }

  /* ── 2. Met goals complete; each claim pays once; a notice is written ── */
  {
    const env = makeEnv();
    seedAll(env);

    const g = await get(env);
    check('met: every active quest reads complete',
      g.data.quests.filter(q => q.completed).map(q => q.id).sort(), active.map(q => q.id).sort());
    check('met: none claimed yet', g.data.quests.filter(q => q.claimed).map(q => q.id), []);

    let expectedEntries = 0;
    let expectedMinutes = 0;
    for (const q of active) {
      const r = await post(env, { action: 'claim', questId: q.id });
      check(`met: claiming ${q.id} succeeds`, r.status, 200);
      if (q.reward.type === 'entries') expectedEntries += q.reward.amount;
      if (q.reward.type === 'minutes') expectedMinutes += q.reward.amount;
      const again = await post(env, { action: 'claim', questId: q.id });
      check(`met: a second claim of ${q.id} is refused`, again.status, 400);
      check(`met: and named already claimed for ${q.id}`, again.data.error, 'Already claimed');
    }

    check('pay-once: the ledger holds the summed entries, not more',
      (ledger(env) || {}).entries, expectedEntries);
    check('pay-once: pass hours rose by the minutes reward exactly once',
      ptHours(env), Math.round((expectedMinutes / 60) * 10) / 10);

    const after = await get(env);
    check('notice: one notice was written per claimed quest', (after.data.notices || []).length, active.length);
    ok('notice: each carries the quest it is for',
      after.data.notices.every(n => n.questId && n.title && n.reward));
    check('after claiming, every quest reads claimed',
      after.data.quests.filter(q => q.claimed).map(q => q.id).sort(), active.map(q => q.id).sort());

    const ack = await post(env, { action: 'ack-notices' });
    check('ack: succeeds', ack.status, 200);
    check('ack: clears the notices the bell has announced', (await get(env)).data.notices, []);
  }

  /* ── 3. Two claims of the same quest at the same instant pay once ── */
  {
    const env = makeEnv();
    seedAll(env);
    const entriesQuest = active.find(q => q.reward.type === 'entries');
    const [a, b] = await Promise.all([
      post(env, { action: 'claim', questId: entriesQuest.id }),
      post(env, { action: 'claim', questId: entriesQuest.id }),
    ]);
    check('race: exactly one claim succeeds', [a.status, b.status].filter(s => s === 200).length, 1);
    check('race: the other is refused as already claimed',
      [a, b].find(r => r.status !== 200).data.error, 'Already claimed');
    check('race: the ledger was paid once', (ledger(env) || {}).entries, entriesQuest.reward.amount);
  }

  /* ── 4. A new week is a fresh row: nothing claimed, last week's signals
     no longer count ── */
  {
    const env = makeEnv();
    seedAll(env);
    for (const q of active) await post(env, { action: 'claim', questId: q.id });
    check('rollover: W42 quests were all claimed first',
      (await get(env)).data.quests.every(q => q.claimed), true);

    setNow('2026-10-22T19:00:00Z');
    const nextWk = weekKey();
    check('the clock has rolled to the next week', nextWk, '2026-W43');
    const g = await get(env);
    check('rollover: a fresh week logs you in', g.data.loggedIn, true);
    check('rollover: nothing is claimed in the new week', g.data.quests.filter(q => q.claimed).map(q => q.id), []);
    check('rollover: last week\'s signals do not carry over',
      g.data.quests.filter(q => q.completed).map(q => q.id), []);
    setNow('2026-10-15T19:00:00Z');
  }

  /* ── 5. Logged-out shape: the quests show, progress does not ── */
  {
    const env = makeEnv();
    const g = await get(env, false);
    check('anon: GET still lists the week\'s quests', g.data.quests.length, 4);
    check('anon: not logged in', g.data.loggedIn, false);
    const claim = await post(env, { action: 'claim', questId: 'answer-call' }, false);
    check('anon: a claim is refused with 401', claim.status, 401);
  }

  if (failures.length) {
    console.error(`\n[quests] ${failures.length} FAILED:\n  - ` + failures.join('\n  - '));
    process.exit(1);
  }
  console.log(`[quests] ${passed} assertions passed.`);
}

main().catch((err) => { console.error('[quests]', err); process.exit(1); });
