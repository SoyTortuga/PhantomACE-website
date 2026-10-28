/* ══════════════════════════════════════════════
   Shared bits for the two one-time consent flows.

   NOTHING SECRET IS EVER WRITTEN TO DISK. A refresh token is printed to the
   terminal for the operator to paste into the rig's service environment. A
   token written to a file under the repo is a token that gets committed one
   day; printing it keeps its lifetime as short as the scrollback.

   The loopback capture is the standard installed-app pattern: spin a local
   HTTP server, send the browser to the provider, and read the ?code= off the
   redirect back to 127.0.0.1. No public callback URL, nothing exposed.
   ══════════════════════════════════════════════ */

import http from 'node:http';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

/** Open the system browser, best-effort. The URL is printed regardless. */
export function openBrowser(url) {
  const cmd = process.platform === 'win32' ? 'cmd'
    : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); } catch { /* print-only is fine */ }
}

/**
 * Serve 127.0.0.1:<port> until the provider redirects back with a code.
 * Resolves { code, state }. Rejects on an error= redirect.
 */
export function captureCode({ port, path = '/callback', timeoutMs = 300_000 }) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (url.pathname !== path) { res.writeHead(404).end('not here'); return; }

      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><title>PhantomACE</title>
<body style="font-family:system-ui;background:#0a0a0a;color:#fff;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center;max-width:30rem;padding:2rem;border:1px solid #333">
<h1 style="color:${error ? '#ff5555' : '#FF0000'};margin:0 0 .5rem">${error ? 'Not connected' : 'Connected'}</h1>
<p style="color:#bbb">${error ? 'Something went wrong — tell the developer: ' + error : 'You can close this tab and hand the screen back.'}</p>
</div></body>`);

      clearTimeout(timer);
      server.close();
      if (error) reject(new Error(`Authorization was refused or failed: ${error}`));
      else if (!code) reject(new Error('Redirect carried no ?code='));
      else resolve({ code, state: url.searchParams.get('state') });
    });

    const timer = setTimeout(() => {
      server.close();
      reject(new Error('Timed out waiting for the browser redirect (5 min).'));
    }, timeoutMs);

    server.on('error', reject);
    server.listen(port, '127.0.0.1');
  });
}

/** Ask a question on the terminal (for the paste-the-URL fallback). */
export function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

/** Pull ?code= out of a pasted redirect URL (or accept a bare code). */
export function codeFromPaste(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  try { return new URL(raw).searchParams.get('code') || null; }
  catch { return /^[A-Za-z0-9._\-*]+$/.test(raw) ? raw : null; }
}

/** A loud, copy-pasteable block of env lines. */
export function printEnvBlock(title, lines) {
  const bar = '═'.repeat(66);
  console.log(`\n${bar}\n  ${title}\n${bar}`);
  for (const l of lines) console.log('  ' + l);
  console.log(`${bar}\n`);
}

/** Read a required value from argv/env, or die with a useful message. */
export function need(value, what) {
  if (!value) { console.error(`\n✗ Missing ${what}.\n`); process.exit(2); }
  return value;
}

/** Tiny argv reader: --flag value */
export function argv(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
