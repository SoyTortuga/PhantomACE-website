#!/usr/bin/env node
/* ══════════════════════════════════════════════
   BOT CONTROL — the collapsible-group UI

     node server/scripts/test-bot-control-ui.js

   Bot Control got long, so its groups are collapsible <details> with the
   title as the <summary>, and each group's open/closed state is remembered
   per browser. The failure modes this guards:
     - a group left as a plain <section> (no collapse),
     - a group with no data-botgroup key (its state can't persist),
     - localStorage read/write not guarded (throws in a private window and
       takes the whole page's init down).
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

const html = read('bot-control.html');
const css = read('css/pages/bot-control.css');
const js = read('js/pages/bot-control.js');

/* Every group is a collapsible details+summary, none left as a bare section. */
const groupDetails = [...html.matchAll(/<details class="bot-group" data-botgroup="(\w+)"( open)?>/g)];
ok('the page has collapsible groups', groupDetails.length >= 5);
check('no bot-group is still a plain <section>', /<section class="bot-group">/.test(html), false);
check('every group summary carries the title class',
  groupDetails.length, (html.match(/<summary class="bot-group-title">/g) || []).length);
check('details open and close tags balance',
  (html.match(/<details class="bot-group"/g) || []).length,
  (html.match(/<\/details>/g) || []).length);

/* Every group has a persistence key, and they are unique. */
const keys = groupDetails.map(m => m[1]);
ok('every group has a data-botgroup key', keys.every(Boolean));
check('the keys are unique', keys.length, new Set(keys).size);

/* The status/admin groups default collapsed (that is the point — hide what is
   not always needed); the working groups stay open. */
const openFor = {};
groupDetails.forEach(m => { openFor[m[1]] = !!m[2]; });
check('Event Subscriptions defaults collapsed', openFor.events, false);
check('Activity & Admin defaults collapsed', openFor.admin, false);
ok('a working group (chat) defaults open', openFor.chat === true);

/* The summary is styled as a clickable header with a caret, no marker. */
ok('the summary is clickable', /summary\.bot-group-title[\s\S]*?cursor:\s*pointer/.test(css));
ok('with a caret and no default marker',
  /summary\.bot-group-title::-webkit-details-marker\s*\{\s*display:\s*none/.test(css)
  && /summary\.bot-group-title::before[\s\S]*?content:/.test(css));

/* Persistence is wired and crash-safe. */
ok('open/closed state is persisted per group', /localStorage\.setItem\('botgroup:'|localStorage\.setItem\("botgroup:"|'botgroup:' \+/.test(js) && /addEventListener\('toggle'/.test(js));
ok('and the localStorage access is guarded (private windows throw)',
  /try\s*\{[\s\S]*?localStorage\.getItem[\s\S]*?\}\s*catch/.test(js)
  && /try\s*\{\s*localStorage\.setItem[\s\S]*?\}\s*catch/.test(js));

/* Init must run even if the script loads after DOMContentLoaded — a bare
   addEventListener would silently never fire then, killing persistence. */
ok('init runs whether or not DOMContentLoaded already fired',
  /document\.readyState === 'loading'/.test(js)
  && /else\s*\{\s*initCollapsibleGroups\(\)/.test(js));

console.log('');
if (failures.length) {
  console.log(`[bot-control-ui] ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.log(`  FAIL: ${f}`);
  process.exit(1);
}
console.log(`[bot-control-ui] ${passed} assertions passed.`);
