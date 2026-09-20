#!/usr/bin/env python
"""Splice the Jurassic World Pixel Art Megapack sheets into individual sprites.

    python tools/splice-megapack.py            # every prop sheet
    python tools/splice-megapack.py --sheet 20 # one sheet, by its number
    python tools/splice-megapack.py --contact  # also render contact sheets

THE ONE RULE: crops are the sprite's own alpha bounding box, never a grid
cell. The pack is laid out irregularly and the assets are not square -- a
wall relief is wide, an obelisk is tall -- so any fixed-tile splice clips
somebody's pixels. Each sprite's bounds come from the pixels it actually
owns.

HOW GROUPING WORKS. Sprites are found as connected components of the alpha
mask, labelled after a small dilation so that detached fragments -- a torch
flame beside an arch, a leaf off a tree crown -- join the sprite they
belong to. The DILATED mask is only used for grouping; the saved bbox is
measured on the ORIGINAL pixels, so the dilation can never fatten a crop.

The title banner on every sheet is dropped by width: nothing in the pack
but the banner spans more than half the sheet.

Sheets 1-5 are terrain TILES (background material, square by design) and
21-22 are dinosaurs; both need different handling and are skipped here.
"""

import argparse
import io
import json
import os
import re
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PACK = os.path.join(
    REPO, 'games', 'dino-park', 'assets', 'dino-assets',
    'jurassic-tiles', 'Jurassic World Pixel Art Megapack')
OUT = os.path.join(
    REPO, 'games', 'dino-park', 'assets', 'dino-assets', 'megapack-sprites')

ALPHA_MIN = 8          # below this a pixel is background
LABEL_PX = 3           # tight dilation: only touching-ish pixels connect
SAT_GAP = 12           # a fragment within this of a host belongs to it
SAT_RATIO = 0.25       # ...but only if it is at most this fraction the size
SPECK_AREA = 40        # what is left unattached below this is noise
BANNER_FRAC = 0.55     # wider than this fraction of the sheet = the banner
PAD = 1                # transparent border on every crop

# Tile sheets and dinosaur sheets are deliberately not prop material.
SKIP_SHEETS = {1, 2, 3, 4, 5, 21, 22}


def sheet_files():
    for f in sorted(os.listdir(PACK)):
        m = re.match(r'(\d+)\. (.+)\.png$', f)
        if not m:
            continue
        num = int(m.group(1))
        slug = re.sub(r'[^a-z0-9]+', '-', m.group(2).lower()).strip('-')
        yield num, slug, os.path.join(PACK, f)


def _gap(a, b):
    """Empty distance between two bboxes; 0 when they touch or overlap."""
    dx = max(0, max(a[0], b[0]) - min(a[2], b[2]))
    dy = max(0, max(a[1], b[1]) - min(a[3], b[3]))
    return max(dx, dy)


