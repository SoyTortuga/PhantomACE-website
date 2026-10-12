#!/usr/bin/env node
/* ══════════════════════════════════════════════
   THE SIGNED-OUT PROMPT — test suite

     node server/scripts/test-signed-out-prompt.js

   The home page tells a signed-out visitor five specific things they
   cannot do. Not "unlock features" — five claims about real handlers:
   Dino Park refuses them, a Skull Clicker run stays in one browser, a
   dropped code cannot be redeemed, a giveaway entry cannot win, and
   inventory and Phamily Time are account-only.

   COPY THAT MAKES CLAIMS IS COPY THAT CAN GO STALE, and this kind goes
   stale silently: the day guests are allowed to win a prize, or Dino Park
   grows a local save, nothing breaks — the front page just starts lying to
   every visitor who is not signed in. The guidelines page did exactly that
   for weeks.

   So each claim is checked against the handler that enforces it. If the
   rule changes, this fails and names the sentence to rewrite.

   The other half is the flash. The panel is REVEALED by script, never
   hidden by it: shipped `hidden` and shown only once we know there is no
   session. Ship it visible and every logged-in visitor reads "You're not
   signed in" on every single load until the script catches up.
   ══════════════════════════════════════════════ */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { onRequestGet as dinoGet } from '../../functions/api/dino-park.js';
import { onRequestGet as inventoryGet } from '../../functions/api/inventory.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(REPO, p), 'utf8');
const stripJs = (t) => t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

const html = read('index.html');
/* The panel's own markup, so a claim found here is a claim the visitor
   actually reads — not one left somewhere else on the page. */
const panel = (() => {
  const i = html.indexOf('id="homeSignIn"');
  if (i === -1) return '';
  const end = html.indexOf('</section>', i);
  return html.slice(html.lastIndexOf('<section', i), end);
})();
const prose = panel.replace(/<[^>]+>/g, ' ').replace(/&mdash;/g, '-').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

/* ── It exists, and it is revealed rather than hidden ───────────────── */
{
  ok('the panel is on the home page', panel.length > 0);
  /* THE FLASH. Shipped hidden; a logged-in visitor must never read it. */
  ok('it ships hidden', /id="homeSignIn"[^>]*\shidden/.test(html));

  const js = stripJs(read('js/pages/home.js'));
  ok('the script reveals it', /homeSignIn/.test(js) && /hidden = false/.test(js));
  ok('and never hides it at runtime', !/hidden = true/.test(js));
  /* Gated on a real session, not on the element existing. */
  ok('gated on the session', /getSession/.test(js));
  ok('and on a user id rather than a truthy object', /session\.user_id/.test(js));
  /* getSession() returns null for a cookie it cannot verify, so that path
     correctly shows the panel. The guard is for auth.js not loading at
     all: knowing nothing must not be reported as "signed out". */
  ok('a missing getSession leaves it hidden', /catch[\s\S]{0,400}return;/.test(js));
  ok('and the call is feature-checked', /typeof getSession === 'function'/.test(js));

  ok('the button calls the shared login', /onclick="loginWithTwitch\(\)"/.test(panel));
  const auth = stripJs(read('js/auth.js'));
  ok('which js/auth.js defines', /function loginWithTwitch\s*\(/.test(auth));
}

/* ── Claim 1: Dino Park will not open ───────────────────────────────── */
{
  ok('the panel says Dino Park needs an account', /Dino Park won't open/i.test(prose));
  const res = await dinoGet({
    env: { MARKETPLACE: { async get() { return null; }, async list() { return { keys: [] }; } } },
    request: new Request('http://localhost/api/dino-park'),
  });
  check('and the handler refuses a visitor with no session', res.status, 401);
}

/* ── Claim 2: a Skull Clicker run stays in one browser ──────────────── */
{
  ok('the panel says the run only saves in this browser', /only saves in this browser/i.test(prose));
  /* The cross-device save is logged-in only; a guest id is per-browser. */
  const skull = read('functions/api/skull-clicker.js');
  ok('the cloud save is for logged-in players only', /LOGGED-IN PLAYERS ONLY/.test(skull));
  ok('and a guest id is recognisable as one', /startsWith\('guest_'\)/.test(skull));
}

/* ── Claim 3: a dropped code cannot be redeemed ─────────────────────── */
{
  ok('the panel says codes cannot be redeemed', /can't be redeemed/i.test(prose));
  const codes = stripJs(read('functions/api/item-codes.js'));
  ok('and redeeming requires a session', /if \(!session\) return json\(\{ error: 'Not logged in' \}, 401\)/.test(codes));

  /* The five minutes is a real rule, not a figure of speech: the drop
     row's expiry IS the claim window. Said on the page, so checked. */
  ok('the panel says five minutes', /five minutes/i.test(prose));
  const registry = read('server/lib/registry.js');
  ok('and the drop code family really expires', /prefix: 'gwc_',[^}]*expiry: 'real'/.test(registry));
}

/* ── Claim 4: a guest entry can never win ───────────────────────────── */
{
  ok('the panel says a guest entry cannot win', /can never win/i.test(prose));
  const giveaway = read('functions/api/giveaway-entries.js');
  ok('and the draw excludes guests', /GUESTS NEVER WIN A REAL PRIZE/.test(giveaway));
}

/* ── Claim 5: no inventory, cosmetics or Phamily Time ───────────────── */
{
  ok('the panel says inventory and Phamily Time need an account', /No inventory, cosmetics or Phamily Time/i.test(prose));
  const res = await inventoryGet({
    env: { MARKETPLACE: { async get() { return null; }, async listValues() { return []; } } },
    request: new Request('http://localhost/api/inventory'),
  });
  check('and inventory refuses a visitor with no session', res.status, 401);
  ok('as does phamily-time', /Not logged in/.test(read('functions/api/phamily-time.js')));
}

/* ── Nothing it says about Twitch is wishful ────────────────────────── */
{
  /* "no password" has to stay true: the site must never collect one. */
  ok('the panel promises no password', /no password/i.test(prose));
  const auth = read('functions/api/auth/twitch.js');
  ok('and auth is OAuth, with no password field anywhere',
    /oauth2\/authorize/.test(auth) && !/password/i.test(auth));
}

/* ── House style ────────────────────────────────────────────────────── */
{
  const css = read('css/pages/home.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
  const block = css.slice(css.indexOf('.home-signin'), css.indexOf('.home-media-play'));
  ok('the prompt has styles of its own', block.length > 100);
  check('no box-shadow', (block.match(/box-shadow/g) || []).length, 0);
  check('no side-edge borders', (block.match(/border-(left|right)\s*:/g) || []).length, 0);
  check('no backdrop-filter', (block.match(/backdrop-filter/g) || []).length, 0);
  const hexes = [...new Set([...block.matchAll(/#[0-9a-fA-F]{3,8}/g)].map(m => m[0].toLowerCase()))];
  check('every colour comes from a token', hexes, []);
  /* Body copy stays readable — 14px is the base. */
  const small = [...block.matchAll(/font-size:\s*(\d+)px/g)].map(m => Number(m[1])).filter(n => n < 13);
  check('nothing drops below 13px', small, []);

  /* No eyebrow kicker, and not the generic one-filled-one-outlined hero
     formula: this panel makes an argument and offers ONE action. */
  const buttons = (panel.match(/class="btn-(primary|secondary)"/g) || []).length;
  check('it offers exactly one button', buttons, 1);
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[signed-out-prompt] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  process.exit(1);
}
console.log(`[signed-out-prompt] ${passed} assertions passed.`);
