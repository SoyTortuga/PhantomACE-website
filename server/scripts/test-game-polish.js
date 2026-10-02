#!/usr/bin/env node
/* ══════════════════════════════════════════════
   GAME POLISH — small quality guards for PhamShock and Memory Match

     node server/scripts/test-game-polish.js

   These are the easy-to-regress affordances a "quick win" pass added:

     PhamShock   hotkeys for all ten weapons (1–9 then 0), submit errors
                 surfaced to the player instead of swallowed, and a mobile
                 layout so the control strip is thumb-usable.
     Memory Match  cards operable from the keyboard (focusable, Enter/Space),
                 which a plain <div onclick> is not.

   Asserted against the source so a later rewrite that drops one of them fails
   here rather than silently shipping a game you can't play with a keyboard or
   on a phone.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const game = (p) => fs.readFileSync(path.join(REPO, 'games', p), 'utf8');

let passed = 0;
const failures = [];
const ok = (label, cond) => { if (cond) passed++; else failures.push(label); };

/* ── PhamShock ────────────────────────────────────────────────────────── */
{
  const src = game('phamshock/index.html');

  /* All ten weapons are selectable by key: a digit handler that maps 1–9 to
     indices 0–8 and 0 to index 9 (the tenth). This is what covers 6–10. */
  ok('phamshock: a digit key selects a weapon',
     /if\s*\(\s*\/\^\[0-9\]\$\/\.test\(e\.key\)\s*\)/.test(src));
  ok('phamshock: key 0 maps to the tenth weapon (index 9)',
     /e\.key\s*===\s*['"]0['"]\s*\?\s*9/.test(src));
  /* Discoverable: the selecting key is printed on each weapon button, or
     nobody knows 6–10 exist. */
  ok('phamshock: each weapon button shows its hotkey',
     /class="wkey"/.test(src) && /i\s*===\s*9\s*\?\s*['"]0['"]\s*:\s*String\(i\s*\+\s*1\)/.test(src));

  /* A rejected submit must tell the player why, not fail in silence. */
  ok('phamshock: submit has a player-facing error map',
     /const\s+FIRE_ERRORS\s*=/.test(src));
  ok('phamshock: submitTurn surfaces the error via showNotice',
     /data\.error[\s\S]{0,200}showNotice\(/.test(src));
  ok('phamshock: showNotice renders into the on-canvas notice element',
     /function\s+showNotice\s*\(/.test(src) && /id="gameNotice"/.test(src));

  /* Mobile layout: a media query that reflows the control strip. */
  ok('phamshock: a mobile media query exists',
     /@media\s*\(\s*max-width:\s*640px\s*\)/.test(src));
  ok('phamshock: on mobile the aim sliders stretch to a real tap target',
     /input\[type=range\]\s*\{\s*flex:\s*1/.test(src));
  ok('phamshock: on mobile FIRE spans its own row',
     /#fireBtn\s*\{[^}]*flex:\s*1 1 100%/.test(src));

  /* Design identity: no box-shadow, no decorative left/right accent rails. */
  ok('phamshock: no box-shadow anywhere', !/box-shadow/i.test(src));
  ok('phamshock: no decorative border-left/right colour rail',
     !/border-(left|right):\s*\d+px/i.test(src));
}

/* ── Memory Match ─────────────────────────────────────────────────────── */
{
  const src = game('memory-match/index.html');

  ok('memory-match: cards are focusable',
     /card\.tabIndex\s*=\s*0/.test(src));
  ok('memory-match: cards expose a button role',
     /setAttribute\(\s*['"]role['"]\s*,\s*['"]button['"]\s*\)/.test(src));
  ok('memory-match: cards flip on Enter/Space from the keyboard',
     /addEventListener\(\s*['"]keydown['"][\s\S]{0,160}flipCard\(card\)/.test(src));
  ok('memory-match: Space is prevented from scrolling the board',
     /e\.preventDefault\(\)/.test(src));
  ok('memory-match: a visible keyboard focus ring (outline, not a shadow)',
     /\.card:focus-visible\s*\{[^}]*outline:/.test(src));

  /* Palette: surfaces/text from tokens, not off-palette hard hexes. The
     sanctioned cosmetic card-back gradients are the only literal colours. */
  ok('memory-match: status/win colours use tokens',
     /color:\s*var\(--text-sec\)/.test(src) && /color:\s*var\(--red\)/.test(src));

  ok('memory-match: no box-shadow anywhere', !/box-shadow/i.test(src));
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[game-polish] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[game-polish] ${passed} assertions passed.`);
console.log('');
