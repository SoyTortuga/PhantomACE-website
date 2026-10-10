/* ══════════════════════════════════════════════
   PALETTE ZONES — the server's copy

   What each tile set means for walkability, so the server can check a
   submitted mask instead of trusting it. L is land, O is water, R is
   either, X is nothing — the same four the game's zoneAt() reads.

   WHY A MIRROR. The real table is park-tiles/palette.json, which lives in
   the gitignored pack-art tree and reaches the rig by manual copy — the
   server cannot import it and must not depend on a file that may be a
   copy behind. Same reason dino-species.js mirrors the client roster.

   KEEP IT IN STEP. A set that is missing here is treated as unknown and
   its cells must be X; a member painting with it would be told their mask
   is wrong for no reason they can see. Regenerate when palette.json gains
   sets — server/scripts/test-park-zones.js checks the two agree whenever
   the palette is present on the machine running it.

   Library, no handler — listed in NON_ROUTE_MODULES in server/router.js.
   ══════════════════════════════════════════════ */

/** set id -> 'L' | 'O' | 'R' | 'X' */
export const SET_ZONE = {
  deciron:     'X',
  deckelp:     'X',
  decoreef:    'X',
  decrock:     'X',
  decruins:    'X',
  fenceiron:   'X',
  fencewire:   'X',
  fencewood:   'X',
  asphalt:     'L',
  cloud:       'L',
  cobble:      'L',
  crosswalk:   'L',
  deadforest:  'L',
  desert:      'L',
  dock:        'L',
  dragonscale: 'L',
  jungle:      'L',
  marble:      'L',
  metal:       'L',
  moonlit:     'L',
  mud:         'L',
  mushroom:    'L',
  neon:        'L',
  plainfloor:  'L',
  prehistoric: 'L',
  rust:        'L',
  sandmix:     'L',
  snow:        'L',
  snowpath:    'L',
  stone:       'L',
  tower:       'L',
  volcanic:    'L',
  oceanfloor:  'O',
  water:       'O',
};

/** set id -> which picker category it belongs to. */
export const SET_KIND = {
  deciron:     'decoration',
  deckelp:     'decoration',
  decoreef:    'decoration',
  decrock:     'decoration',
  decruins:    'decoration',
  fenceiron:   'fence',
  fencewire:   'fence',
  fencewood:   'fence',
  asphalt:     'ground',
  cloud:       'ground',
  cobble:      'ground',
  crosswalk:   'ground',
  deadforest:  'ground',
  desert:      'ground',
  dock:        'ground',
  dragonscale: 'ground',
  jungle:      'ground',
  marble:      'ground',
  metal:       'ground',
  moonlit:     'ground',
  mud:         'ground',
  mushroom:    'ground',
  neon:        'ground',
  plainfloor:  'ground',
  prehistoric: 'ground',
  rust:        'ground',
  sandmix:     'ground',
  snow:        'ground',
  snowpath:    'ground',
  stone:       'ground',
  tower:       'ground',
  volcanic:    'ground',
  oceanfloor:  'water',
  water:       'water',
};

/** The zone a painted ref implies. Unknown sets are impassable. */
export function zoneOfRef(ref) {
  if (typeof ref !== 'string') return 'X';
  const set = ref.split('/')[0];
  return SET_ZONE[set] || 'X';
}

/** True when the set is one of the overlay kinds (fences, decorations). */
export function isOverlaySet(setId) {
  const k = SET_KIND[setId];
  return k === 'fence' || k === 'decoration';
}
