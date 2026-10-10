#!/usr/bin/env node
/* ══════════════════════════════════════════════
   SOFT READS — degrading is fine, degrading in silence is not

     node server/scripts/test-soft-read.js

   Seventeen storage reads were written `.catch(() => null)`. Half of
   that is right: a profile missing its Dino Park panel beats a profile
   that 500s. The other half is not, because a thrown read and an empty
   one then come back identical — so the worst failure this site has, a
   key with no mapping in registry.js, which THROWS on every read, looks
   exactly like "this player has nothing yet".

   That is not hypothetical. An unregistered key is how the monthly
   giveaway draw broke, and a swallowed error is why it was not obvious.

   So: the fallback stays, the silence goes, and nothing may go back to
   swallowing a storage read without saying which key it was.
   ══════════════════════════════════════════════ */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { softRead } from '../../functions/api/soft-read.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(REPO, p), 'utf8');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

/* Capture console.error without losing it for the rest of the run. */
async function logged(fn) {
  const lines = [];
  const real = console.error;
  console.error = (...a) => lines.push(a.map(String).join(' '));
  try { return { value: await fn(), lines }; } finally { console.error = real; }
}

/* ── It behaves like the catch it replaces ───────────────────────────── */
{
  const good = await logged(() => softRead(Promise.resolve({ a: 1 }), 'k'));
  check('a successful read passes straight through', good.value, { a: 1 });
  check('and says nothing', good.lines, []);

  /* A real read that found nothing is null, and must stay quiet — only a
     FAILURE is worth a line. */
  const empty = await logged(() => softRead(Promise.resolve(null), 'k'));
  check('a read that found nothing is still null', empty.value, null);
  check('and is not an error', empty.lines, []);

  const bad = await logged(() => softRead(Promise.reject(new Error('no mapping for key')), 'inv_42'));
  check('a failed read falls back', bad.value, null);
  check('and logs exactly once', bad.lines.length, 1);
  ok('naming the key', bad.lines[0].includes('inv_42'));
  ok('and why', bad.lines[0].includes('no mapping for key'));

  const custom = await logged(() => softRead(Promise.reject(new Error('x')), 'k', []));
  check('a caller can choose its own fallback', custom.value, []);

  /* A rejection that is not an Error must not break the logging. */
  const odd = await logged(() => softRead(Promise.reject('just a string'), 'k'));
  check('a non-Error rejection still falls back', odd.value, null);
  check('and still logs', odd.lines.length, 1);

  /* It takes a plain value too, so a caller refactoring a sync read does
     not have to think about it. */
  const plain = await logged(() => softRead(5, 'k'));
  check('a non-promise passes through', plain.value, 5);
}

/* ── Nothing swallows a storage read in silence ──────────────────────── */
{
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(join(REPO, dir), { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const rel = dir + '/' + e.name;
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith('.js')) files.push(rel);
    }
  };
  walk('functions');
  ok('there are handlers to scan', files.length > 20);

  /* An HTTP body that was not JSON is a different thing and legitimately
     has nothing to report — it is not a storage read. */
  const BODY_PARSE = /\.json\(\)\.catch\(\(\) => null\)/;

  const offenders = [];
  for (const f of files) {
    if (f === 'functions/api/soft-read.js') continue;     // its own documentation
    const src = read(f);
    for (const line of src.split('\n')) {
      if (!line.includes('.catch(() => null)')) continue;
      if (BODY_PARSE.test(line)) continue;
      if (line.trim().startsWith('*') || line.trim().startsWith('/*')) continue;  // a comment
      offenders.push(f + ': ' + line.trim().slice(0, 70));
    }
  }
  check('no storage read is swallowed without a word', offenders, []);

  /* And the helper is actually used, rather than added and forgotten. */
  const users = files.filter(f => read(f).includes("from './soft-read.js'") ||
                                  read(f).includes("from '../soft-read.js'"));
  ok('several handlers use it', users.length >= 4);
  check('every one that imports it calls it',
    users.filter(f => !/softRead\(/.test(read(f))), []);
}

/* ── It is declared a library, or the rig will not boot ──────────────── */
{
  /* A handler-less file under functions/ that is not in NON_ROUTE_MODULES
     aborts the boot — which has taken production down before. */
  const router = read('server/router.js');
  ok('soft-read is declared a non-route', /'api\/soft-read\.js'/.test(router));

  const mod = read('functions/api/soft-read.js');
  ok('and really has no request handler', !/export (async )?function onRequest/.test(mod));
}

/* ── Report ─────────────────────────────────────────────────────────── */
if (failures.length) {
  console.error(`\n✗ ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`[soft-read] ${passed} assertions passed.`);
