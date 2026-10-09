#!/usr/bin/env node
/* ══════════════════════════════════════════════
   RUN EVERY SUITE, AND BE RIGHT ABOUT IT

     node server/scripts/run-all-tests.js
     node server/scripts/run-all-tests.js --verbose     show passing output too

   WHY THIS EXISTS. "The full suite is green" was being checked by running
   each file and grepping its tail for the word FAILED. That is wrong in a way
   that always errs toward GREEN:

     - A suite prints its summary and THEN its failure details, so on a real
       failure the summary scrolls out of the tail that was being read.
     - The detail lines say "FAIL:", which does not match "FAILED".
     - Some files in this directory are CLI diagnostics, not suites. They exit
       non-zero when run with no arguments, which a grep never noticed either.

   Four suites were failing behind that check, including one caused by the
   change being verified at the time. So this reads the EXIT CODE, which every
   suite already sets correctly with process.exit(1), and nothing else.

   CLI TOOLS ARE SKIPPED BY NAME. They live here because they are developer
   entry points, but they take required arguments and are not assertions about
   the codebase. Adding one means adding it below, which is deliberate: a
   suite silently reclassified as a tool would stop being run.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* Interactive or argument-taking tools, not suites. */
const NOT_SUITES = new Set([
  'test-eventsub.js',       // posts a signed EventSub payload at a --url
]);

const verbose = process.argv.includes('--verbose');

const files = fs.readdirSync(HERE)
  .filter(f => f.startsWith('test-') && f.endsWith('.js'))
  .filter(f => !NOT_SUITES.has(f))
  .sort();

let failed = [];
let passed = 0;

for (const f of files) {
  const res = spawnSync(process.execPath, [path.join(HERE, f)], { encoding: 'utf8' });
  const ok = res.status === 0;
  if (ok) passed++; else failed.push({ f, out: (res.stdout || '') + (res.stderr || '') });
  process.stdout.write(`${ok ? '  ok  ' : 'FAIL  '}${f.replace(/^test-|\.js$/g, '')}\n`);
  if (verbose && ok) process.stdout.write((res.stdout || '').replace(/^/gm, '        '));
}

console.log('');
if (failed.length) {
  for (const { f, out } of failed) {
    console.log(`──── ${f} ${'─'.repeat(Math.max(0, 60 - f.length))}`);
    /* The whole output, not a tail: the summary and the details sit in
       different places depending on the suite, and guessing which to show is
       how this went wrong in the first place. */
    console.log(out.split('\n').filter(l => !/MODULE_TYPELESS|Reparsing|eliminate this warning|trace-warnings/.test(l)).join('\n'));
  }
  console.log(`${passed} suite(s) passed, ${failed.length} FAILED: ${failed.map(x => x.f).join(', ')}`);
  process.exit(1);
}
console.log(`All ${passed} suites passed. (${NOT_SUITES.size} CLI tool(s) skipped.)`);
