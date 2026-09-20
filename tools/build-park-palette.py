#!/usr/bin/env python
"""Assemble the Dino Park background studio's tile palette.

    python tools/build-park-palette.py

Two sources, one output:

  * Megapack sheets 1-5 are spliced here, through the same alpha-bounds
    splice as the prop sprites (imported from splice-megapack.py, not
    reimplemented).
  * The batchfolder packs arrive ALREADY spliced -- tile_splicer.py in that
    folder cut every sheet to exact non-transparent bounds with a manifest.
    Those crops are copied as they are; re-splicing work that was done
    right once is how two copies drift.

THE ZONE IS THE POINT OF THE MANIFEST. Every tile carries the walkability
zone it implies -- grass is land, ocean is ocean -- so a background painted
from these tiles produces its own mask, and an aquatic dino's boundaries
are correct on every background anyone ever makes, by construction rather
than by sampling after the fact.

Output: games/dino-park/assets/dino-assets/park-tiles/<set>/NN.png and
palette.json beside them. Gitignored with the rest of dino-assets: the
palette reaches the rig by copy, and this tool is what makes it
reproducible.
"""

import importlib.util
import io
import json
import os
import re
import shutil

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)

spec = importlib.util.spec_from_file_location(
    'sm', os.path.join(HERE, 'splice-megapack.py'))
sm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sm)

BATCH = r'C:\Users\jmweb\OneDrive\Documents\Itch-io-assets\tileset_sheets\batchfolder'
OUT = os.path.join(REPO, 'games', 'dino-park', 'assets', 'dino-assets', 'park-tiles')

# Grid cell the studio and the game draw at. Tiles are stored at native
# size and scaled at draw time -- same rule as every other sprite here.
CELL = 96

# (set id, display name, zone, source)
#   ('mega', sheet number)      spliced from the megapack now
#   ('batch', folder-name stem) copied from an already-spliced batch pack
SETS = [
    ('prehistoric', 'Prehistoric Ground', 'L', ('mega', 1)),
    ('jungle',      'Jungle Grass',       'L', ('mega', 2)),
    ('mud',         'Muddy Terrain',      'L', ('mega', 3)),
    ('volcanic',    'Volcanic Rock',      'L', ('mega', 4)),
    ('water',       'Water & Swamp',      'O', ('mega', 5)),
    ('moonlit',     'Moonlit Grass',      'L', ('batch', 'Moonlit Grass Tiles')),
    ('desert',      'Desert Sand',        'L', ('batch', 'Desert Sand Tiles')),
    ('deadforest',  'Dead Forest',        'L', ('batch', 'Dead Forest ground Tiles')),
    ('mushroom',    'Mushroom Forest',    'L', ('batch', 'Mushroom Forest Ground Tiles')),
    ('sandmix',     'Sand & Ground',      'L', ('batch', 'Sand and ground tiles')),
    ('stone',       'Mountain Stone',     'L', ('batch', 'Mountain Stone Floor Tiles')),
    ('cobble',      'Cobblestone',        'L', ('batch', 'Cobblestone Street Tiles')),
    ('marble',      'Atlantis Marble',    'L', ('batch', 'Atlantis Marble Floor Tiles')),
    # Unlocked by the 2026-09 re-splice -- these packs had empty _tiles
    # folders from an interrupted batch run.
    ('asphalt',     'Asphalt Road',       'L', ('batch', 'Asphalt Road Tiles')),
    ('neon',        'Neon Asphalt',       'L', ('batch', 'Neon asphalt road tiles')),
    ('crosswalk',   'Crosswalk',          'L', ('batch', '3. Crosswalk Tiles')),
    ('dragonscale', 'Dragon Scale',       'L', ('batch', 'Dragon scale floor tiles')),
    ('cloud',       'Cloud Floor',        'L', ('batch', 'Cloud Floor Tiles')),
    ('plainfloor',  'Stone Floor',        'L', ('batch', 'Floor tiles')),
]

# Ground tiles are big squares; anything smaller slipped in through the
# wide re-splice bounds (min-size 24 exists for props). A palette fragment
# would paint as a mostly-empty cell.
MIN_TILE = 60


def batch_dir(stem):
    """The already-spliced folder for a pack, by name stem.

    Exact match first (after stripping the "N. " prefix), because stems
    like "Floor tiles" are substrings of half the floor packs and only the
    plain one is meant.
    """
    def core(d):
        return re.sub(r'^\d+\.\s*', '', d[:-len('_tiles')]).lower()
    dirs = [d for d in os.listdir(BATCH) if d.endswith('_tiles')]
    # A stem may carry its "N. " prefix to split same-named packs apart.
    exact = [d for d in dirs
             if core(d) == stem.lower() or d[:-len('_tiles')].lower() == stem.lower()]
    if len(exact) == 1:
        return os.path.join(BATCH, exact[0])
    hits = [d for d in dirs if stem.lower() in d.lower()]
    if len(hits) != 1:
        raise SystemExit('batch pack "%s": %d matches %s' % (stem, len(hits), hits))
    return os.path.join(BATCH, hits[0])


def main():
    os.makedirs(OUT, exist_ok=True)
    palette = {'version': 1, 'cell': CELL, 'sets': []}

    for set_id, name, zone, (kind, ref) in SETS:
        outdir = os.path.join(OUT, set_id)
        os.makedirs(outdir, exist_ok=True)
        tiles = []

        if kind == 'mega':
            sheet = next(p for n, _, p in sm.sheet_files() if n == ref)
            for i, (_, crop) in enumerate(sm.splice(sheet)):
                fn = '%02d.png' % i
                crop.save(os.path.join(outdir, fn))
                tiles.append({'file': '%s/%s' % (set_id, fn),
                              'w': crop.width, 'h': crop.height})
        else:
            src = batch_dir(ref)
            man = json.load(io.open(os.path.join(src, 'manifest.json'),
                                    encoding='utf-8'))
            kept = [t for t in man['tiles']
                    if t['size'][0] >= MIN_TILE and t['size'][1] >= MIN_TILE]
            for i, t in enumerate(kept):
                fn = '%02d.png' % i
                shutil.copyfile(os.path.join(src, t['filename']),
                                os.path.join(outdir, fn))
                tiles.append({'file': '%s/%s' % (set_id, fn),
                              'w': t['size'][0], 'h': t['size'][1]})

        if not tiles:
            raise SystemExit('set "%s" produced no tiles' % set_id)
        palette['sets'].append({'id': set_id, 'name': name,
                                'zone': zone, 'tiles': tiles})
        print('%-12s %-20s zone %s  %2d tiles' % (set_id, name, zone, len(tiles)))

    with io.open(os.path.join(OUT, 'palette.json'), 'w', encoding='utf-8') as fh:
        json.dump(palette, fh, indent=1)
    total = sum(len(s['tiles']) for s in palette['sets'])
    print('palette.json written: %d sets, %d tiles' % (len(palette['sets']), total))


if __name__ == '__main__':
    main()
