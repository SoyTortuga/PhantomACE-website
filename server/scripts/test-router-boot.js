#!/usr/bin/env node
/* ══════════════════════════════════════════════
   THE RIG STILL BOOTS — test suite

     node server/scripts/test-router-boot.js

   THE OUTAGE THIS EXISTS FOR. A new file under functions/ was a library,
   not a route, and was not declared in NON_ROUTE_MODULES. The router
   refuses to guess — correctly — so it printed FATAL and called
   process.exit(1). On a laptop that is a one-line fix. On the rig it
   happened during `git pull && nssm restart`, so the service went to
   SERVICE_PAUSED and phantomace.tv was down until somebody noticed.

   Nothing caught it earlier because the check only runs at boot, and boot
   only happens on the rig. Every suite we had tested behaviour against a
   fake env and never built the route table.

   So this builds it, exactly the way the server does, in a child process —
   a child because the real failure is process.exit(1), and reproducing the
   rig's boot means letting it exit rather than catching something.

   IT ALSO IMPORTS EVERY FILE UNDER functions/, which is the only honest
   syntax check this codebase has. `node --check` parses as CommonJS and
   says nothing about a bad ESM import; this fails on one.

   And it reads the declaration list for the two ways it rots:
     a STALE entry   — the file is gone, so the list quietly accumulates
     a GROWN entry   — the file now exports a handler, so its route is
                       skipped and 404s with nothing logged anywhere
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildRoutes, NON_ROUTE_MODULES } from '../router.js';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FUNCTIONS = path.join(REPO, 'functions');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

/* ── Boot, the way the rig does it ───────────────────────────────────── */
{
  /* A child, because the failure being reproduced is process.exit(1). In
     this process that would take the suite with it and report nothing. */
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import path from 'node:path';
    import { buildRoutes } from ${JSON.stringify(pathToFileURL(path.join(REPO, 'server/router.js')).href)};
    const t = await buildRoutes(${JSON.stringify(FUNCTIONS)});
    console.log(JSON.stringify({ count: t.count, catchAll: !!t.catchAll }));
  `], { encoding: 'utf8' });

  check('the route table builds without a fatal', child.status, 0);
  if (child.status !== 0) {
    /* The router already says which file and why; repeating it here is what
       makes this suite useful rather than just red. */
    failures.push('      router said:\n' + (child.stderr || '').replace(/^/gm, '      '));
  }

  let table = null;
  try { table = JSON.parse((child.stdout || '').trim().split('\n').pop()); } catch { /* reported below */ }
  ok('and reports a table', !!table);
  ok('with routes in it', table && table.count > 50);
  /* The /user/<login> and /thread/<id> pages are served by it. */
  ok('and the catch-all', table && table.catchAll);
}

/* ── Every file is one thing or the other ───────────────────────────── */
const walk = (dir, base = '') => {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel));
    else if (e.name.endsWith('.js')) out.push(rel);
  }
  return out;
};
const files = walk(FUNCTIONS);

{
  ok('there are handler files to check', files.length > 50);

  const table = await buildRoutes(FUNCTIONS);
  /* buildRoutes exits rather than returning on a problem, so reaching here
     already means every file is declared. What is worth saying is the
     arithmetic: declared libraries plus routes accounts for all of them,
     with nothing falling between. */
  const declared = files.filter(f => NON_ROUTE_MODULES.has(f));
  check('routes plus declared libraries is every file',
    table.count + declared.length, files.length);
}

/* ── The declaration list rots in two directions ────────────────────── */
{
  const stale = [...NON_ROUTE_MODULES].filter(rel => !fs.existsSync(path.join(FUNCTIONS, rel)));
  check('no entry names a file that is gone', stale, []);

  /* THE DANGEROUS ONE. Give a declared library a handler and the router
     skips it: the route 404s, nothing is logged, and the boot assertion is
     happy because the file was declared. */
  const grown = [];
  for (const rel of NON_ROUTE_MODULES) {
    if (!fs.existsSync(path.join(FUNCTIONS, rel))) continue;
    const mod = await import(pathToFileURL(path.join(FUNCTIONS, rel)).href);
    const has = ['onRequestGet', 'onRequestPost', 'onRequestDelete', 'onRequest']
      .filter(h => typeof mod[h] === 'function');
    if (has.length) grown.push(rel + ' exports ' + has.join(', '));
  }
  check('no declared library has grown a handler', grown, []);
}

/* ── Two files, one URL ─────────────────────────────────────────────── */
{
  /* routes is a Map and set() overwrites, so foo.js and foo/index.js both
     resolve to /api/foo and one of them simply never runs. Whichever walk()
     reaches second wins, which is not a decision anybody made. */
  const seen = new Map();
  const clashes = [];
  for (const rel of files) {
    if (NON_ROUTE_MODULES.has(rel)) continue;
    let route = '/' + rel.replace(/\.js$/, '');
    if (route.endsWith('/index')) route = route.slice(0, -'/index'.length) || '/';
    if (seen.has(route)) clashes.push(`${route} <- ${seen.get(route)} and ${rel}`);
    else seen.set(route, rel);
  }
  check('no two files claim the same route', clashes, []);
}

/* ── The newest route is actually reachable ─────────────────────────── */
{
  const table = await buildRoutes(FUNCTIONS);
  /* A spot check with a point: /api/settings was added the same day this
     suite was, and the way to find out it had not been wired up should not
     be a settings page that says "could not reach the server". */
  ok('/api/settings is in the table', table.routes.has('/api/settings'));
  ok('answering GET', !!(table.routes.get('/api/settings') || {}).GET);
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[router-boot] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  process.exit(1);
}
console.log(`[router-boot] ${passed} assertions passed.`);
