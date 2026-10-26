#!/usr/bin/env node
/* ══════════════════════════════════════════════
   CLIPPER PREFLIGHT — what is ready, and what is still missing.

     node server/clipper/scripts/doctor.js
     node server/clipper/scripts/doctor.js --live   (also calls Twitch for real)

   Run it after every setup step. It is the answer to "is it ready yet?" and it
   names the exact env var or file that is absent rather than letting the first
   real run fail at 9am with a stack trace.

   Exit code 0 = ready to post to at least one account. 1 = something required
   is missing. A route with no credentials is reported as PENDING, not broken:
   that is the normal state while waiting on the broadcaster, and the bot
   skips those routes rather than failing.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import * as youtube from '../publish/youtube.js';
import * as tiktok from '../publish/tiktok.js';

import { bootEnv, serviceArg } from '../env-boot.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '../../..');
const live = process.argv.includes('--live');

/* Check the environment the bot will actually see, not a bare shell. */
await bootEnv(serviceArg());

let blocking = 0, pending = 0;
const OK = (m) => console.log(`  \u001b[32m✓\u001b[0m ${m}`);
const NO = (m) => { blocking++; console.log(`  \u001b[31m✗\u001b[0m ${m}`); };
const WAIT = (m) => { pending++; console.log(`  \u001b[33m…\u001b[0m ${m}`); };

console.log('\n══ Clipper preflight ══════════════════════════════════════════\n');

/* ── 1. runtime ───────────────────────────────────────────────────────── */
console.log('Runtime');
const major = Number(process.versions.node.split('.')[0]);
major >= 20 ? OK(`node ${process.versions.node}`) : NO(`node ${process.versions.node} — need >= 20`);

const ffbin = process.env.FFMPEG_PATH || 'ffmpeg';
const ff = spawnSync(ffbin, ['-version'], { encoding: 'utf8' });
if (ff.status === 0) OK(`ffmpeg: ${(ff.stdout.split('\n')[0] || '').slice(0, 60)}`);
else NO(`ffmpeg not runnable as "${ffbin}" — install it or set FFMPEG_PATH`);

/* ── 2. assets the renderer needs ─────────────────────────────────────── */
console.log('\nBranding assets');
for (const [label, p] of [
  ['GodOfWar font', path.join(ROOT, 'assets/fonts/GODOFWAR.TTF')],
  ['PhantomACE logo', path.join(ROOT, 'assets/images/phantomace-logo.png')],
]) fs.existsSync(p) ? OK(`${label} present`) : NO(`${label} missing at ${p}`);

/* ── 3. twitch (the clip source) ──────────────────────────────────────── */
console.log('\nTwitch (clip source)');
const tw = ['TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET', 'TWITCH_BROADCASTER_ID'];
const twMissing = tw.filter(k => !process.env[k]);
twMissing.length ? NO(`missing ${twMissing.join(', ')}`) : OK('credentials set');

if (live && !twMissing.length) {
  try {
    const { findClips } = await import('../twitch.js');
    const { memoryKv } = await import('../memory-kv.js');
    const clips = await findClips({ ...process.env, MARKETPLACE: memoryKv() }, { lookbackDays: 365, max: 100 });
    OK(`Helix reachable — ${clips.length} clip(s) in the last 365 days`);
    if (!clips.length) WAIT('no clips found — nothing to post yet');
  } catch (err) { NO(`Helix call failed: ${err.message}`); }
} else if (!live) {
  console.log('  \u001b[90m·\u001b[0m (re-run with --live to actually call Twitch)');
}

/* ── 4. routing config ────────────────────────────────────────────────── */
console.log('\nRouting config');
let config = null;
try {
  config = loadConfig();
  OK(`config loaded — ${config.routes.length} route(s)` + (config.fallback ? ' + fallback' : ', no fallback'));
  OK(`${config.defaults.perAccount} post(s) per account per run, ` +
     `${config.defaults.lookbackDays}d lookback, cap ${config.defaults.maxPerRun}/run`);
  OK(`YouTube publishes ${config.schedule.daysAhead}d ahead at ` +
     `${config.schedule.times.join(' & ')} ${config.schedule.timezone} (TikTok posts same-day)`);
  OK(`fresh hits: >=${config.trending.minViews} views within ${config.trending.withinDays}d jump the queue`);
  /* videos.insert is ~1600 units against a 10,000/day default. */
  const ytRoutes = [...config.routes, ...(config.fallback ? [config.fallback] : [])].filter(r => r.youtube).length;
  const units = ytRoutes * config.defaults.perAccount * 1600;
  (units > 10000 ? NO : OK)(
    `YouTube quota: ~${units} units/day across ${ytRoutes} channel(s)` +
    (units > 10000 ? ' — OVER the 10,000/day default' : ' of 10,000'));
} catch (err) {
  NO(err.message.split('\n')[0]);
  console.log('    → node server/clipper/scripts/list-games.js --emit-config > server/clipper/config.json');
}

/* ── 5. per-account credentials ───────────────────────────────────────── */
if (config) {
  console.log('\nDestination accounts');
  const all = [...config.routes, ...(config.fallback ? [config.fallback] : [])];
  let liveRoutes = 0;
  for (const r of all) {
    const bits = [];
    if (r.youtube) {
      const c = youtube.credsFromEnv(process.env, r.youtube.credsEnv);
      bits.push(c ? `YouTube ✓ (${r.youtube.credsEnv}, ${r.youtube.privacy})`
                  : `YouTube … ${r.youtube.credsEnv}_CLIENT_ID/_CLIENT_SECRET/_REFRESH_TOKEN`);
      if (c) liveRoutes++;
    }
    if (r.tiktok) {
      const c = tiktok.credsFromEnv(process.env, r.tiktok.credsEnv);
      bits.push(c ? `TikTok ✓ (${r.tiktok.credsEnv}, ${r.tiktok.privacy})`
                  : `TikTok … ${r.tiktok.credsEnv}_CLIENT_KEY/_CLIENT_SECRET/_REFRESH_TOKEN`);
      if (c) liveRoutes++;
    }
    const ready = bits.every(b => b.includes('✓'));
    (ready ? OK : WAIT)(`${r.label}: ${bits.join('  |  ')}`);
  }
  if (!liveRoutes) WAIT('no account is connected yet — nothing would be posted');
}

/* ── 6. ledger + workspace ────────────────────────────────────────────── */
console.log('\nStorage');
process.env.DATABASE_URL
  ? OK('DATABASE_URL set (posted-ledger will persist)')
  : NO('DATABASE_URL not set — a real run cannot record what it posted');

const work = process.env.CLIPPER_WORK || path.join(require_tmp(), 'clipper');
try { fs.mkdirSync(work, { recursive: true }); fs.accessSync(work, fs.constants.W_OK); OK(`work dir writable: ${work}`); }
catch { NO(`work dir not writable: ${work}`); }
function require_tmp() { return process.env.TEMP || process.env.TMP || '/tmp'; }

/* ── verdict ──────────────────────────────────────────────────────────── */
console.log('\n═══════════════════════════════════════════════════════════════');
if (blocking) {
  console.log(`\u001b[31m${blocking} blocking problem(s)\u001b[0m` + (pending ? `, ${pending} waiting on the broadcaster` : ''));
  console.log('Fix the ✗ items above. See server/clipper/README.md\n');
  process.exit(1);
}
console.log(`\u001b[32mNo blocking problems.\u001b[0m` + (pending ? ` ${pending} item(s) waiting on the broadcaster.` : ' Ready to run.'));
console.log('Next:  node server/clipper/run.js --dry-run\n');
process.exit(0);