def splice(path):
    """Yield (bbox, crop) for every sprite on a sheet, row-major.

    GROUPING IS BY SIZE ASYMMETRY, NOT DISTANCE ALONE. A single radius
    cannot work on this pack: the ember specks over a flame sit 2-8px from
    their torch, and two separate nests sit 10-20px from each other -- the
    ranges overlap, and the first cut of this tool glued three nests into
    one 553px crop while a wider radius was needed for the embers at all.

    So components are labelled TIGHT, and then satellites are folded into
    hosts: a fragment merges into a neighbour only when it is nearby AND at
    most SAT_RATIO of its size. Peers -- two nests, a torch above a brazier
    in the same column -- are never merged, whatever the distance.
    """
    im = Image.open(path).convert('RGBA')
    a = np.asarray(im)[:, :, 3]
    mask = a > ALPHA_MIN

    labels, n = ndimage.label(ndimage.binary_dilation(mask, iterations=LABEL_PX))

    comps = []
    for i in range(1, n + 1):
        # Bounds of the REAL pixels inside this group, not the dilated blob.
        own = mask & (labels == i)
        area = int(own.sum())
        if area == 0:
            continue
        ys, xs = np.where(own)
        comps.append({'bbox': [int(xs.min()), int(ys.min()),
                               int(xs.max()) + 1, int(ys.max()) + 1],
                      'area': area})

    # Fold satellites into hosts until nothing moves. Specks are kept
    # alive through this: an ember dropped early is an ember that never
    # rejoins its torch, and the crop is clipped exactly the way this tool
    # exists to avoid.
    changed = True
    while changed:
        changed = False
        comps.sort(key=lambda c: -c['area'])
        for host in comps:
            for sat in comps:
                if sat is host or sat['area'] > host['area'] * SAT_RATIO:
                    continue
                if _gap(host['bbox'], sat['bbox']) > SAT_GAP:
                    continue
                host['bbox'] = [min(host['bbox'][0], sat['bbox'][0]),
                                min(host['bbox'][1], sat['bbox'][1]),
                                max(host['bbox'][2], sat['bbox'][2]),
                                max(host['bbox'][3], sat['bbox'][3])]
                host['area'] += sat['area']
                comps.remove(sat)
                changed = True
                break
            if changed:
                break

    sprites = []
    for c in comps:
        x0, y0, x1, y1 = c['bbox']
        if c['area'] < SPECK_AREA:
            continue                      # noise that attached to nothing
        if (x1 - x0) > im.width * BANNER_FRAC:
            continue                      # the title banner
        sprites.append((x0, y0, x1, y1))

    # Row-major order: band rows by vertical overlap, then sort by x.
    sprites.sort(key=lambda b: b[1])
    rows = []
    for b in sprites:
        for row in rows:
            if b[1] < row['bottom']:      # overlaps this band vertically
                row['boxes'].append(b)
                row['bottom'] = max(row['bottom'], b[3])
                break
        else:
            rows.append({'bottom': b[3], 'boxes': [b]})

    out = []
    for row in rows:
        for (x0, y0, x1, y1) in sorted(row['boxes'], key=lambda b: b[0]):
            crop = Image.new('RGBA', (x1 - x0 + 2 * PAD, y1 - y0 + 2 * PAD))
            crop.paste(im.crop((x0, y0, x1, y1)), (PAD, PAD))
            out.append(((x0, y0, x1, y1), crop))
    return out


def contact_sheet(slug, entries):
    """Numbered strip of every crop, for picking and naming by eye."""
    cell_h = max(c.height for _, c in entries) + 26
    cell_ws = [max(c.width, 40) + 12 for _, c in entries]
    sheet = Image.new('RGBA', (sum(cell_ws), cell_h), (17, 17, 17, 255))
    from PIL import ImageDraw
    draw = ImageDraw.Draw(sheet)
    x = 0
    for i, ((f, crop), w) in enumerate(zip(entries, cell_ws)):
        sheet.paste(crop, (x + (w - crop.width) // 2, 22), crop)
        draw.text((x + 4, 4), '%02d' % i, fill=(255, 255, 255, 255))
        x += w
    sheet.save(os.path.join(OUT, '_contact-%s.png' % slug))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--sheet', type=int, default=None)
    ap.add_argument('--contact', action='store_true')
    args = ap.parse_args()

    manifest = {}
    for num, slug, path in sheet_files():
        if num in SKIP_SHEETS:
            continue
        if args.sheet is not None and num != args.sheet:
            continue

        entries = []
        outdir = os.path.join(OUT, slug)
        os.makedirs(outdir, exist_ok=True)
        for i, (bbox, crop) in enumerate(splice(path)):
            name = '%02d.png' % i
            crop.save(os.path.join(outdir, name))
            entries.append((name, crop))
            manifest.setdefault(slug, []).append({
                'file': '%s/%s' % (slug, name),
                'bbox': [int(v) for v in bbox],
                'w': crop.width, 'h': crop.height,
            })
        if args.contact and entries:
            contact_sheet(slug, entries)

        sizes = ['%dx%d' % (c.width, c.height) for _, c in entries]
        print('%2d %-38s %2d sprites  (%s%s)' % (
            num, slug, len(entries),
            ', '.join(sizes[:4]), ', ...' if len(sizes) > 4 else ''))

    if manifest:
        mpath = os.path.join(OUT, 'manifest.json')
        old = {}
        if os.path.exists(mpath):
            old = json.load(io.open(mpath, encoding='utf-8'))
        old.update(manifest)
        with io.open(mpath, 'w', encoding='utf-8') as fh:
            json.dump(old, fh, indent=1)


if __name__ == '__main__':
    main()
