#!/usr/bin/env node
/* ══════════════════════════════════════════════
   FREE ALTERNATE METHOD OF ENTRY (AMOE) — test suite

     node server/scripts/test-giveaway-amoe.js

   The free entry is the sweepstakes' no-strings path in, so the two things
   that actually matter are pinned here:
     - it grants EXACTLY ONE entry per account per month, even under two
       simultaneous taps (the guarantee is one locked mutate()), and
     - it never blocks across months, never touches another user, and the
       route gates on a login while staying free.

   No database: the KV shim is faked in memory, matching how the real DAL
   behaves (serialised mutate() per key, listValues by prefix).
   ══════════════════════════════════════════════ */

import {
  claimFreeEntry, getGiveawaySummary, ledgerKey, monthKey, prevMonthKey, AMOE_ENTRIES,
} from '../../functions/api/giveaway-entries.js';
import * as amoe from '../../functions/api/giveaway-amoe.js';

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
        for (const [name, raw] of store) {
          if (name.startsWith(prefix)) out.push({ name, value: JSON.parse(raw) });
        }
        return out;
      },
    },
    _store: store,
  };
}

const row = (env, userId, month = monthKey()) => {
  const raw = env._store.get(ledgerKey(userId, month));
  return raw ? JSON.parse(raw) : null;
};

const cookie = (userId, name = 'Viewer') =>
  `pham_session=${encodeURIComponent(JSON.stringify({ user_id: userId, display_name: name }))}`;

const postReq = (userId) => new Request('https://phantomace.tv/api/giveaway-amoe', {
  method: 'POST',
  headers: userId ? { Cookie: cookie(userId) } : {},
});

async function main() {
  const M = monthKey();

  /* ── 1. First claim grants exactly one entry and marks the row ── */
  {
    const env = makeEnv();
    const r = await claimFreeEntry(env, 'u1', 'One');
    check('first claim ok', r.ok, true);
    check('first claim total', r.total, AMOE_ENTRIES);
    const rec = row(env, 'u1');
    check('row entries', rec.entries, AMOE_ENTRIES);
    ok('row flagged claimed', rec.amoeClaimed === true);
    check('history source is amoe', rec.history.map(h => h.source), ['amoe']);
    check('month stamped', rec.month, M);
  }

  /* ── 2. Second claim is a no-op: no second entry ── */
  {
    const env = makeEnv();
    await claimFreeEntry(env, 'u1', 'One');
    const r2 = await claimFreeEntry(env, 'u1', 'One');
    check('second claim refused', r2.ok, false);
    check('second claim reason', r2.reason, 'already');
    check('still one entry', row(env, 'u1').entries, AMOE_ENTRIES);
    check('history not doubled', row(env, 'u1').history.length, 1);
  }

  /* ── 3. Two simultaneous taps grant one entry, not two ── */
  {
    const env = makeEnv();
    const [a, b] = await Promise.all([
      claimFreeEntry(env, 'u2', 'Two'),
      claimFreeEntry(env, 'u2', 'Two'),
    ]);
    check('exactly one of the race won', [a.ok, b.ok].filter(Boolean).length, 1);
    check('race left one entry', row(env, 'u2').entries, AMOE_ENTRIES);
  }

  /* ── 4. Free entry stacks on top of earned entries, preserving them ── */
  {
    const env = makeEnv();
    env._store.set(ledgerKey('u3', M), JSON.stringify({
      userId: 'u3', username: 'Three', month: M, entries: 9,
      history: [{ source: 'drop:rare', entries: 9, at: 1 }],
    }));
    const r = await claimFreeEntry(env, 'u3', 'Three');
    check('stacks onto earned', r.total, 9 + AMOE_ENTRIES);
    check('earned entries preserved', row(env, 'u3').entries, 9 + AMOE_ENTRIES);
    ok('earned row now flagged', row(env, 'u3').amoeClaimed === true);
  }

  /* ── 5. The flag is per-month: a claim last month never blocks this one ── */
  {
    const env = makeEnv();
    const PM = prevMonthKey();
    env._store.set(ledgerKey('u4', PM), JSON.stringify({
      userId: 'u4', username: 'Four', month: PM, entries: 1, amoeClaimed: true, history: [],
    }));
    const r = await claimFreeEntry(env, 'u4', 'Four');
    check('new month allows a fresh claim', r.ok, true);
    check('this month has its own entry', row(env, 'u4', M).entries, AMOE_ENTRIES);
    ok('last month untouched', row(env, 'u4', PM).entries === 1);
  }

  /* ── 6. Each user gets their own free entry ── */
  {
    const env = makeEnv();
    await claimFreeEntry(env, 'uA', 'A');
    await claimFreeEntry(env, 'uB', 'B');
    check('user A has one', row(env, 'uA').entries, AMOE_ENTRIES);
    check('user B has one', row(env, 'uB').entries, AMOE_ENTRIES);
  }

  /* ── 7. The summary reflects whether you've claimed ── */
  {
    const env = makeEnv();
    const before = await getGiveawaySummary(env, { user_id: 'u5', display_name: 'Five' });
    check('summary before: not claimed', before.you.amoeClaimed, false);
    await claimFreeEntry(env, 'u5', 'Five');
    const after = await getGiveawaySummary(env, { user_id: 'u5', display_name: 'Five' });
    check('summary after: claimed', after.you.amoeClaimed, true);
    check('summary after: entry counted', after.you.entries, AMOE_ENTRIES);
  }

  /* ── 8. The route: login required, success, then 409 ── */
  {
    const env = makeEnv();
    const anon = await amoe.onRequestPost({ env, request: postReq(null) });
    check('no session → 401', anon.status, 401);

    const first = await amoe.onRequestPost({ env, request: postReq('u6') });
    const firstBody = await first.json();
    check('first POST → 200', first.status, 200);
    check('first POST success', firstBody.success, true);
    check('first POST total', firstBody.total, AMOE_ENTRIES);

    const second = await amoe.onRequestPost({ env, request: postReq('u6') });
    const secondBody = await second.json();
    check('second POST → 409', second.status, 409);
    ok('409 carries a message', typeof secondBody.error === 'string' && secondBody.error.length > 0);
    check('route left exactly one entry', row(env, 'u6').entries, AMOE_ENTRIES);
  }

  if (failures.length) {
    console.error(`\n[giveaway-amoe] ${failures.length} FAILED:\n  - ` + failures.join('\n  - '));
    process.exit(1);
  }
  console.log(`[giveaway-amoe] ${passed} assertions passed.`);
}

main().catch((err) => { console.error('[giveaway-amoe]', err); process.exit(1); });
