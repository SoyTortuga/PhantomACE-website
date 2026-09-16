#!/usr/bin/env node
/* ══════════════════════════════════════════════
   Probe URL-handling behavior of an origin.

   Phase 0: run against production (Cloudflare Pages) to
   capture the behavior the Node server must reproduce.
   Phase 3: run against the Node server and diff the two.

   Usage:
     node server/scripts/probe-urls.cjs https://phantomace.tv  > pages.json
     node server/scripts/probe-urls.cjs http://127.0.0.1:8789  > node.json

   Deliberately does NOT follow redirects — the 308s are the
   thing being measured.
   ══════════════════════════════════════════════ */

const PATHS = [
  // Root / index resolution
  '/',
  '/index.html',
  '/index',
  // Clean-URL canonicalization (the login return_to dependency)
  '/membership',
  '/membership.html',
  '/membership.html?x=1',     // is the query string preserved across the 308?
  '/membership?x=1',
  // Nested directory index resolution
  '/games/dino-park/',
  '/games/dino-park',
  '/games/dino-park/index.html',
  // Pages resolved by shape, not by file (server/static.js rewrites)
  '/user/phantomace',          // profile.html
  '/thread/1',                 // thread.html
  '/thread/abc',               // not an id -> 404, not the page
  '/thread/1/extra',           // too many segments -> 404
  // Static asset headers
  '/css/base.css',
  '/assets/images/favicon.ico',
  // 404 handling — does it serve the custom 404.html body?
  '/definitely-not-a-real-page',
  '/api/definitely-not-a-real-route',
  // MUST be unreachable (these are what .assetsignore protects today)
  '/_private/giveaway-codes/common_bonus_codes.txt',
  '/_private/BROADCASTER-SETUP-STEPS.txt',
  '/games/dino-park/_build-atlas.js',
  '/.dev.vars',
  '/wrangler.toml',
  '/package.json',
  '/functions/api/bot/send-chat.js',
];

const HEADERS_OF_INTEREST = [
  'location',
  'content-type',
  'cache-control',
  'x-content-type-options',
  'referrer-policy',
  'permissions-policy',
  'content-security-policy',
  'access-control-allow-origin',
];

async function probe(origin, p) {
  const url = origin.replace(/\/$/, '') + p;
  try {
    const res = await fetch(url, { redirect: 'manual' });
    const body = await res.text();
    const picked = {};
    for (const h of HEADERS_OF_INTEREST) {
      const v = res.headers.get(h);
      if (v !== null) picked[h] = v;
    }
    return {
      path: p,
      status: res.status,
      headers: picked,
      bodyBytes: body.length,
      // Fingerprints that identify *which* document came back without
      // storing whole pages in the diff.
      isCustom404Page: /This page vanished into the chaos/i.test(body),
      bodyStartsWith: body.slice(0, 60).replace(/\s+/g, ' ').trim(),
    };
  } catch (err) {
    return { path: p, error: String(err && err.message || err) };
  }
}

async function main() {
  const origin = process.argv[2];
  if (!origin) {
    console.error('usage: node probe-urls.cjs <origin>');
    process.exit(2);
  }
  const results = [];
  for (const p of PATHS) results.push(await probe(origin, p));
  console.log(JSON.stringify({ origin, probedAt: new Date().toISOString(), results }, null, 2));
}

main();
