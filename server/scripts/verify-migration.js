#!/usr/bin/env node
/* ══════════════════════════════════════════════
   Verify a Postgres load against the KV dump it came from.

   Usage:
     node server/scripts/verify-migration.js <dump.ndjson> [--database-url=...]

   Run this after EVERY load, including the dry run. Exits non-zero on any
   discrepancy — it is meant to be the hard gate in the cutover, at the point
   where everything is still reversible.

   It compares parsed JSON rather than text, because jsonb normalises number
   formatting and key order: a byte comparison would report differences that
   don't exist. It also counts DISTINCT keys, after an ad-hoc dump of this
   namespace once produced the right number of lines while containing a
   duplicate and missing a real key.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import pg from 'pg';
import 'dotenv/config';
import { resolveKey, SPECIAL_MIGRATION_KEYS } from '../lib/registry.js';
import { toStorable } from '../lib/value.js';

const { Pool } = pg;

function arg(name, fallback) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

/** Order-insensitive deep equality for parsed JSON. */
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(k => deepEqual(a[k], b[k]));
}

async function main() {
  const dumpPath = process.argv[2];
  const databaseUrl = arg('database-url', process.env.DATABASE_URL);
  if (!dumpPath || !databaseUrl) {
    console.error('usage: node verify-migration.js <dump.ndjson> [--database-url=...]');
    process.exit(2);
  }

  const rows = fs.readFileSync(dumpPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const discard = new Set(SPECIAL_MIGRATION_KEYS.discard);
  const { giveawayPoolPrefix, giveawayCursorPrefix, monthlyAwardPrefix } = SPECIAL_MIGRATION_KEYS;

  const problems = [];
  const note = (msg) => { problems.push(msg); console.log('   FAIL  ' + msg); };
  const ok = (msg) => console.log('   ok    ' + msg);

  // ── 0. the dump itself ───────────────────────────────────────────────
  console.log('[verify] dump integrity');
  const names = rows.map(r => r.name);
  const unique = new Set(names);
  if (unique.size !== names.length) {
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    note(`dump contains duplicate keys: ${[...new Set(dupes)].join(', ')}`);
  } else ok(`${names.length} keys, all distinct`);

  // ── 1. every key present with an identical value ─────────────────────
  console.log('[verify] row-by-row comparison');
  const expectedPerTable = {};
  let compared = 0;

  for (const row of rows) {
    const { name, value } = row;
    if (discard.has(name)) continue;
    if (name.startsWith(giveawayPoolPrefix) || name.startsWith(giveawayCursorPrefix)) continue;
    if (name.startsWith(monthlyAwardPrefix)) continue;

    const target = resolveKey(name);
    if (!target) { note(`${name}: no table mapping`); continue; }
    expectedPerTable[target.table] = (expectedPerTable[target.table] || 0) + 1;

    const { rows: got } = await pool.query(
      `SELECT value FROM ${target.table} WHERE key = $1`, [name]
    );
    if (!got.length) { note(`${name}: MISSING from ${target.table}`); continue; }
    if (!deepEqual(got[0].value, toStorable(value))) {
      note(`${name}: value differs in ${target.table}`);
      continue;
    }
    compared++;
  }
  ok(`${compared} values match exactly`);

  // ── 2. table counts ──────────────────────────────────────────────────
  console.log('[verify] table counts');
  for (const [table, expected] of Object.entries(expectedPerTable)) {
    const { rows: c } = await pool.query(`SELECT count(*)::int AS n FROM ${table}`);
    if (c[0].n < expected) note(`${table}: has ${c[0].n}, dump expected at least ${expected}`);
    else ok(`${table}: ${c[0].n} rows (dump had ${expected})`);
  }

  // ── 3. giveaway codes — cursor fidelity ──────────────────────────────
  // A cursor migrated too low re-issues codes people already redeemed; too
  // high silently burns unused ones. Both are invisible until someone
  // complains, so assert it explicitly.
  const poolRows = rows.filter(r => r.name.startsWith(giveawayPoolPrefix) && !r.name.startsWith(giveawayCursorPrefix));
  if (poolRows.length) {
    console.log('[verify] giveaway code pools');
    for (const r of poolRows) {
      const tier = r.name.slice(giveawayPoolPrefix.length);
      const codes = JSON.parse(r.value);
      const cur = rows.find(x => x.name === giveawayCursorPrefix + tier);
      const cursor = cur ? (parseInt(JSON.parse(cur.value) ?? cur.value, 10) || 0) : 0;
      const { rows: t } = await pool.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE claimed_at IS NOT NULL)::int AS claimed
           FROM giveaway_codes WHERE tier = $1`, [tier]
      );
      if (t[0].total !== codes.length) note(`${tier}: ${t[0].total} codes, expected ${codes.length}`);
      else if (t[0].claimed !== cursor) note(`${tier}: ${t[0].claimed} claimed, cursor said ${cursor}`);
      else ok(`${tier}: ${t[0].total} codes, ${t[0].claimed} claimed (cursor ${cursor})`);
    }
  }

  // ── 4. credentials survived ──────────────────────────────────────────
  const tokenKeys = rows.map(r => r.name).filter(n => resolveKey(n)?.table === 'oauth_tokens');
  if (tokenKeys.length) {
    console.log('[verify] oauth tokens');
    for (const k of tokenKeys) {
      const { rows: g } = await pool.query(`SELECT value FROM oauth_tokens WHERE key = $1`, [k]);
      if (!g.length) note(`${k}: missing`);
      else if (g[0].value === null || g[0].value === '') note(`${k}: empty`);
      else ok(`${k}: present`);
    }
  }

  // ── 5. array-shaped singletons kept their length ─────────────────────
  console.log('[verify] array lengths');
  for (const r of rows) {
    let parsed;
    try { parsed = JSON.parse(r.value); } catch { continue; }
    if (!Array.isArray(parsed)) continue;
    const target = resolveKey(r.name);
    if (!target) continue;
    const { rows: g } = await pool.query(`SELECT value FROM ${target.table} WHERE key = $1`, [r.name]);
    if (!g.length) continue;
    const stored = g[0].value;
    if (!Array.isArray(stored) || stored.length !== parsed.length) {
      note(`${r.name}: array length ${Array.isArray(stored) ? stored.length : 'n/a'}, expected ${parsed.length}`);
    } else ok(`${r.name}: ${parsed.length} entries`);
  }

  // ── 6. nothing parked as unmapped ────────────────────────────────────
  const { rows: u } = await pool.query(`SELECT count(*)::int AS n FROM unmapped_kv`);
  if (u[0].n) note(`${u[0].n} key(s) sitting in unmapped_kv`);
  else ok('unmapped_kv is empty');

  await pool.end();

  console.log('');
  if (problems.length) {
    console.error(`[verify] FAILED — ${problems.length} problem(s). Do not cut over.`);
    process.exit(1);
  }
  console.log('[verify] PASSED');
}

main().catch(err => { console.error('[verify] fatal:', err); process.exit(1); });
