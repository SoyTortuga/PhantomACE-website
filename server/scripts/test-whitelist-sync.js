#!/usr/bin/env node
/* ══════════════════════════════════════════════
   MINECRAFT WHITELIST SYNC — test suite

     node server/scripts/test-whitelist-sync.js

   The sync script overwrites whitelist.json on a live server with
   enforce-whitelist on. Get it wrong and it does not fail loudly - it
   kicks everybody. So this runs the REAL PowerShell script, end to end,
   against a fake site on a random port and a throwaway server folder, and
   checks every way it is supposed to refuse leaves the file exactly as it
   was.

   Windows-only, because the script is. Elsewhere it says so and exits 0;
   the rig does not run this suite (its deploy gate is the boot checks).
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..');
const SCRIPT = path.join(HERE, 'sync-minecraft-whitelist.ps1');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

const A = { uuid: '069a79f4-44e9-4726-a5be-fca90e38aaf5', name: 'Notch' };
const B = { uuid: '11111111-1111-1111-1111-111111111111', name: 'Bravo' };
const C = { uuid: '22222222-2222-2222-2222-222222222222', name: 'Charlie' };
const TOKEN = 'test-token-not-real';

/* ── Static checks, which run everywhere ─────────────────────────────── */
{
  const ps = read('server/scripts/sync-minecraft-whitelist.ps1');
  const route = read('functions/api/minecraft/whitelist.js');
  const crafty = read('functions/api/minecraft/crafty.js');
  const installer = read('server/scripts/install-minecraft-whitelist-task.ps1');

  /* The script and the routes must agree on every name they share. */
  ok('the script sends the header the route reads', ps.includes("'X-Whitelist-Token'") && route.includes("'X-Whitelist-Token'"));
  ok('the token is read by the same name on both sides', ps.includes("'MINECRAFT_WHITELIST_TOKEN'") && route.includes('MINECRAFT_WHITELIST_TOKEN'));
  for (const v of ['CRAFTY_URL', 'CRAFTY_TOKEN', 'CRAFTY_SERVER_ID']) {
    ok(`${v} means the same thing to the script and the site`, ps.includes(`'${v}'`) && crafty.includes(v));
  }
  ok('it fetches over loopback, not through the tunnel', /http:\/\/127\.0\.0\.1:\$Port\/api\/minecraft\/whitelist/.test(ps));
  const port = (/\[int\]\$Port = (\d+)/.exec(ps) || [])[1];
  const prodPort = (/\[int\]\s*\$Port\s*=\s*(\d+)/.exec(read('server/scripts/install-services.ps1')) || [])[1];
  check('on production’s port', port, prodPort);
  ok('the reload has no leading slash, which Crafty says not to send', /--data-raw 'whitelist reload'/.test(ps));

  /* A task that silently stops after a day is the failure to avoid. */
  ok('the task repeats for years, not the default', /-RepetitionDuration \(New-TimeSpan -Days 3650\)/.test(installer));
  ok('runs as SYSTEM, so it needs nobody logged in', /-UserId 'SYSTEM'/.test(installer));
  ok('and does not pile up if a run is slow', /-MultipleInstances IgnoreNew/.test(installer));
}

