#!/usr/bin/env node
/* ══════════════════════════════════════════════
   STATIC CACHING — the policy, and that `send` actually honours it

     node server/scripts/test-static-cache.js

   `send` defaults every file to `public, max-age=0`, so a repeat visitor
   revalidated every asset it already held and the rig answered all of it
   through the tunnel. staticCacheControl decides what may be cached and for
   how long, around the constraint that there is NO fingerprinting here:
   deploy is `git pull`, filenames are stable, so a long browser max-age on
   css/js would serve a stale site after a deploy.

   Two things are pinned, because either one failing silently undoes the
   other:

     - the policy itself, path by path, including what must NOT be cached;
     - that the header survives `send`. send only sets Cache-Control when
       nothing else has (its index.js:746), which is the whole mechanism --
       a send upgrade that changed that would quietly restore max-age=0 on
       everything, with no error anywhere. So the real thing is served over
       a real socket and the response header is read back.

   HTML is the one that matters most to get wrong-way-safe: a deploy has to
   be visible immediately, and overlay.html carries its own reload token
   precisely because stale HTML has bitten this site before.
   ══════════════════════════════════════════════ */

import http from 'node:http';
import path from 'node:path';
import send from 'send';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { staticCacheControl, createStatic } from '../static.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

/* ── The policy ──────────────────────────────────────────────────────── */
{
  const cc = staticCacheControl;

  /* Fonts are the one genuinely immutable class: owned, self-hosted, and
     replaced by adding a file rather than overwriting one. They also load on
     every single page, so this is the biggest repeat-visit win available
     without fingerprinting. */
  check('a woff2 font is immutable for a year',
    cc('/assets/fonts/Grenze-Variable.woff2'), 'public, max-age=31536000, immutable');
  check('and so is the ttf fallback',
    cc('/assets/fonts/Grenze.ttf'), 'public, max-age=31536000, immutable');

  /* Art and audio: the browser still revalidates, so replacing a sprite under
     the same name is picked up; the edge is what stops the rig serving the
     same atlas to every viewer. */
  const art = 'public, max-age=0, s-maxage=86400, stale-while-revalidate=604800';
  check('an image gets a shared-cache window, not a browser one',
    cc('/assets/images/phantomace-logo.png'), art);
  check('audio the same', cc('/assets/audio/sub-alert.mp3'), art);
  ok('and the browser is never told to hold art without asking',
    /(^|,\s*)max-age=0(,|$)/.test(cc('/assets/images/hero-title.png')));

  /* Code changes on every deploy, so its window is short and the browser
     always revalidates. */
  const code = 'public, max-age=0, s-maxage=300';
  check('a stylesheet gets the short window', cc('/css/variables.css'), code);
  check('a script too', cc('/js/pages/overlay.js'), code);
  check('and a game asset path', cc('/games/dino-park/assets/atlas.png'), code);
  ok('no browser max-age on code, or a deploy would serve a stale site',
    /max-age=0/.test(cc('/css/components.css')));

  /* Nothing else is claimed. A null means "whatever send does", which is
     revalidate-always. */
  /* The canonical forms, which are what actually gets served -- the resolver
     308s /index.html to / and /overlay.html to /overlay. */
  check('the root page is not claimed', cc('/'), null);
  check('nor the overlay', cc('/overlay'), null);
  check('nor a page by its extensionless name', cc('/about'), null);
  check('nor by its .html name, should one ever be served directly',
    cc('/overlay.html'), null);
  check('nor an unknown path', cc('/robots.txt'), null);
}

/* ── Served for real, and the header survives `send` ──────────────────── */
{
  const statik = createStatic(REPO);

  /* The same shape index.js uses: resolve, set headers, pipe. If this stops
     matching index.js the test is worth less, so it is deliberately the
     smallest possible copy of that sequence -- resolve and the policy are
     both imported, not restated. */
  const server = http.createServer((req, res) => {
    const url = new URL('http://localhost' + req.url);
    const decision = statik.resolve(url.pathname, url.search);
    if (decision.kind !== 'file') { res.writeHead(404); res.end(); return; }
    if (!/\.html?$/i.test(decision.relPath)) {
      const cc = staticCacheControl(url.pathname);
      if (cc) res.setHeader('Cache-Control', cc);
    }
    send(req, decision.relPath, { root: REPO, dotfiles: 'deny', index: false }).pipe(res);
  });

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const head = (p) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      res.resume();
      resolve({ status: res.statusCode, cc: res.headers['cache-control'], etag: res.headers.etag });
    }).on('error', reject);
  });

  const font = await head('/assets/fonts/GodOfWar.ttf');
  check('the font is served', font.status, 200);
  check('AND SEND KEPT OUR HEADER -- the whole mechanism',
    font.cc, 'public, max-age=31536000, immutable');

  const css = await head('/css/variables.css');
  check('the stylesheet is served', css.status, 200);
  check('with the short shared window', css.cc, 'public, max-age=0, s-maxage=300');

  const img = await head('/assets/images/phantomace-logo.png');
  check('an image is served', img.status, 200);
  check('with the day-long shared window',
    img.cc, 'public, max-age=0, s-maxage=86400, stale-while-revalidate=604800');

  /* HTML must come back on send's own terms. A deploy has to be visible.
     Served at '/', because the resolver 308s /index.html to it. */
  const html = await head('/');
  check('the homepage is served', html.status, 200);
  ok('with a Cache-Control at all, from send', !!html.cc);
  ok('and NOT a shared-cache window', !/s-maxage/.test(html.cc || ''));
  ok('so a deploy is visible immediately', /max-age=0/.test(html.cc || ''));

  /* A page whose relPath is .html but whose URL has no extension: the
     exclusion keys off the RESOLVED file, so this must be uncached too. */
  const bare = await head('/about');
  check('an extensionless page is served', bare.status, 200);
  ok('and it too is uncached', !!bare.cc && !/s-maxage/.test(bare.cc));

  /* Same for a game directory, which resolves to its own index.html -- the
     one case where the URL prefix (/games/) and the resolved file disagree. */
  const game = await head('/games/dino-park/');
  check('a game page is served', game.status, 200);
  ok('and is treated as the HTML it is, not as a /games/ asset',
    !!game.cc && !/s-maxage/.test(game.cc));

  /* Conditional requests still work -- the point was never to stop
     revalidation, only to stop it costing the rig every byte. */
  ok('an ETag is still sent, so a revalidation is a 304', !!css.etag);

  await new Promise(r => server.close(r));
}

/* ── Report ─────────────────────────────────────────────────────────── */
if (failures.length) {
  console.error(`\n✗ ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`[static-cache] ${passed} assertions passed.`);
