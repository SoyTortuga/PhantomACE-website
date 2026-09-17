#!/usr/bin/env node
/* ══════════════════════════════════════════════
   KV KEYS ARE ALL REGISTERED — test suite

     node server/scripts/test-kv-registry.js

   THE BUG THIS EXISTS FOR. The Mana Clash overlay panel shipped writing a
   new key, `overlay_mana_clash`, that nothing in lib/registry.js mapped to
   a table. resolveKey returned null, the DAL threw — correctly, and with a
   good message — and the control panel reported HTTP 500 on a live stream.

   Nothing caught it earlier because the route's own suite fakes the KV
   shim, so the registry was never consulted; and because the key is one
   string in one file, invisible to any test of behaviour. The registry
   deliberately refuses to guess a table, which is right: guessing writes a
   row nothing can ever read back. But it can only refuse at runtime.

   So this reads the SOURCE and asks the real registry about every key it
   can see being used. A new key now fails here, on a laptop, in a second.

   It cannot see keys assembled at runtime from a variable, which is why it
   reports what it checked rather than claiming completeness.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveKey } from '../lib/registry.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

/* Where application code talks to the shim. server/lib is excluded: that IS
   the shim, and registry.js is full of key names by definition. */
const ROOTS = ['functions', 'server/scripts'];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    /* Test files are skipped, including this one. They fake the shim, so
       the key strings in them are fixtures that never reach the registry —
       and the examples in this file's own header would otherwise be read as
       real usage, which is exactly what happened the first time it ran. */
    else if (e.name.endsWith('.js') && !e.name.startsWith('test-')) out.push(full);
  }
  return out;
}

/**
 * Every KV key this file can be seen to use.
 *
 * Four shapes, which is all the codebase actually uses:
 *   MARKETPLACE.get('literal')          a whole key
 *   MARKETPLACE.get('prefix_' + x)      a family, captured as the prefix
 *   MARKETPLACE.get(`prefix_${x}`)      the same, as a template
 *   MARKETPLACE.get(CONST)              a const declared in the same file
 */
function keysIn(src) {
  const found = new Set();
  const OPS = '(?:get|put|delete|mutate)';

  for (const m of src.matchAll(new RegExp('MARKETPLACE\\.' + OPS + "\\(\\s*'([^']+)'", 'g'))) {
    found.add(m[1]);
  }
  /* A template's literal head: `inv_${id}` yields inv_ */
  for (const m of src.matchAll(new RegExp('MARKETPLACE\\.' + OPS + '\\(\\s*`([^`$]*)', 'g'))) {
    if (m[1]) found.add(m[1]);
  }
  for (const m of src.matchAll(/listValues\(\s*\{\s*prefix:\s*'([^']+)'/g)) {
    found.add(m[1]);
  }

  /* Constants, which is how the key that broke was written. */
  const consts = new Map();
  for (const m of src.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*'([^']+)'\s*;/g)) {
    consts.set(m[1], m[2]);
  }
  for (const [name, value] of consts) {
    const used = new RegExp('(?:MARKETPLACE\\.' + OPS + '\\(\\s*' + name + '\\b'
      + '|listValues\\(\\s*\\{\\s*prefix:\\s*' + name + '\\b)');
    if (used.test(src)) found.add(value);
  }

  return found;
}

/* A key ending in _ is a family prefix; ask about a member of it. */
const resolves = (key) => !!(resolveKey(key) || resolveKey(key + 'x'));

const files = ROOTS.flatMap(r => walk(path.join(REPO, r)));
const unmapped = [];
let checked = 0;

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  for (const key of keysIn(src)) {
    checked++;
    if (!resolves(key)) {
      unmapped.push(`${path.relative(REPO, file).replace(/\\/g, '/')} → "${key}"`);
    }
  }
}

/* ── The whole point ─────────────────────────────────────────────────── */
{
  ok('there is application code to scan', files.length > 20);
  ok('and keys were actually found in it', checked > 40);

  /* A failure here names the file and the key. The fix is one line in
     server/lib/registry.js, and the question it asks is whether the row
     should expire on its own — 'real' if the TTL IS the rule, 'none' if
     something inside the value decides instead. */
  check('every KV key the source uses has a table', unmapped, []);
}

/* ── The keys from the outage itself ─────────────────────────────────── */
{
  /* Read once and null-guarded. Dereferencing this directly made the suite
     die with a TypeError when the entry was missing — which is the one case
     it exists to describe, and a stack trace names the test rather than the
     key somebody has to go and register. */
  const pointer = resolveKey('overlay_mana_clash');
  ok('the overlay pointer resolves', !!pointer);
  /* It sits with the other overlay singletons, and must not have been
     dropped into a family by accident. */
  check('to the singletons table', pointer && pointer.table, 'singletons');
  /* 'none' is a decision: a pointer expiring on its own would switch the
     panel off mid-stream with nothing to explain it. */
  check('and never expires on its own', pointer && pointer.expiry, 'none');
}

/* ── The scanner is not fooling itself ───────────────────────────────── */
{
  /* If keysIn() silently matched nothing, the suite above would pass while
     checking nothing at all — the worst way for a guard to fail. */
  const sample = keysIn(`
    const MY_KEY = 'overlay_mana_clash';
    await env.MARKETPLACE.get(MY_KEY, 'json');
    await env.MARKETPLACE.put('checkin_current', x);
    await env.MARKETPLACE.mutate(\`inv_\${id}\`, f);
    await env.MARKETPLACE.get('mc_room_' + code, 'json');
    await env.MARKETPLACE.listValues({ prefix: 'gwe_' });
  `);
  check('a const key is seen', sample.has('overlay_mana_clash'), true);
  check('a literal key is seen', sample.has('checkin_current'), true);
  check('a template family is seen by its prefix', sample.has('inv_'), true);
  check('a concatenated family too', sample.has('mc_room_'), true);
  check('and a listValues prefix', sample.has('gwe_'), true);

  /* And it must reject, or it proves nothing. */
  ok('an unregistered key does not resolve', !resolves('overlay_not_a_real_key'));
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[kv-registry] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[kv-registry] ${passed} assertions passed — ${checked} key uses across ${files.length} files.`);
console.log('');
