#!/usr/bin/env node
/* ══════════════════════════════════════════════
   GIVEAWAY ENTRY LABELS — the history row says where each entry came from

     node scripts/test-giveaway-entry-labels.js      (from server/)

   THE BUG THIS EXISTS FOR. The entry tracker on giveaway.html turns a
   ledger row's server-written `source` string into a human label. For a
   while every source except drops and Phamily Time fell through to a single
   "Channel points" catch-all, so bingo, maze, scramble, check-in and MTGBBB
   entries were all mislabelled — and a NEW entry source added server-side
   would silently inherit that wrong label with nothing to catch it.

   So two things are pinned here:
     1. entrySourceLabel() (lifted straight out of giveaway.html) maps every
        known source to its intended label, exactly.
     2. Every source string actually written to the monthly ledger by the
        server (the addEntries() callers, plus the direct `amoe` history
        write) is recognised by that function — anything that lands on the
        bare "Entry" fallback fails the test. That is the drift guard: add a
        source server-side without teaching the client, and this goes red.

   The channel-points "Enter Giveaway" reward is deliberately NOT a ledger
   source: it runs a separate per-stream live drawing (bot/giveaway-entry.js
   → addEntrant), so it never appears in this history and needs no label.

   No network, no database — it reads the repo's own files.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

/* ── Lift entrySourceLabel() out of giveaway.html ─────────────────────── */

const html = fs.readFileSync(path.join(REPO, 'giveaway.html'), 'utf8');
const fnMatch = html.match(/function entrySourceLabel\(src\) \{[\s\S]*?\n {4}\}/);
if (!fnMatch) {
  console.log('[entry-labels] could not find entrySourceLabel() in giveaway.html');
  process.exit(1);
}
// eslint-disable-next-line no-new-func
const entrySourceLabel = new Function('return (' + fnMatch[0] + ')')();

/* ── 1. The intended mapping, pinned exactly ──────────────────────────── */

const expected = {
  'drop:common':      'Common drop',
  'drop:uncommon':    'Uncommon drop',
  'drop:rare':        'Rare drop',
  'drop:mythic':      'Mythic drop',
  'phamily:Giveaway': 'Phamily Time',
  'bingo:rare':       'Commander Bingo',
  'maze:level7':      'Chat maze',
  'checkin:First':    'Stream check-in',
  'mtgbbb:mythic':    'MTGBBB',
  'chat-scramble':    'Chat scramble',
  'amoe':             'Free entry',
};
for (const [src, label] of Object.entries(expected)) {
  check(`entrySourceLabel(${src})`, entrySourceLabel(src), label);
}

// An unknown source is the neutral fallback, never "Channel points" (no
// channel-points source reaches this ledger).
check('unknown source falls back to "Entry"', entrySourceLabel('something-new'), 'Entry');
ok('fallback is not the old "Channel points" mislabel', entrySourceLabel('something-new') !== 'Channel points');

/* ── 2. Drift guard: every server-written ledger source is labelled ───── */

function walk(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

const apiFiles = walk(path.join(REPO, 'functions/api'));
const sources = new Set();

// The last string literal argument of an addEntries(...) call is the source.
// Args before it are identifiers / numbers / calls, never quoted strings, so
// the final `...` or '...' literal before the closing paren is the source.
// [^;] keeps the match inside one statement, so it never spans from the
// addEntries() definition or one call into a later call's string argument.
const addEntriesRe = /addEntries\(\s*env[^;]*?,\s*(`[^`]*`|'[^']*')\s*\)/g;
for (const f of apiFiles) {
  const code = fs.readFileSync(f, 'utf8');
  let m;
  while ((m = addEntriesRe.exec(code)) !== null) {
    // Strip quotes/backticks, and collapse any ${...} to a literal 'x' so the
    // prefix (checkin:, maze:level, …) survives for labelling.
    const lit = m[1].slice(1, -1).replace(/\$\{[^}]*\}/g, 'x');
    sources.add(lit);
  }
  // The free entry writes its history row directly, not via addEntries.
  if (/source:\s*'amoe'/.test(code)) sources.add('amoe');
}

ok('found the addEntries sources in functions/api', sources.size >= 7);

for (const src of [...sources].sort()) {
  const label = entrySourceLabel(src);
  ok(`ledger source "${src}" has a specific label (got "${label}")`,
     label && label !== 'Entry');
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[entry-labels] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[entry-labels] ${passed} assertions passed.`);
console.log(`[entry-labels] ledger sources checked: ${[...sources].sort().join(', ')}`);
console.log('');