/* ── End to end ──────────────────────────────────────────────────────── */
if (process.platform !== 'win32') {
  console.log('[whitelist-sync] end-to-end checks skipped: they run Windows PowerShell');
} else {
  /** A fake site whose answer each test chooses. */
  let reply = { status: 200, body: '[]' };
  const site = http.createServer((req, res) => {
    if (req.url !== '/api/minecraft/whitelist') { res.writeHead(404); res.end(); return; }
    if (req.headers['x-whitelist-token'] !== TOKEN) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end('{"error":"Not authorised"}');
      return;
    }
    res.writeHead(reply.status, { 'Content-Type': 'application/json' });
    res.end(reply.body);
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const PORT = site.address().port;

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wlsync-'));
  const serverDir = path.join(root, 'server');
  fs.mkdirSync(serverDir);
  fs.writeFileSync(path.join(serverDir, 'server.properties'), 'white-list=true\n');
  const wl = path.join(serverDir, 'whitelist.json');
  const envFile = path.join(root, '.env');
  const logFile = path.join(root, 'sync.log');

  const writeEnv = (lines) => fs.writeFileSync(envFile, lines.join('\n') + '\n');
  const goodEnv = [`MINECRAFT_WHITELIST_TOKEN=${TOKEN}`, `MINECRAFT_SERVER_DIR=${serverDir}`];

  function run(extra = [], port = PORT) {
    return new Promise((resolve) => {
      execFile('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT,
        '-Port', String(port), '-EnvFile', envFile, '-LogFile', logFile, ...extra,
      ], { timeout: 60000 }, (err, stdout, stderr) => {
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(stdout) + String(stderr) });
      });
    });
  }
  const onDisk = () => fs.readFileSync(wl, 'utf8');
  const seed = (players) => fs.writeFileSync(wl, JSON.stringify(players, null, 2));

  try {
    /* 1. The ordinary case: one joined, one lapsed. */
    writeEnv(goodEnv);
    seed([A, B]);
    reply = { status: 200, body: JSON.stringify([A, C], null, 2) };
    let r = await run();
    check('a changed list succeeds', r.code, 0);
    check('and is written exactly as the site sent it', onDisk(), reply.body);
    const bytes = fs.readFileSync(wl);
    ok('with no byte-order mark, which the server can choke on', !(bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF));
    ok('the log names who was added', /added: Charlie/.test(r.out));
    ok('and who was removed', /removed: Bravo/.test(r.out));
    ok('and says Crafty was not asked, rather than failing', /Crafty is not configured/.test(r.out));
    ok('no temp file is left behind', !fs.existsSync(wl + '.new'));

    /* 2. Nothing changed: the file is not rewritten. */
    const before = fs.statSync(wl).mtimeMs;
    await new Promise((res) => setTimeout(res, 50));
    r = await run();
    check('an unchanged list succeeds', r.code, 0);
    ok('and says so', /no change \(2 whitelisted\)/.test(r.out));
    check('without touching the file', fs.statSync(wl).mtimeMs, before);

    /* Every refusal below must leave the file byte-for-byte as it was. */
    const kept = onDisk();
    const refuses = async (label, setup, extra) => {
      await setup();
      const res = await run(...(extra || []));
      check(`${label}: refuses`, res.code, 1);
      check(`${label}: leaves whitelist.json alone`, onDisk(), kept);
      ok(`${label}: says it left it alone`, /left as it was/.test(res.out));
      writeEnv(goodEnv);
      return res;
    };

    /* 3. THE LOCKOUT. An empty list over a non-empty one is a fault. */
    await refuses('an empty list', () => { reply = { status: 200, body: '[]' }; });
    /* ...unless somebody says it is real. */
    reply = { status: 200, body: '[]' };
    r = await run(['-AllowEmpty']);
    check('-AllowEmpty lets a genuinely empty list through', r.code, 0);
    check('leaving an empty whitelist', JSON.parse(onDisk()), []);
    seed([A, C]);
    const restored = onDisk();
    const refuses2 = async (label, setup, extra) => {
      await setup();
      const res = await run(...(extra || []));
      check(`${label}: refuses`, res.code, 1);
      check(`${label}: leaves whitelist.json alone`, onDisk(), restored);
      writeEnv(goodEnv);
    };

    await refuses2('a wrong token', () => { writeEnv([`MINECRAFT_WHITELIST_TOKEN=wrong`, `MINECRAFT_SERVER_DIR=${serverDir}`]); reply = { status: 200, body: JSON.stringify([A]) }; });
    await refuses2('no token at all', () => { writeEnv([`MINECRAFT_SERVER_DIR=${serverDir}`]); });
    await refuses2('a player with a fake uuid', () => { reply = { status: 200, body: JSON.stringify([A, { uuid: 'not-a-uuid', name: 'Eve' }]) }; });
    await refuses2('a name with a space in it', () => { reply = { status: 200, body: JSON.stringify([{ uuid: A.uuid, name: 'a b c' }]) }; });
    await refuses2('an error object instead of a list', () => { reply = { status: 200, body: '{"error":"oops"}' }; });
    await refuses2('the site erroring', () => { reply = { status: 503, body: '{"error":"Could not read the roster"}' }; });
    await refuses2('a folder that is not a server', () => {
      reply = { status: 200, body: JSON.stringify([A]) };
      writeEnv([`MINECRAFT_WHITELIST_TOKEN=${TOKEN}`, `MINECRAFT_SERVER_DIR=${root}`]);
    });

    /* The site being down entirely. */
    const probe = net.createServer();
    await new Promise((res) => probe.listen(0, '127.0.0.1', res));
    const deadPort = probe.address().port;
    await new Promise((res) => probe.close(res));
    reply = { status: 200, body: JSON.stringify([A]) };
    r = await run([], deadPort);
    check('the site down: refuses', r.code, 1);
    check('the site down: leaves whitelist.json alone', onDisk(), restored);

    /* Secrets stay out of the log. */
    const log = fs.readFileSync(logFile, 'utf8');
    ok('the token never appears in the log', !log.includes(TOKEN));
  } finally {
    site.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[whitelist-sync] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  process.exit(1);
}
console.log(`[whitelist-sync] ${passed} assertions passed.`);
