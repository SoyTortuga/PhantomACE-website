#!/usr/bin/env node
/* ══════════════════════════════════════════════
   SETTINGS — test suite

     node server/scripts/test-settings.js

   The settings page owns NO rule. Every switch on it already existed, is
   enforced by the route that stores it, and is reached from the page by
   calling that same route. So this suite is mostly about the seams, because
   a gathering page fails in exactly two ways:

     IT DISAGREES WITH THE THING IT GATHERS. A second copy of "absent means
     on", of the theme write, or of the role re-check drifts from the
     original and the page then confidently shows the wrong state. Checked by
     asserting there is ONE of each, by reading the sources.

     IT CALLS SOMETHING THAT ISN'T THERE. A renamed action, a field the route
     never reads, an onclick naming a function no script on the page defines
     — all of which look perfect and do nothing. That last one shipped on the
     media page ("loadMedia is not defined"), reported as a failed save for a
     clip that had actually landed.

   The one piece of logic that IS this route's own is `hasPark`, and it has a
   trap in it: list() is a LIKE query, so the prefix for user 7 also matches
   user 70's save. Asserted below, both ways round.
   ══════════════════════════════════════════════ */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { onRequestGet as settingsGet } from '../../functions/api/settings.js';
import * as settingsRoute from '../../functions/api/settings.js';
import { profileSwitches } from '../../functions/api/forum/comments.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(REPO, p), 'utf8');
/* Comments explain the rules this file checks, so they are stripped before
   anything is looked for — otherwise the explanation satisfies the test. */
