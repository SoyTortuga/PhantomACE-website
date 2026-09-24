#!/usr/bin/env node
/* ══════════════════════════════════════════════
   DYNAMIC DNS — keep an A record pointed at the rig's current public IP.

     node server/scripts/ddns-update.mjs            # apply
     node server/scripts/ddns-update.mjs --dry-run  # show what it would do
     node server/scripts/ddns-update.mjs --record=srt.phantomace.tv --zone=phantomace.tv

   The main site reaches the internet through the Cloudflare tunnel, which needs
   no public IP at all. srt.phantomace.tv instead resolves DIRECTLY to the rig's
   IP (a plain A record, not a tunnel hostname), so when that residential IP
   changes the record goes stale. This checks the rig's current public IP each
   run and updates the Cloudflare A record only when it has changed — so
   srt.phantomace.tv always points at the rig. Meant to run on a timer on the
   rig (see the scheduling note at the bottom).

   Needs a Cloudflare API token with Zone:DNS:Edit + Zone:Read on the zone,
   in server/.env (see .env.example):
     CLOUDFLARE_DDNS_TOKEN   the API token
     DDNS_ZONE               zone name or id      (default phantomace.tv)
     DDNS_RECORD             the record to keep    (default srt.phantomace.tv)
     DDNS_PROXIED            true = orange-cloud   (default false; direct to IP)
     DDNS_TTL                seconds               (default 60)

   Exit codes: 0 = up to date or updated · 1 = misconfig/API error · 2 = could
   not determine the public IP (transient; the timer will try again).
   ══════════════════════════════════════════════ */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

const API = 'https://api.cloudflare.com/client/v4';

function arg(name, fallback = null) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  return process.argv.includes(`--${name}`) ? true : fallback;
}
const DRY = process.argv.includes('--dry-run');
const log = (...a) => console.log('[ddns]', ...a);
const die = (code, msg) => { console.error('[ddns] ' + msg); process.exit(code); };

const TOKEN  = process.env.CLOUDFLARE_DDNS_TOKEN;
const ZONE   = String(arg('zone')   || process.env.DDNS_ZONE   || 'phantomace.tv');
const RECORD = String(arg('record') || process.env.DDNS_RECORD || 'srt.phantomace.tv');
const PROXIED = (arg('proxied') === true) || String(process.env.DDNS_PROXIED || 'false').toLowerCase() === 'true';
const TTL = Math.max(60, parseInt(process.env.DDNS_TTL || '60', 10) || 60);   // Cloudflare's floor is 60s

if (!TOKEN) die(1, 'CLOUDFLARE_DDNS_TOKEN is not set (server/.env). Create a token with Zone:DNS:Edit + Zone:Read.');

/* Is it a bare IPv4? (We keep an A record; AAAA is out of scope here.) */
const isIPv4 = (s) => /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(String(s || '').trim());

/* The rig's current public IP, from a couple of independent sources so one
   flaky endpoint doesn't strand the record. An explicit --ip=... wins (testing). */
async function publicIp() {
  const forced = arg('ip');
  if (forced) return String(forced).trim();
  const sources = [
    { url: 'https://api.ipify.org', parse: t => t.trim() },
    { url: 'https://1.1.1.1/cdn-cgi/trace', parse: t => (t.match(/^ip=(.+)$/m) || [])[1] },
    { url: 'https://ifconfig.me/ip', parse: t => t.trim() },
  ];
  for (const s of sources) {
    try {
      const r = await fetch(s.url, { headers: { 'User-Agent': 'phantomace-ddns' } });
      if (!r.ok) continue;
      const ip = s.parse(await r.text());
      if (isIPv4(ip)) return ip;
    } catch { /* try the next source */ }
  }
  return null;
}

async function cf(pathPart, opts = {}) {
  const r = await fetch(API + pathPart, {
    ...opts,
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  let body;
  try { body = await r.json(); } catch { body = null; }
  if (!r.ok || !body || body.success === false) {
    const err = body && body.errors && body.errors.length ? JSON.stringify(body.errors) : ('HTTP ' + r.status);
    throw new Error(err);
  }
  return body.result;
}

async function main() {
  const ip = await publicIp();
  if (!ip) die(2, 'Could not determine the public IP from any source. Will retry next run.');

  const zoneId = /^[0-9a-f]{32}$/i.test(ZONE) ? ZONE
    : (await cf(`/zones?name=${encodeURIComponent(ZONE)}`))[0]?.id;
  if (!zoneId) die(1, `Zone "${ZONE}" not found (check the name and the token's zone access).`);

  const existing = (await cf(`/zones/${zoneId}/dns_records?type=A&name=${encodeURIComponent(RECORD)}`))[0];

  if (existing && existing.content === ip && existing.proxied === PROXIED) {
    log(`up to date — ${RECORD} → ${ip}${PROXIED ? ' (proxied)' : ''}`);
    return;
  }

  const payload = { type: 'A', name: RECORD, content: ip, ttl: TTL, proxied: PROXIED };

  if (DRY) {
    log(`DRY RUN — would ${existing ? 'update' : 'create'} ${RECORD} → ${ip}` +
        (existing ? ` (was ${existing.content})` : '') + `${PROXIED ? ' (proxied)' : ''}`);
    return;
  }

  if (existing) {
    await cf(`/zones/${zoneId}/dns_records/${existing.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
    log(`updated ${RECORD}: ${existing.content} → ${ip}${PROXIED ? ' (proxied)' : ''}`);
  } else {
    await cf(`/zones/${zoneId}/dns_records`, { method: 'POST', body: JSON.stringify(payload) });
    log(`created ${RECORD} → ${ip}${PROXIED ? ' (proxied)' : ''}`);
  }
}

main().catch(err => die(1, 'FAILED: ' + err.message));

/* ── Run it on a timer on the rig (PowerShell, one-time setup) ──────────────
   Every 5 minutes via Task Scheduler, logging to a file:

     $node = (Get-Command node).Source
     $script = 'C:\Users\EZiRLS8\Documents\PhantomACE Website\server\scripts\ddns-update.mjs'
     $action = New-ScheduledTaskAction -Execute $node -Argument "`"$script`"" `
       -WorkingDirectory 'C:\Users\EZiRLS8\Documents\PhantomACE Website'
     $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
       -RepetitionInterval (New-TimeSpan -Minutes 5)
     Register-ScheduledTask -TaskName 'phantomace-ddns' -Action $action -Trigger $trigger `
       -Description 'Keep srt.phantomace.tv pointed at the rig IP' -User $env:USERNAME -RunLevel Limited

   Test first:  node server/scripts/ddns-update.mjs --dry-run
   ────────────────────────────────────────────────────────────────────────── */
