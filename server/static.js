/* ══════════════════════════════════════════════
   Static file serving: allowlist + Cloudflare Pages URL parity.

   SECURITY NOTE — read before changing anything here.
   The repo root is the web root (Pages used `pages_build_output_dir = "."`),
   so this directory contains `_private/` (real redeemable giveaway codes,
   broadcaster setup docs), `.dev.vars`, `server/.env`, `functions/`, and
   `node_modules/`. On Pages those stayed unreachable only because
   Cloudflare refuses to serve root-level paths beginning with `_` or `.` —
   NOT because of `.assetsignore`, which was verified inert (it's a
   Workers-assets feature, not a Pages one). None of that protection exists
   in Node.

   Therefore this module serves from an ALLOWLIST, never a denylist:
   anything not explicitly permitted is a 404, so a directory added
   tomorrow is private by default. `assertPrivatePathsUnreachable()` is
   called at boot and aborts startup if that ever stops being true.

   URL PARITY — the redirect rules below were measured against production
   Pages with server/scripts/probe-urls.cjs, not guessed. They matter
   because js/auth.js captures window.location.pathname into a `return_to`
   param that becomes the post-login redirect target: if the canonical form
   here disagreed with what the browser is on, every login would land on a
   404. js/nav.js:20 also compares hrefs against the literal '.html' form,
   so the links must stay as they are.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';

/* Recursively servable. Everything else at the root is denied unless it's
   an explicitly enumerated .html page (see rootHtmlFiles below). */
const ALLOWED_DIRS = ['assets', 'css', 'js', 'games'];

/* Paths that must never be reachable. Asserted at boot. */
const MUST_BE_UNREACHABLE = [
  '/_private/giveaway-codes/common_bonus_codes.txt',
  '/_private/giveaway-codes/mythic_bonus_codes.txt',
  '/_private/BROADCASTER-SETUP-STEPS.txt',
  '/_private/seed-giveaway-codes.js',
  '/.dev.vars',
  '/.gitignore',
  '/server/.env',
  '/server/index.js',
  '/functions/api/bot/send-chat.js',
  '/functions/api/inventory.js',
  '/package.json',
  '/package-lock.json',
  '/wrangler.toml',
  '/CLAUDE.md',
  '/demo-server.js',
  '/start-demo.bat',
  '/node_modules/pg/package.json',
  '/games/dino-park/_build-atlas.js',
  '/games/dino-park/_trex-preview.html',
  '/.git/config',
];

