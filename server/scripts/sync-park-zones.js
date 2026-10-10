#!/usr/bin/env node
/* ══════════════════════════════════════════════
   REGENERATE THE PARK ZONE MANIFEST

     node server/scripts/sync-park-zones.js            report
     node server/scripts/sync-park-zones.js --write    rewrite it

   park-tiles/palette.json is the real table of which tile set is land,
   water, both or impassable. It ships inside the purchased pack-art tree,
   so it is gitignored and reaches the rig by manual copy — which meant
   test-park-zones could only compare the server's mirror against it on a
   machine that happened to have the art. On a fresh clone, in CI, or on
   the rig straight after a pull, the comparison silently did not run, and
   the mirror this guards is the one the server REFUSES backgrounds with.

   So the zone metadata — set ids, zone, kind, and nothing else — is
   extracted here into a file small enough to commit. No artwork, no tile
   lists, no filenames from the pack: only the walkability flags this
   project chose for sets it named.

   Run this after adding a tile set. test-park-zones fails if the manifest
   and the real palette disagree on a machine that has both, so a stale
   manifest is caught rather than trusted.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const PALETTE = path.join(REPO, 'games/dino-park/assets/dino-assets/park-tiles/palette.json');
export const MANIFEST = path.join(REPO, 'server/data/park-zone-manifest.json');

const COMMENT = [
  'Zone metadata for the park tile sets: which sets are land (L), water (O),',
  'both (R) or impassable (X), and how the background studio groups them.',
  '',
  'Derived from park-tiles/palette.json, which is gitignored because it ships',
  'with purchased pack art. This holds NO art and no filenames — only the set',
  'ids and the walkability flags this project chose.',
  '',
  'It exists so test-park-zones can check the server mirror on EVERY machine,',
  'not only one that has had 1,294 PNGs copied to it. Regenerate after adding',
  'a tile set: node server/scripts/sync-park-zones.js --write',
];

/** The manifest the palette implies, as an object. */
export function buildManifest(palette) {
  const sets = {};
  for (const s of [...palette.sets].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    sets[s.id] = { zone: s.zone, kind: s.kind || 'ground' };
  }
  return { _comment: COMMENT, sets };
}

/** The committed manifest, or null if it is not there. */
export function readManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch { return null; }
}

/** The real palette, or null on a machine without the pack art. */
export function readPalette() {
  try { return JSON.parse(fs.readFileSync(PALETTE, 'utf8')); } catch { return null; }
}

/* Run directly, not when imported by the test. */
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const palette = readPalette();
  if (!palette) {
    console.error('palette.json is not on this machine — it is gitignored pack art.');
    console.error('Copy the park-tiles tree across before regenerating the manifest.');
    process.exit(1);
  }

  const built = buildManifest(palette);
  const current = readManifest();
  const same = current && JSON.stringify(current.sets) === JSON.stringify(built.sets);

  if (same) {
    console.log(`[sync-park-zones] up to date — ${Object.keys(built.sets).length} sets.`);
    process.exit(0);
  }

  const added = current ? Object.keys(built.sets).filter(id => !(id in current.sets)) : Object.keys(built.sets);
  const gone = current ? Object.keys(current.sets).filter(id => !(id in built.sets)) : [];
  const changed = current
    ? Object.keys(built.sets).filter(id => current.sets[id] &&
        JSON.stringify(current.sets[id]) !== JSON.stringify(built.sets[id]))
    : [];

  if (added.length) console.log('  added:   ' + added.join(', '));
  if (gone.length) console.log('  removed: ' + gone.join(', '));
  if (changed.length) console.log('  changed: ' + changed.join(', '));

  if (!process.argv.includes('--write')) {
    console.log('');
    console.log('Dry run. Re-run with --write to update the manifest.');
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(MANIFEST), { recursive: true });
  fs.writeFileSync(MANIFEST, JSON.stringify(built, null, 2) + '\n');
  console.log(`[sync-park-zones] wrote ${Object.keys(built.sets).length} sets.`);
}
