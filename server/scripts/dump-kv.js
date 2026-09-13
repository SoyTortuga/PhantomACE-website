#!/usr/bin/env node
/* ══════════════════════════════════════════════
   Dump the production Cloudflare KV namespace to NDJSON.

   Usage:
     node server/scripts/dump-kv.js <namespace-id> <out.ndjson>

   Each line is { name, value, expiration }. `expiration` comes from the key
   listing as absolute Unix seconds, which is how real TTLs are preserved
   rather than guessed at load time.

   WRITE THE OUTPUT OUTSIDE THE REPO. The dump contains live Twitch refresh
   tokens and every unclaimed giveaway code.

   Verification counts DISTINCT keys, not lines. An earlier ad-hoc dump of
   this namespace produced 35 lines that looked complete but contained a
   duplicate and was silently missing sc_leaderboard — the real leaderboard
   with real player scores. Row counts hide that; distinct-key coverage
   does not.
   ══════════════════════════════════════════════ */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';

const run = promisify(execFile);
const IS_WIN = process.platform === 'win32';

/* Node won't execFile a .cmd directly on Windows, and `shell: true` mangles
   the arguments (wrangler ends up reporting an auth error because it never
   receives a usable namespace id). Going through cmd.exe with an explicit
   argv avoids both problems without ever building a command string. */
const SAFE_KEY = /^[A-Za-z0-9_.:@+-]+$/;

async function wrangler(args) {
  const cmd = IS_WIN ? 'cmd.exe' : 'wrangler';
  const argv = IS_WIN ? ['/c', 'wrangler.cmd', ...args] : args;
  const { stdout } = await run(cmd, argv, {
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}

async function main() {
  const [nsId, outPath] = process.argv.slice(2);
  if (!nsId || !outPath) {
    console.error('usage: node dump-kv.js <namespace-id> <out.ndjson>');
    process.exit(2);
  }

  // --remote is mandatory. Without it wrangler silently reads a LOCAL
  // simulated store and returns results that look real but are not.
  console.log('[dump] listing keys...');
  const listed = JSON.parse(await wrangler(
    ['kv', 'key', 'list', `--namespace-id=${nsId}`, '--remote']
  ));
  console.log(`[dump] ${listed.length} keys`);

  const wanted = new Map(listed.map(k => [k.name, k.expiration ?? null]));
  const out = fs.createWriteStream(outPath, { encoding: 'utf8' });
  const got = new Set();
  const failures = [];

  let i = 0;
  for (const [name, expiration] of wanted) {
    i++;
    process.stdout.write(`\r[dump] ${i}/${wanted.size} ${name.slice(0, 48).padEnd(48)}`);
    if (!SAFE_KEY.test(name)) {
      failures.push({ name, reason: 'key contains characters unsafe to pass through a shell' });
      continue;
    }
    try {
      const value = await wrangler(['kv', 'key', 'get', name, `--namespace-id=${nsId}`, '--remote']);
      if (!value.length) { failures.push({ name, reason: 'empty value' }); continue; }
      out.write(JSON.stringify({ name, value, expiration }) + '\n');
      got.add(name);
    } catch (err) {
      // A short-TTL key can legitimately expire between list and get.
      failures.push({ name, reason: (err.stderr || err.message || '').trim().slice(0, 120) });
    }
  }
  await new Promise(r => out.end(r));
  process.stdout.write('\n');

  const missing = [...wanted.keys()].filter(k => !got.has(k));
  console.log(`[dump] distinct keys written: ${got.size} of ${wanted.size}`);
  if (failures.length) {
    console.log(`[dump] ${failures.length} could not be read:`);
    for (const f of failures) console.log(`   ${f.name}: ${f.reason}`);
  }
  if (missing.length) {
    console.error('[dump] FAILED — these keys are absent from the dump:');
    for (const m of missing) console.error('   ' + m);
    process.exit(1);
  }
  console.log(`[dump] OK -> ${outPath}`);
}

main().catch(err => { console.error('[dump] fatal:', err); process.exit(1); });
