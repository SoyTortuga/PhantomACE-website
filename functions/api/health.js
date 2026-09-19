/* ══════════════════════════════════════════════
   GET /api/health

   Is the site up, and WHICH BUILD is it running?

   The second question is why this exists. Static files are read from disk
   per request, so a `git pull` publishes them immediately — but everything
   under server/ and functions/ is loaded once, at boot. Between a pull and
   an `nssm restart phantomace-web` the site serves a new client against an
   old server, and until now nothing anywhere said so. PhamShock found that
   gap the expensive way: the client offered ten weapons while the server
   still knew five, and the only detector available was a player picking
   Railgun mid-match and having the turn rejected.

   THE COMMIT IS CAPTURED AT MODULE LOAD — WHICH IS BOOT — AND NEVER RE-READ.
   That is the whole design, and it is the one thing here that must not be
   "improved". Reading .git per request would report the WORKING TREE, so
   after a pull without a restart it would print the new SHA while the
   process ran the old code: confidently inverting the single signal this
   endpoint exists to give. The router imports every route module once
   during boot, so module scope is boot.

   PUBLIC AND UNAUTHENTICATED, because an uptime monitor cannot log in.
   That constrains what it may say, so it answers exactly three things: a
   commit SHA already public on GitHub, how long the process has been up,
   and whether Postgres answered. It deliberately takes no `context` — that
   object's `env` is a spread of process.env and carries the database
   password, SESSION_SECRET and every Twitch credential, and a handler that
   cannot reach it cannot leak it.

   A failing database answers 503 rather than 200-with-a-flag, because a
   monitor pages on status codes.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool } from '../../server/lib/db.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * The checked-out commit, read straight from .git — no `git` process, which
 * would be a spawn on a public endpoint.
 *
 * Returns null rather than a guess whenever anything is unexpected. An
 * unknown build is a fine answer; a wrong one is worse than none, because
 * the only use of this field is deciding whether a deploy landed.
 */
function readCommit() {
  try {
    let gitDir = path.join(REPO, '.git');

    /* In a linked worktree .git is a FILE holding `gitdir: <path>`. */
    if (fs.statSync(gitDir).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(gitDir, 'utf8'));
      if (!m) return null;
      gitDir = path.resolve(REPO, m[1].trim());
    }

    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (/^[0-9a-f]{40}$/.test(head)) return head;          /* detached HEAD */

    const ref = /^ref:\s*(.+)$/.exec(head);
    if (!ref) return null;
    const refName = ref[1].trim();

    /* Branch refs live in the COMMON dir. For a plain clone that is gitDir
       itself; a linked worktree keeps its own HEAD but shares refs, and
       without this it would resolve to null on every deploy. */
    let refDir = gitDir;
    try {
      refDir = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim());
    } catch { /* no commondir: an ordinary clone */ }

    try {
      return fs.readFileSync(path.join(refDir, refName), 'utf8').trim() || null;
    } catch {
      /* The ref has been packed away by `git gc`. */
      const packed = fs.readFileSync(path.join(refDir, 'packed-refs'), 'utf8');
      const line = packed.split('\n').find(l => l.endsWith(' ' + refName));
      return line ? line.slice(0, 40) : null;
    }
  } catch {
    return null;
  }
}

const COMMIT = readCommit();
const BOOTED_AT = new Date().toISOString();

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

/**
 * Whether Postgres is answering, bounded in time.
 *
 * A health check that blocks on a hung database is worse than useless: the
 * monitor times out with no answer at the exact moment it most needs one.
 */
async function databaseOk(timeoutMs = 2000) {
  let db;
  try { db = getPool(); } catch { return false; }

  let timer;
  const query = db.query('SELECT 1');
  /* The race may abandon this promise. Without a catch of its own, a later
     rejection is an unhandled rejection, which can take the process down —
     the health endpoint killing the server it reports on. */
  query.catch(() => {});

  try {
    await Promise.race([
      query,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function onRequestGet() {
  const up = await databaseOk();
  return json({
    ok: up,
    commit: COMMIT,
    commitShort: COMMIT ? COMMIT.slice(0, 7) : null,
    bootedAt: BOOTED_AT,
    uptimeSeconds: Math.round(process.uptime()),
    database: up ? 'up' : 'down',
  }, up ? 200 : 503);
}
