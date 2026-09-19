#!/usr/bin/env node
/* ══════════════════════════════════════════════
   /api/health — the deploy signal

     node server/scripts/test-health.js

   This endpoint's only job is answering "is the running process the commit
   I pushed", so the two ways it can fail are the two things worth testing:

     it lies     by reading .git per request, which reports the working
                 tree — after a pull without a restart that prints the NEW
                 sha while the OLD code runs, which is worse than having no
                 endpoint at all
     it leaks    by taking `context`, whose `env` is a spread of
                 process.env and holds DATABASE_URL, SESSION_SECRET and
                 every Twitch credential, on a route with no auth

   No database is needed. getPool() throws when createPool() has never been
   called, which is exactly the "Postgres is down" branch — so a bare test
   process exercises the failure path for free.

   THE STATIC CHECKS RUN FIRST, ON PURPOSE. A handler that has grown a
   `context` parameter throws the moment this suite calls it with none, and
   an earlier arrangement of this file died on that with a stack trace
   before reaching the assertion that would have named the problem. Shape is
   checked without invoking; every invocation after that is guarded.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { onRequestGet } from '../../functions/api/health.js';
import { buildRoutes } from '../router.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const SRC = fs.readFileSync(path.join(REPO, 'functions/api/health.js'), 'utf8');

/* Comments stripped, because the checks below are about what the file DOES.
   The header explains at length why this route refuses `env` and never
   touches process.env, and a naive scan of the raw source flags that prose
   as the very leak it is describing. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

/** Call the handler without letting a throw end the run. */
async function call(why) {
  try {
    const res = await onRequestGet();
    return { res, body: await res.json() };
  } catch (err) {
    failures.push(`${why}\n      the handler threw: ${err.message}`);
    return { res: null, body: {} };
  }
}

/* ── It cannot leak what it is never handed ──────────────────────────── */
{
  /* env is a spread of process.env. This route is public and unauthed, so
     the defence is structural: a handler with no parameter cannot reach it,
     whatever a future edit puts in the body. */
  check('the handler takes no context', onRequestGet.length, 0);
  ok('the code never mentions env', !/\benv\b/.test(CODE));
  ok('nor process.env', !/process\.env/.test(CODE));
}

/* ── It is captured at boot, not recomputed ──────────────────────────── */
{
  /* The realistic regression is someone deciding the value looks stale and
     moving the read into the handler to "fix" it — which breaks the
     endpoint precisely when a pull has landed and a restart has not, the
     one case it exists for. */
  ok('the commit is read at module scope', /^const COMMIT = readCommit\(\);$/m.test(SRC));
  const handler = /export async function onRequestGet\([\s\S]*$/.exec(SRC)?.[0] || '';
  ok('and the handler does not read it again', !/readCommit\s*\(/.test(handler));
  ok('nor stamps a fresh boot time', !/BOOTED_AT\s*=/.test(handler));
}

/* ── The query cannot outlive the check ──────────────────────────────── */
{
  /* Promise.race abandons the loser. An abandoned pg query that rejects
     later is an unhandled rejection, and that can end the process — the
     health endpoint killing the server it exists to watch. */
  ok('the abandoned query is caught', /query\.catch\(\(\) => \{\}\)/.test(SRC));
  ok('and the timer is always cleared', /finally \{\s*clearTimeout\(timer\);/.test(SRC));
}

/* ── The router will actually publish it ─────────────────────────────── */
{
  /* Asking the real router rather than reading its exclusion list. A route
     can be absent for reasons a source scan never sees — the wrong export
     name, a path that collides, a module the walk skips — and an endpoint
     nobody can reach is indistinguishable from an outage to the monitor
     that is supposed to be watching for one. */
  const { routes } = await buildRoutes(path.join(REPO, 'functions'));
  ok('the router publishes /api/health', routes.has('/api/health'));
  check('as a GET', Object.keys(routes.get('/api/health') || {}), ['GET']);
  ok('and it exports a GET handler', typeof onRequestGet === 'function');
}

/* ── It reports the commit the process booted on ─────────────────────── */
{
  const { body } = await call('reporting the commit');

  const head = spawnSync('git', ['rev-parse', 'HEAD'],
    { cwd: REPO, encoding: 'utf8' }).stdout?.trim();

  ok('git told us a HEAD to compare against', /^[0-9a-f]{40}$/.test(head || ''));
  check('the endpoint reports that commit', body.commit, head);
  check('and a short form of the same one', body.commitShort, (head || '').slice(0, 7));

  /* THE ONLY FIELD ANYONE READS. A null here is honest but useless, and it
     is what every unexpected .git layout falls back to — so if this ever
     goes null the resolver stopped working, not the repo. */
  ok('the commit is not unknown', typeof body.commit === 'string');
}

/* ── Two requests, one answer ────────────────────────────────────────── */
{
  /* Behavioural half of the capture check. A handler that re-read .git per
     request would still pass this while nothing changed on disk, which is
     why the source assertions above carry the real weight. */
  const a = await call('first of two calls');
  const b = await call('second of two calls');
  check('the boot time does not move between requests', a.body.bootedAt, b.body.bootedAt);
  check('nor does the commit', a.body.commit, b.body.commit);
}

/* ── A dead database pages, rather than reporting 200 ────────────────── */
{
  /* No createPool() has run in this process, so getPool() throws — the same
     branch a real outage takes. A monitor watches status codes, so this
     must not be a 200 carrying ok:false. */
  const { res, body } = await call('the database-down branch');

  check('an unreachable database is a 503', res?.status, 503);
  check('and says so', body.database, 'down');
  check('and is not ok', body.ok, false);

  check('the answer is never cached', res?.headers.get('Cache-Control'), 'no-store');
  check('and is JSON', res?.headers.get('Content-Type'), 'application/json');

  ok('uptime is a real number of seconds', Number.isFinite(body.uptimeSeconds) && body.uptimeSeconds >= 0);
  ok('the boot time parses', !Number.isNaN(Date.parse(body.bootedAt)));

  check('and it answers only these fields', Object.keys(body).sort(),
        ['bootedAt', 'commit', 'commitShort', 'database', 'ok', 'uptimeSeconds']);
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
