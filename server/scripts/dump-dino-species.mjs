#!/usr/bin/env node
/* ══════════════════════════════════════════════
   Regenerate the SPECIES table in functions/api/dino-species.js from the
   client roster, so the two never drift by hand-transcription.

     node server/scripts/dump-dino-species.mjs

   Parses ROSTER (id, name, rarity) and ASSET_MAP (icon path) straight out of
   games/dino-park/index.html's inline <script> and prints SPECIES entry lines
   grouped by rarity. Paste the output over the SPECIES block in dino-species.js
   when the client roster changes. Read-only — it writes nothing.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const html = fs.readFileSync(path.join(root, 'games/dino-park/index.html'), 'utf8');

const BS = String.fromCharCode(92);   // avoid a literal backslash in source
/* SITE-ABSOLUTE. The client's AB is 'assets/dino-assets/' RELATIVE to
   games/dino-park/index.html, so the served path is under /games/dino-park/. */
const AB = '/games/dino-park/assets/dino-assets/';
const IC = AB + 'jurassic-dino-320/icons/';
const EX = AB + 'jurassic-dino-320-expansion160/icons/';
const BP = AB + 'AncientBeastsPack/';
const PT = '/assets/portraits/';

/* Grab a balanced [...] or {...} literal following a `const NAME =`, tracking
   string state so a bracket inside a quoted path or description is ignored. */
function grab(startRe) {
  const m = html.match(startRe);
  if (!m) throw new Error('not found: ' + startRe);
  let i = m.index + m[0].length - 1;
  const open = html[i];
  const close = open === '[' ? ']' : '}';
  let depth = 0, inStr = false, q = '';
  for (let j = i; j < html.length; j++) {
    const c = html[j];
    if (inStr) { if (c === q && html[j - 1] !== BS) inStr = false; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = true; q = c; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return html.slice(i, j + 1); }
  }
  throw new Error('unbalanced literal for ' + startRe);
}

/* eslint-disable no-eval */
const ROSTER = eval('(' + grab(/const ROSTER\s*=\s*\[/) + ')');
const ASSET_MAP = eval('(' + grab(/const ASSET_MAP\s*=\s*\{/) + ')');

const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
const by = {};
const missing = [];
for (const r of ROSTER) {
  const a = ASSET_MAP[r.id] || {};
  if (!a.icon) missing.push(r.id);
  (by[r.rarity] = by[r.rarity] || []).push([r.id, r.name, a.icon || '']);
}

let out = '';
for (const rarity of RARITIES) {
  out += `  /* ${rarity} */\n`;
  for (const [id, name, icon] of (by[rarity] || [])) {
    out += `  ${id.padEnd(11)}: { name: ${JSON.stringify(name)}, rarity: ${JSON.stringify(rarity)}, icon: ${JSON.stringify(icon)} },\n`;
  }
}

process.stdout.write(out);
if (missing.length) {
  console.error('\nWARNING — species with no icon in ASSET_MAP: ' + missing.join(', '));
}
console.error(`\n${ROSTER.length} species: ` + RARITIES.map(r => `${r} ${(by[r] || []).length}`).join(' · '));
