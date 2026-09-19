#!/usr/bin/env node
/* ══════════════════════════════════════════════
   /api/health — the deploy signal

     node server/scripts/test-health.js

   WHERE THIS ENDPOINT LIVES, because it is not where you would look.
   /api/health is NOT a file under functions/. It is intercepted directly in
   server/index.js, ahead of the router, so that it still answers when the
   route table or the database is the thing that is broken. A health check
   that depends on the machinery it reports on is not a health check.

   That placement has a cost, and this suite exists because the cost was
   paid: a route file added at functions/api/health.js builds, registers,
   passes a router assertion and is never reached, because the interception
   returns first. Anyone adding one should find this file instead.

   What is worth testing is the commit field, whose only job is answering
   "is the running process the commit I pushed". It has exactly one failure
   mode, and it is silent: read .git per request and it reports the WORKING
   TREE, so after a pull without a restart it prints the new sha while the
   old code runs — worse than having no field at all.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { COMMIT, COMMIT_SHORT, BOOTED_AT, readCommit } from '../lib/build-info.js';
import { buildRoutes } from '../router.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const INDEX = fs.readFileSync(path.join(REPO, 'server/index.js'), 'utf8');
const INFO = fs.readFileSync(path.join(REPO, 'server/lib/build-info.js'), 'utf8');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

/* ── It reports the commit this process started on ───────────────────── */
{
  const head = spawnSync('git', ['rev-parse', 'HEAD'],
    { cwd: REPO, encoding: 'utf8' }).stdout?.trim();

  ok('git told us a HEAD to compare against', /^[0-9a-f]{40}$/.test(head || ''));
  check('build-info reports that commit', COMMIT, head);
  check('and a short form of the same one', COMMIT_SHORT, (head || '').slice(0, 7));

  /* THE ONLY FIELD ANYONE READS. Null is the honest fallback for every
     unexpected .git layout, so if this goes null the resolver stopped
     working rather than the repo being odd. */
  ok('the commit is not unknown', typeof COMMIT === 'string');
  ok('the boot time parses', !Number.isNaN(Date.parse(BOOTED_AT)));
}

/* ── It is captured at boot, not recomputed ──────────────────────────── */
{
  /* Behavioural half: the exported value is a constant, so a caller cannot
     accidentally get a fresh read. readCommit() is exported only so this
     suite can prove the resolver and the constant agree. */
  check('the constant matches a fresh resolve, right now', COMMIT, readCommit());
  ok('COMMIT is a module constant', /^export const COMMIT = readCommit\(\);$/m.test(INFO));
  ok('and so is the boot time', /^export const BOOTED_AT = new Date\(\)\.toISOString\(\);$/m.test(INFO));

  /* Source half, and the one that actually bites. The realistic regression
     is someone deciding the value looks stale against the repo and moving
     the read into the request path to "fix" it — which breaks the field
     precisely when a pull has landed and a restart has not, the one case
     it is for. */
  ok('index.js does not resolve the commit per request', !/readCommit\s*\(/.test(INDEX));
  ok('nor stamps its own boot time', !/BOOTED_AT\s*=/.test(INDEX));
}

/* ── The handler in index.js actually serves those fields ────────────── */
{
  /* build-info can be perfect and unreferenced. This pins the wiring. */
  const block = /if \(url\.pathname === '\/api\/health'\) \{[\s\S]*?\n      \}/.exec(INDEX)?.[0] || '';
  ok('the health branch is still in index.js', !!block);

  for (const field of ['commit', 'commitShort', 'bootedAt', 'uptimeSeconds', 'routes', 'database']) {
    ok(`it answers ${field}`, new RegExp(`\\b${field}:`).test(block));
  }

  ok('build-info is imported', /import \{[^}]*COMMIT[^}]*\} from '\.\/lib\/build-info\.js'/.test(INDEX));

  /* A monitor pages on status codes, so a reachable process with a dead
     database must not answer 200 carrying ok:false. */
  ok('a dead database is a 503', /res\.writeHead\(dbOk \? 200 : 503/.test(block));
  ok('it really asks Postgres', /pool\.query\('SELECT 1'\)/.test(block));
  ok('and the answer is never cached', /'Cache-Control': 'no-store'/.test(block));
}

/* ── Nobody has added a route file that cannot be reached ────────────── */
{
  /* THE MISTAKE THIS PREVENTS, which was made. functions/api/health.js
     builds, registers as /api/health, and passes a "the router publishes
     it" assertion -- while the interception above returns before the route
     table is consulted, so the file is dead code that looks alive. Catching
     it here is cheap; catching it in production means trusting a payload
     that no longer comes from where you think. */
  ok('there is no shadowed route file', !fs.existsSync(path.join(REPO, 'functions/api/health.js')));

  const { routes } = await buildRoutes(path.join(REPO, 'functions'));
  ok('and the router claims no /api/health', !routes.has('/api/health'));
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[health] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[health] ${passed} assertions passed.`);
console.log('');