const stripCss = (t) => t.replace(/\/\*[\s\S]*?\*\//g, ' ');
const stripJs = (t) => t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

/* ── The harness ─────────────────────────────────────────────────────── */

function fakeEnv(store, fail = {}) {
  return {
    MARKETPLACE: {
      async get(key) {
        if (fail.get && fail.get.test(key)) throw new Error('table unavailable');
        return key in store ? JSON.parse(JSON.stringify(store[key])) : null;
      },
      async list({ prefix }) {
        if (fail.list && fail.list.test(prefix)) throw new Error('table unavailable');
        /* A LIKE query, deliberately: the real one matches every key that
           STARTS WITH the prefix, which is the whole point of the hasPark
           assertions further down. */
        return { keys: Object.keys(store).filter(k => k.startsWith(prefix)).map(name => ({ name })) };
      },
    },
  };
}

const SESSION = { user_id: '7', display_name: 'Keeper', profile_image: 'https://cdn.twitch/k.png', role: 'sub_tier1' };

function request(session, query = '') {
  const headers = session
    ? { Cookie: 'pham_session=' + encodeURIComponent(JSON.stringify(session)) }
    : {};
  return new Request('http://localhost/api/settings' + query, { headers });
}

async function get(store, session = SESSION, fail = {}, query = '') {
  const res = await settingsGet({ env: fakeEnv(store, fail), request: request(session, query) });
  return { status: res.status, body: await res.json() };
}

/* ── It is a reader, and only a reader ───────────────────────────────── */
{
  check('/api/settings reads', typeof settingsRoute.onRequestGet, 'function');
  /* NO WRITER. Each switch is stored by the route that enforces it; a POST
     here would be a second place that writes the same field, and the two
     would stop agreeing the first time one of them changed. */
  check('and never writes', 'onRequestPost' in settingsRoute, false);
}

/* ── Logged out ──────────────────────────────────────────────────────── */
{
  const r = await get({}, null);
  check('no session is turned away', r.status, 401);
  ok('with nothing about anybody in the answer', !r.body.account);
}

/* ── Absent means ON ─────────────────────────────────────────────────── */
{
  /* Every profile written before either switch existed has neither field.
     Defaulting the other way would silently opt out everyone who signed in
     before the switch was added. */
  const r = await get({ profile_7: { login: 'keeper' } });
  check('a profile with no switches set responds', r.status, 200);
  check('comments default on', r.body.commentsEnabled, true);
  check('mentions default on', r.body.mentionsEnabled, true);
  check('and the record is reported as present', r.body.hasProfile, true);

  const off = await get({ profile_7: { login: 'keeper', commentsEnabled: false, mentionsEnabled: false } });
  check('a stored no is reported for comments', off.body.commentsEnabled, false);
  check('and for mentions', off.body.mentionsEnabled, false);

  const mixed = await get({ profile_7: { commentsEnabled: false } });
  check('one off does not turn the other off', mixed.body.mentionsEnabled, true);

  /* THE DEFAULT IS NOT DECIDED HERE. It comes from the route that enforces
     it, so the page cannot disagree with the wall. */
  check('the shared reader says the same about nothing at all',
    profileSwitches(null), { commentsEnabled: true, mentionsEnabled: true });
  const src = stripJs(read('functions/api/settings.js'));
  ok('settings.js imports that reader rather than copying it', /profileSwitches/.test(src));
  ok('and holds no default of its own', !/(commentsEnabled|mentionsEnabled)\s*!==\s*false/.test(src));
}

/* ── No profile row at all ───────────────────────────────────────────── */
{
  /* A valid cookie with no record is possible, and the switches are stored
     ON that record — so the page has to know, or a save fails with "there is
     no profile to change yet" and no explanation. */
  const r = await get({});
  check('a session with no record still answers', r.status, 200);
  check('saying there is no record', r.body.hasProfile, false);
  check('with both switches still reading on', [r.body.commentsEnabled, r.body.mentionsEnabled], [true, true]);

  const html = read('settings.html');
  ok('and the page has a note to show for it', /id="setProfileNote"/.test(html));
  ok('hidden until then', /id="setProfileNote"[^>]*hidden/.test(html));
  ok('which the script reveals', /setProfileNote/.test(read('js/pages/settings.js')));
}

/* ── The park: consent row and save, separately ──────────────────────── */
{
  const none = await get({ profile_7: {} });
  check('no consent row means not visitable', none.body.parkVisitable, false);
  check('and no save means nothing to visit', none.body.hasPark, false);

  const open = await get({ profile_7: {}, parkpub_7: { name: 'Keeper' }, dino_park_7: { state: {} } });
  check('a consent row means visitable', open.body.parkVisitable, true);
  check('and a save means there is a park', open.body.hasPark, true);

  /* THE PREFIX TRAP. list() matches on LIKE 'dino_park_7%', which is also
     every save belonging to users 70 through 79999. Reporting hasPark from
     "the prefix returned something" would offer the visitors switch to
     somebody who has never played, on the strength of a stranger's save. */
  const neighbour = await get({ profile_7: {}, dino_park_70: { state: {} } });
  check('a longer id sharing the prefix is not my park', neighbour.body.hasPark, false);

  const mine = await get({ profile_7: {}, dino_park_7: { state: {} }, dino_park_70: { state: {} } });
  check('and mine is still found beside it', mine.body.hasPark, true);
}

/* ── A park table in trouble must not take the privacy switches with it ─ */
{
  /* The two have nothing to do with each other, and the switches are the
     reason anybody opened the page. */
  const consent = await get({ profile_7: { commentsEnabled: false }, parkpub_7: { name: 'x' } }, SESSION, { get: /^parkpub_/ });
  check('a failed consent read still answers', consent.status, 200);
  check('with the real switch state', consent.body.commentsEnabled, false);
  check('and the park reported closed rather than guessed', consent.body.parkVisitable, false);

  const save = await get({ profile_7: {}, dino_park_7: {} }, SESSION, { list: /^dino_park_/ });
  check('a failed save read still answers', save.status, 200);
  check('with hasPark false', save.body.hasPark, false);
  check('and the switches intact', save.body.mentionsEnabled, true);

  /* A FAILED PROFILE READ IS DIFFERENT and is deliberately NOT softened:
     the switches ARE that record, so a page that drew them from a fallback
     would show two checkboxes that mean nothing. */
  let threw = false;
  try { await get({ profile_7: {} }, SESSION, { get: /^profile_/ }); } catch { threw = true; }
  ok('but a failed profile read is not papered over', threw);
}

/* ── Whose settings ─────────────────────────────────────────────────── */
{
  /* There is no id to tamper with: the record read is keyed by the SESSION,
     so a query parameter cannot point this at somebody else's switches. */
  const r = await get({ profile_7: { login: 'keeper' }, profile_9: { login: 'someone', commentsEnabled: false } }, SESSION, {}, '?id=9');
  check('a query id is ignored', r.body.account.userId, '7');
  check('and the switches are still mine', r.body.commentsEnabled, true);

  check('the name comes from the session', r.body.account.displayName, 'Keeper');
  check('the role too', r.body.account.role, 'sub_tier1');
  /* The login is NOT in the cookie, and /user/<login> needs it. */
  check('the login comes from the record', r.body.account.login, 'keeper');

  const bare = await get({ profile_7: {} }, { user_id: '7' });
  check('a thin session still answers', bare.status, 200);
  check('with a role rather than undefined', bare.body.account.role, 'visitor');
  check('and an empty login rather than undefined', bare.body.account.login, '');
}

/* ── Every write goes to the route that owns it ──────────────────────── */
{
  const client = stripJs(read('js/pages/settings.js'));

  /* Which paths the page talks to at all, read out of the source. */
  const paths = [...new Set([...client.matchAll(/['"](\/api\/[a-z0-9/-]+)['"]/g)].map(m => m[1]))].sort();
  check('the page talks to three routes and no others', paths,
    ['/api/dino-park', '/api/forum/comments', '/api/settings']);

  /* And for each switch, that the action it sends is one the owning route
     actually accepts — derived from that route's source, so renaming an
     action on either side fails here. */
  const sends = [...client.matchAll(/path:\s*'(\/api\/[a-z0-9/-]+)'[\s\S]{0,160}?action:\s*'([a-z-]+)'/g)]
    .map(m => ({ path: m[1], action: m[2] }));
  ok('both posting switches were found in the source', sends.length >= 2);
  for (const s of sends) {
    const file = 'functions/api' + s.path.slice('/api'.length) + '.js';
    const route = stripJs(read(file));
    ok(`${file} accepts action '${s.action}'`,
      new RegExp("action\\s*===\\s*'" + s.action + "'").test(route));
  }

  /* The field names, the same way. A route reads exactly the field the page
     sends, or the switch silently does nothing. */
  const comments = stripJs(read('functions/api/forum/comments.js'));
  ok('the wall reads commentsEnabled off the payload', /payload\.commentsEnabled/.test(comments));
  ok('and mentionsEnabled', /payload\.mentionsEnabled/.test(comments));
  ok('the page sends those names', /commentsEnabled:\s*on/.test(client) && /mentionsEnabled:\s*on/.test(client));

  const park = stripJs(read('functions/api/dino-park.js'));
  ok('dino-park reads visitable off the body', /body\.visitable/.test(park));
  ok('and the page sends that name', /visitable:\s*on/.test(client));

  /* Every switch in the markup has a rule, and every rule has a switch.
     A renamed attribute leaves a checkbox that saves nothing. */
  const html = read('settings.html');
  const inMarkup = [...new Set([...html.matchAll(/data-switch="([a-z]+)"/g)].map(m => m[1]))].sort();
  const block = /var SWITCHES = \{([\s\S]*?)\n  \};/.exec(client);
  ok('the rule table was found', !!block);
  const inScript = block ? [...new Set([...block[1].matchAll(/^\s*([a-z]+):\s*\{/gm)].map(m => m[1]))].sort() : [];
  check('every switch in the page has a rule', inMarkup, inScript);
  ok('and there are three of them', inMarkup.length === 3);
}

/* ── Consent is never reported optimistically ───────────────────────── */
{
  const client = stripJs(read('js/pages/settings.js'));
  /* A refusal has to put the switch back. Showing "open to visitors" when
     the server never accepted it is the one failure here that matters. */
  ok('a refusal reverts the switch', /checked\s*=\s*!want/.test(client));
  ok('on a network error too', /catch\(function \(\) \{[\s\S]{0,200}checked\s*=\s*!want/.test(client.replace(/\s*\.catch\(/g, '.catch(')));
  ok('and the stored answer wins over the click', /typeof d\.visitable === 'boolean'/.test(client));
}

/* ── One role control, not two ──────────────────────────────────────── */
{
  /* The message this prints is a careful piece of honesty about what Twitch
     did and did not confirm. A copy of it is the copy that stops matching,
     so the settings page reuses the function AND the classes. */
  const auth = stripJs(read('js/auth.js'));
  const everyJs = ['js/auth.js', 'js/components.js', 'js/pages/settings.js'].map(p => stripJs(read(p))).join('\n');
  check('exactly one place asks Twitch to re-check',
    (everyJs.match(/\/api\/auth\/recheck-roles/g) || []).length, 1);

  for (const cls of ['account-role-badge', 'account-role-msg', 'account-role-refresh']) {
    ok(`auth.js finds every .${cls}`, new RegExp("querySelectorAll\\('\\." + cls + "'\\)").test(auth));
  }
  /* getElementById would have found the header's copy only, leaving the
     settings page showing a dash after a successful re-check. */
  ok('and none of them by id', !/getElementById\('accountRole/.test(auth));

  const html = read('settings.html');
  for (const cls of ['account-role-badge', 'account-role-msg', 'account-role-refresh']) {
    ok(`the page carries .${cls}`, html.includes(cls));
  }
  ok('calling the shared function', /onclick="refreshMyRole\(\)"/.test(html));
}

/* ── One theme writer ───────────────────────────────────────────────── */
{
  const components = stripJs(read('js/components.js'));
  const client = stripJs(read('js/pages/settings.js'));
  check('one place stores the theme',
    ([components, client, stripJs(read('js/auth.js'))].join('\n').match(/setItem\('pham-theme'/g) || []).length, 1);
  ok('components exports a setter, not just a toggle', /function setTheme\(/.test(components));
  ok('and the toggle goes through it', /function toggleTheme\(\)[\s\S]{0,200}setTheme\(/.test(components));
  ok('the page asks for a named theme', /setTheme\(/.test(client));
  ok('rather than setting the attribute itself', !/setAttribute\('data-theme'/.test(client));

  /* The picker has to light the theme that is actually on, including on
     first paint — a picker that always shows Dark is worse than none. */
  ok('the picker reads the live theme', /getAttribute\('data-theme'\)/.test(client));
  ok('and paints itself on load', /paintTheme\(\);/.test(client));
  /* The header glyph is on this page too. Flip it from there and a picker
     that only repaints on its own click goes on lighting the theme you just
     left. */
  ok('and repaints when something else changes the theme',
    /MutationObserver\(paintTheme\)[\s\S]{0,120}attributeFilter:\s*\['data-theme'\]/.test(client));
}

/* ── The notification keys are the bell's, not a copy ───────────────── */
{
  /* Three localStorage keys live in js/notifications.js. The settings page
     clears and re-asks against the same ones; a typo here would clear
     nothing and report "Cleared". */
  const notif = read('js/notifications.js');
  const client = read('js/pages/settings.js');
  const keys = [...notif.matchAll(/const (PA_NOTIF[A-Z_]*) = '([^']+)';/g)].map(m => ({ name: m[1], value: m[2] }));
  check('three keys were found in the bell', keys.length, 3);
  for (const k of keys) {
    ok(`the page uses the real ${k.name} (${k.value})`, client.includes("'" + k.value + "'"));
  }
}

/* ── The menu item is real now ──────────────────────────────────────── */
{
  const components = read('js/components.js');
  ok('the account menu links to the page', /href="\/settings"/.test(components));
  ok('and no longer says Soon', !/account-menu-soon/.test(components));
  /* The chip's styling went with it — dead CSS is how a "Soon" badge comes
     back by accident. */
  ok('the Soon chip has no stylesheet left', !/account-menu-soon/.test(read('css/components.css')));
  ok('nor the disabled item', !/account-menu-item-disabled/.test(read('css/components.css')));
}

/* ── The page loads what it uses ────────────────────────────────────── */
{
  const html = read('settings.html');

  /* static.js warns when a page misses one of these: the header renders and
     reports nothing, with the LIVE dot stuck offline and the bell empty. */
  const list = /const HEADER_SCRIPTS = \[([\s\S]*?)\];/.exec(read('server/static.js'));
  ok('the header script list was found', !!list);
  for (const m of (list ? list[1].matchAll(/'([^']+)'/g) : [])) {
    ok(`loads ${m[1]}`, html.includes('src="' + m[1] + '"'));
  }
  ok('and its own script', html.includes('src="/js/pages/settings.js"'));
  ok('and its own stylesheet', html.includes('href="/css/pages/settings.css"'));

  /* THE "loadMedia is not defined" CLASS OF BUG. Every function named by an
     onclick must be defined by a script this page loads, or the control
     looks perfect and throws into the console. */
  const loaded = [...html.matchAll(/src="(\/js\/[^"]+)"/g)].map(m => read(m[1].slice(1)));
  const everything = loaded.join('\n');
  const handlers = [...new Set([...html.matchAll(/onclick="([A-Za-z_$][\w$]*)\(/g)].map(m => m[1]))];
  ok('the page has handlers to check', handlers.length >= 3);
  for (const fn of handlers) {
    ok(`${fn}() is defined by a script this page loads`,
      new RegExp('(?:async )?function ' + fn + '\\s*\\(').test(everything));
  }

  /* The no-flash script, on every page: without it a light-mode reader gets
     a black flash before the stylesheet applies. */
  ok('the theme is applied before paint', /localStorage\.getItem\("pham-theme"\)/.test(html));

  /* An account page has nothing for a search engine, and every URL on it is
     someone's own. */
  ok('and it is not indexed', /name="robots"[^>]*noindex/.test(html));

  /* House rules: the shared hero, no eyebrow kicker above it. */
  ok('the shared page hero', /class="page-hero"/.test(html) && /page-hero-title/.test(html));
  ok('no eyebrow kicker', !/eyebrow|kicker/i.test(html));
}

/* ── House style in the new stylesheet ──────────────────────────────── */
{
  const css = stripCss(read('css/pages/settings.css'));

  check('no box-shadow', (css.match(/box-shadow/g) || []).length, 0);
  check('no backdrop-filter', (css.match(/backdrop-filter/g) || []).length, 0);
  check('no blur', (css.match(/blur\(/g) || []).length, 0);
  /* The side-accent rail, banned outright — including as a neutral grey
     divider, which is what a segmented control would reach for. */
  check('no side-edge borders at all', (css.match(/border-(left|right)\s*:/g) || []).length, 0);

  /* Every colour from a token, so a surface flips with the theme. The one
     exception is literal white on a red FILL, which is dark red in both
     themes and so needs white text in both. */
  const hexes = [...new Set([...css.matchAll(/#[0-9a-fA-F]{3,8}/g)].map(m => m[0].toLowerCase()))];
  check('the only hardcoded colour is white on a fill', hexes, ['#fff']);
  ok('used on the chosen theme button', /\.set-seg-btn\.is-on[^}]*#fff/.test(css));

  /* Body copy stays readable: 14px is the base and nothing here goes below
     it except the utilitarian system-font status lines. */
  const small = [...css.matchAll(/font-size:\s*(\d+)px/g)].map(m => Number(m[1])).filter(n => n < 14);
  for (const n of small) {
    ok(`${n}px text is system-font furniture, not body copy`, n >= 11);
  }

  /* It is loaded on one page, so it must not reach outside itself. */
  ok('every rule is scoped to this page', !/^\s*(body|html|a|p|ul|li|section)\s*\{/m.test(css));
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[settings] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  process.exit(1);
}
console.log(`[settings] ${passed} assertions passed.`);