export function createStatic(root) {
  /* Enumerated once at boot: the root-level pages that may be served.
     Enumerating beats a wildcard because a new non-.html file dropped at
     the root is denied by default. */
  const rootHtmlFiles = new Set(
    fs.readdirSync(root, { withFileTypes: true })
      .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.html'))
      .map(e => e.name)
  );

  const exists = (rel) => {
    try { return fs.statSync(path.join(root, rel)); } catch { return null; }
  };

  /** Reject traversal, NUL, backslashes, dotfiles and underscore-prefixed
      files (the latter covers the 12 Dino Park build scripts, none of which
      are referenced by any page). */
  function segmentsAreSafe(segments) {
    for (const s of segments) {
      if (!s) return false;
      if (s === '.' || s === '..') return false;
      if (s.startsWith('.') || s.startsWith('_')) return false;
      if (s.includes('\0') || s.includes('\\')) return false;
    }
    return true;
  }

  /** Is this relative path inside the allowlist?
      Root-level requests may name the page either way — "/membership"
      (the canonical extensionless form) or "/membership.html" (which then
      308s to it) — so accept both spellings of an enumerated page. */
  function isAllowed(segments) {
    if (segments.length === 0) return false;

    /* A root page may share its name with an allowed directory, so the page
       spelling is tested FIRST. `games.html` and `games/` both exist: with
       the directory rule first, "/games" was denied for having only one
       segment and never fell through to the page check — a 404 on a main
       nav page, while "/games.html" still 308'd to it, so the games page
       was unreachable entirely. "/about" only escaped this because no
       "about/" directory happens to exist. */
    if (segments.length === 1 &&
        (rootHtmlFiles.has(segments[0]) || rootHtmlFiles.has(segments[0] + '.html'))) {
      return true;
    }

    if (ALLOWED_DIRS.includes(segments[0])) return segments.length > 1;
    return false;
  }

  /**
   * Decide what to do with a request path.
   * Pure and side-effect free so it can be unit-tested and asserted at boot.
   *
   * @returns {{kind:'redirect',location:string,status:number}
   *          |{kind:'file',relPath:string}
   *          |{kind:'notfound'}}
   */
  function resolve(pathname, search = '') {
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return { kind: 'notfound' };          // malformed percent-encoding
    }
    if (decoded.includes('\0') || decoded.includes('\\')) return { kind: 'notfound' };
    if (!decoded.startsWith('/')) return { kind: 'notfound' };

    const trailingSlash = decoded.length > 1 && decoded.endsWith('/');
    const raw = decoded.replace(/^\/+/, '').replace(/\/+$/, '');
    const segments = raw === '' ? [] : raw.split('/');

    // "/" -> the homepage
    if (segments.length === 0) {
      return rootHtmlFiles.has('index.html')
        ? { kind: 'file', relPath: 'index.html' }
        : { kind: 'notfound' };
    }

    if (!segmentsAreSafe(segments)) return { kind: 'notfound' };

    /* ── MOVED PATHS ────────────────────────────────────────────────────────
       Pages and folders whose names lagged behind what the thing is called.
       Renaming them changes URLs that already exist in bookmarks, in old
       chat messages and in anything the bot has posted, so the old paths
       keep working rather than starting to 404.

       301, not the 308 used for clean-URL canonicalisation: these are
       permanent and only ever GETs, so browsers and crawlers caching them is
       the point rather than a hazard.

       Checked BEFORE the .html rules on purpose. Those verify the file
       exists, and after a rename it does not — so /community-stats.html
       would 404 here instead of being forwarded. */
    const MOVED = [
      { from: ['games', 'shell-shock'], to: '/games/phamshock/' },
      { from: ['community-stats'],      to: '/phamily-time' },
      { from: ['community-stats.html'], to: '/phamily-time' },
    ];
    for (const m of MOVED) {
      if (m.from.every((seg, i) => segments[i] === seg)) {
        const rest = segments.slice(m.from.length);
        const base = rest.length ? m.to.replace(/\/$/, '') + '/' : m.to;
        return { kind: 'redirect', location: base + rest.join('/') + search, status: 301 };
      }
    }

    const last = segments[segments.length - 1];
    const dirOf = segments.slice(0, -1);

    // Pages canonicalises to the extensionless form; mirror it exactly.
    // "/x/index.html" -> "/x/",  "/index.html" -> "/",  "/foo.html" -> "/foo"
    if (last.toLowerCase() === 'index.html') {
      const loc = '/' + (dirOf.length ? dirOf.join('/') + '/' : '');
      return { kind: 'redirect', location: loc + search, status: 308 };
    }
    if (last.toLowerCase().endsWith('.html')) {
      const bare = last.slice(0, -'.html'.length);
      const candidate = [...dirOf, last].join('/');
      if (!isAllowed(segments) || !exists(candidate)) return { kind: 'notfound' };
      const loc = '/' + [...dirOf, bare].join('/');
      return { kind: 'redirect', location: loc + search, status: 308 };
    }
    // "/index" -> "/" (Pages special-cases the root index this way too)
    if (segments.length === 1 && last.toLowerCase() === 'index') {
      return { kind: 'redirect', location: '/' + search, status: 308 };
    }

    /* /user/<login> — a profile, served from profile.html.

       The page is real and the name is not: there is no file per person, so
       this is the one route on the site that resolves to a page by shape
       rather than by path. It sits BEFORE the allowlist because 'user' is
       not a served directory and never should be — nothing is read from
       disk here beyond the one enumerated page.

       The login is not decoded, looked up or passed on. It is matched only
       tightly enough to tell a profile request from a typo, and the page
       reads the real name from its own URL. A name that matches nothing
       still serves the page, which then says nobody is there — the same
       answer any other absent profile gets, and one that does not leak
       which logins exist by returning 404 for some and 200 for others. */
    if (segments.length === 2 && segments[0] === 'user' &&
        /^[A-Za-z0-9_]{1,30}$/.test(segments[1]) && exists('profile.html')) {
      return { kind: 'file', relPath: 'profile.html' };
    }

    /* /thread/<id> — a forum topic, served from thread.html on exactly the
       same terms: the page is real, the number is not a path, and a
       missing topic serves the page, which then says so. */
    if (segments.length === 2 && segments[0] === 'thread' &&
        /^[1-9][0-9]{0,17}$/.test(segments[1]) && exists('thread.html')) {
      return { kind: 'file', relPath: 'thread.html' };
    }

    if (!isAllowed(segments)) return { kind: 'notfound' };

    const rel = segments.join('/');

    // "/games/dino-park/" -> that directory's index.html
    if (trailingSlash) {
      const idx = rel + '/index.html';
      return exists(idx) ? { kind: 'file', relPath: idx } : { kind: 'notfound' };
    }

    const st = exists(rel);

    // Extensionless: prefer <path>.html, else redirect a real directory to
    // its slash form (Pages ADDS the trailing slash for directories — the
    // opposite direction from the .html rule above).
    if (!path.extname(last)) {
      const asHtml = rel + '.html';
      if (exists(asHtml)) return { kind: 'file', relPath: asHtml };
      if (st && st.isDirectory()) {
        return { kind: 'redirect', location: '/' + rel + '/' + search, status: 308 };
      }
      return { kind: 'notfound' };
    }

    if (st && st.isFile()) return { kind: 'file', relPath: rel };
    return { kind: 'notfound' };
  }

  /** Abort boot if anything sensitive is reachable. Cheap insurance against
      a future edit to ALLOWED_DIRS or the segment rules. */
  function assertPrivatePathsUnreachable() {
    const leaked = MUST_BE_UNREACHABLE.filter(p => resolve(p).kind === 'file');
    if (leaked.length) {
      console.error('FATAL: static allowlist would serve private paths:');
      for (const p of leaked) console.error('   ' + p);
      process.exit(1);
    }
    return true;
  }

  /* ── The shared header's dependencies ───────────────────────────────
     #site-header is a shared component whose BEHAVIOUR is not shared: each
     page opts in by loading the scripts that drive it. A page that forgets
     still renders a header that looks correct and reports nothing — the
     LIVE dot stuck offline, the bell permanently empty. Nothing throws,
     nothing 404s, and it ships.

     That happened to profile.html, and the sweep afterwards found
     bot-control.html had been missing notifications for however long.

     WARNS RATHER THAN EXITS, unlike the allowlist assertion above. That one
     guards against serving a secret; this one guards against a silent bell.
     Refusing to serve the whole site over a cosmetic regression would be
     the wrong trade — but shipping it unnoticed twice is why it is checked
     at all. */
  const HEADER_SCRIPTS = [
    '/js/auth.js',
    '/js/components.js',
    '/js/nav.js',
    '/js/notifications.js',
    '/js/twitch.js',
    '/js/member-search.js',
  ];

  function checkHeaderScripts() {
    const problems = [];
    for (const file of rootHtmlFiles) {
      let html;
      try { html = fs.readFileSync(path.join(root, file), 'utf8'); } catch { continue; }
      if (!html.includes('id="site-header"')) continue;      // no header, no dependency
      const missing = HEADER_SCRIPTS.filter(src => !html.includes(`src="${src}"`));
      if (missing.length) problems.push({ file, missing });
    }
    return problems;
  }

  return { resolve, assertPrivatePathsUnreachable, checkHeaderScripts, rootHtmlFiles, root };
}
