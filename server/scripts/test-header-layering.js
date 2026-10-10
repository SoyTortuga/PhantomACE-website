#!/usr/bin/env node
/* ══════════════════════════════════════════════
   THE HEADER MUST STAY ON TOP

     node server/scripts/test-header-layering.js

   The shared header is injected into <div id="site-header"></div>, and the
   <header> inside it is position: fixed with a high z-index. That only
   works while the WRAPPER stays out of the way: give #site-header a
   z-index of its own and it becomes a stacking context, which traps the
   header's z-index and the account menu's INSIDE it. They are then only
   high relative to each other, and any page element on the same layer that
   comes later in the document paints over the open menu.

   That shipped on the home page. The backdrop change gave #site-header
   `z-index: 1` along with the page sections, .hero also had `z-index: 1`,
   and on a tie the later element wins — so the hero swallowed every click
   on the menu. The menu opened, looked perfect, and did nothing.

   NOTHING ABOUT IT LOOKED WRONG, which is why it needs a test rather than
   an eye: the only symptom was clicks going nowhere, on one page.
   ══════════════════════════════════════════════ */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(REPO, p), 'utf8');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

/* Every stylesheet, since any of them could do this to any page. */
const sheets = [];
const walk = (dir) => {
  for (const e of readdirSync(join(REPO, dir), { withFileTypes: true })) {
    const rel = dir + '/' + e.name;
    if (e.isDirectory()) walk(rel);
    else if (e.name.endsWith('.css')) sheets.push(rel);
  }
};
walk('css');
ok('there are stylesheets to check', sheets.length > 5);

/* Strip comments first — this file's own explanation names the property it
   is looking for, and so does the fix's. */
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, ' ');

/* The properties that make an element a stacking context when it is
   positioned, or unconditionally. Any of them on the wrapper clamps the
   header. */
const CLAMPING = /(?:z-index\s*:\s*(?!auto)|transform\s*:\s*(?!none)|filter\s*:\s*(?!none)|perspective\s*:\s*(?!none)|contain\s*:\s*(?:layout|paint|strict|content)|isolation\s*:\s*isolate|mix-blend-mode\s*:\s*(?!normal)|will-change\s*:\s*(?:transform|opacity|filter))/;

const offenders = [];
for (const sheet of sheets) {
  const css = strip(read(sheet));
  /* Every rule whose selector list mentions the wrapper. */
  for (const m of css.matchAll(/([^{}]*#site-header[^{}]*)\{([^}]*)\}/g)) {
    const selector = m[1].replace(/\s+/g, ' ').trim();
    const body = m[2];
    if (CLAMPING.test(body)) {
      offenders.push(`${sheet}: ${selector} { ${body.replace(/\s+/g, ' ').trim()} }`);
    }
  }
}
check('no stylesheet makes #site-header a stacking context', offenders, []);

/* The other half: the header inside the wrapper must actually be lifted,
   or it would sit under the page whatever the wrapper does. */
{
  /* The header is styled in layout.css and the menu in components.css, so
     the rule is looked for across both rather than assumed into one. */
  const shared = [read('css/layout.css'), read('css/components.css')]
    .map(strip).join(' ');
  const block = /\.site-header\s*\{([^}]*)\}/.exec(shared);
  ok('the header has a rule of its own', !!block);
  const body = block ? block[1] : '';
  ok('it is taken out of the flow', /position\s*:\s*(fixed|sticky)/.test(body));
  const z = /z-index\s*:\s*(\d+)/.exec(body);
  ok('with a z-index', !!z);
  ok('well above ordinary page content', z && Number(z[1]) >= 100);

  /* And the account menu above the header it sits in. */
  const menu = /\.account-menu\s*\{([^}]*)\}/.exec(shared);
  ok('the account menu has a rule', !!menu);
  const mz = menu ? /z-index\s*:\s*(\d+)/.exec(menu[1]) : null;
  ok('and a z-index above the header’s', !!mz && !!z && Number(mz[1]) > Number(z[1]));
}

/* The specific page it broke on, named — the home page is the only one with
   a full-viewport fixed backdrop, which is what made a layering mistake
   there both easy and invisible. */
{
  const home = strip(read('css/pages/home.css'));
  const backdrop = /\.site-backdrop\s*\{([^}]*)\}/.exec(home);
  ok('the home backdrop still exists', !!backdrop);
  ok('and takes no pointer events', backdrop && /pointer-events\s*:\s*none/.test(backdrop[1]));
  ok('sitting at the bottom', backdrop && /z-index\s*:\s*0/.test(backdrop[1]));

  /* The sections that DO need lifting above it still are. */
  ok('the page sections are lifted above the backdrop', /\.home-section[\s\S]{0,120}z-index:\s*1/.test(home));
}

/* ── Report ─────────────────────────────────────────────────────────── */
if (failures.length) {
  console.error(`\n✗ ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`[header-layering] ${passed} assertions passed.`);
