/* ══════════════════════════════════════════════
   WHICH BUILD IS THIS PROCESS RUNNING?

   Static files are read from disk per request, so a `git pull` publishes
   them immediately — but everything under server/ and functions/ is loaded
   once, at boot. Between a pull and an `nssm restart phantomace-web` the
   site serves a new client against an old server, and nothing said so.
   PhamShock is the worked example: the client offered ten weapons while the
   server still knew five, and the only detector available was a player
   picking Railgun mid-match and having the turn rejected.

   READ AT MODULE LOAD, WHICH IS BOOT, AND NEVER AGAIN. That is the whole
   design and the one thing here that must not be "improved". Reading .git
   per request would report the WORKING TREE, so after a pull without a
   restart it would print the new sha while the old code ran — confidently
   inverting the single signal this exists to give. If the value ever looks
   stale against the repo, that is it working.

   Exported as constants rather than a function for the same reason: there
   is no per-request entry point to call by mistake.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * The checked-out commit, read straight from .git — no `git` subprocess,
 * which would be a spawn on the path of a public endpoint.
 *
 * Returns null rather than a guess whenever anything is unexpected. An
 * unknown build is a fine answer; a wrong one is worse than none, because
 * the only use of this value is deciding whether a deploy landed.
 *
 * Exported for the tests — nothing else should call it.
 */
export function readCommit() {
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

    /* Branch refs live in the COMMON dir. For an ordinary clone that is
       gitDir itself; a linked worktree keeps its own HEAD but shares refs,
       and without this it would resolve to null on every deploy. */
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

export const COMMIT = readCommit();
export const COMMIT_SHORT = COMMIT ? COMMIT.slice(0, 7) : null;
export const BOOTED_AT = new Date().toISOString();
