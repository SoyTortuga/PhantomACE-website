"""Build the My Room atlas from the Gaming Room Interiors MegaPack.

    python tools/build-room-atlas.py            # writes pieces + catalog + review sheets
    python tools/build-room-atlas.py --dry-run  # counts only, writes nothing

Reads the 20 source sheets (never committed: they are the pack as bought),
cuts every piece out as a connected blob of non-transparent pixels, trims it
to its box, and writes:

    assets/room/pieces/<category>/<id>.png    one file per piece
    assets/room/catalog.json                  id, pack, category, layer, tier, w, h
    <scratch>/room-review/<category>.png      a labelled contact sheet per category

The contact sheets are for a HUMAN to look at before the catalog is trusted.
A merged blob (two things cut as one) or a split piece (one thing cut as
two) is obvious to an eye and invisible to any test. Three sheets are known
to need it — LED strips, snacks and posters have pieces that touch — and
carry overrides below.

IDS ARE POSITIONAL, NOT SEQUENTIAL. A piece is named by its category and
its row/column on the source sheet, so a rebuild that finds one extra blob
does not renumber every piece people have already placed in their rooms.

Floor tiles are forced to exactly 128x128: the cell IS the tile, and a tile
that came out 127 wide because of a soft edge would leave a seam.
"""
import io
import json
import os
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy import ndimage

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

REPO = Path(__file__).resolve().parent.parent
PACK_ROOT = Path(r'C:/Users/jmweb/OneDrive/Documents/Itch-io-assets/newfolder')
OUT_PIECES = REPO / 'assets' / 'room' / 'pieces'
OUT_CATALOG = REPO / 'assets' / 'room' / 'catalog.json'
REVIEW = Path(os.environ.get('ROOM_REVIEW_DIR', REPO.parent / 'room-review'))

PACK = 'gaming-room'
BANNER_MIN_W = 900      # the title banner is the only blob this wide...
BANNER_TOP = 150        # ...that starts this near the top of the sheet
ALPHA_MIN = 16          # below this a pixel is halo, not piece
MIN_PIECE = 24          # blobs smaller than this on either axis are noise (smallest real piece is 32)
CELL = 128

# sheet number -> (category slug, layer, tier, surface, overrides)
#   surface: 'room' for pieces drawn top-down, 'desk' for the ones drawn
#            front-on (a keyboard on a top-down floor looks fallen over),
#            'both' for the few that read either way. See ROOM-PLAN §3a.
#   dilate:  px of growth before labelling, so a chair's legs join its seat.
#            Lower it where separate pieces sit close together.
#   alpha:   a higher threshold separates pieces joined only by a glow.
SHEETS = {
    1:  ('floor',         'floor', 'basic',  'room', {}),
    2:  ('wall',          'wall',  'basic',  'room', {}),
    3:  ('desks',         'prop',  'basic',  'room', {}),
    4:  ('pc-towers',     'prop',  'unlock', 'desk', {}),
    5:  ('keyboards',     'prop',  'unlock', 'desk', {}),
    6:  ('chairs',        'prop',  'basic',  'room', {}),
    7:  ('monitors',      'prop',  'unlock', 'desk', {}),
    # The two long rows are nine coloured strips drawn touching end to end;
    # there is no gap to find, so a blob that wide is cut into nine.
    8:  ('led-strips',    'prop',  'unlock', 'both', {'dilate': 1, 'alpha': 48, 'split_wide': (600, 9)}),
    9:  ('streaming',     'prop',  'unlock', 'desk', {}),
    # Two corner shelves are drawn stacked and touching; cut the tall one in two.
    10: ('shelves',       'prop',  'basic',  'room', {'split_tall': (280, 2)}),
    11: ('neon',          'prop',  'unlock', 'both', {}),
    12: ('sofas',         'prop',  'basic',  'room', {}),
    13: ('snacks',        'prop',  'unlock', 'desk', {'dilate': 1, 'alpha': 48}),
    14: ('consoles',      'prop',  'unlock', 'desk', {}),
    15: ('posters',       'prop',  'unlock', 'both', {'dilate': 1, 'alpha': 48}),
    16: ('rugs',          'rug',   'basic',  'room', {}),
    17: ('plants',        'prop',  'basic',  'both', {}),
    18: ('smart',         'prop',  'unlock', 'desk', {}),
    19: ('studio-lights', 'prop',  'unlock', 'room', {}),
    20: ('decor',         'prop',  'basic',  'both', {}),
}
DEFAULT_DILATE = 5


def source_sheets():
    root = next(p for p in PACK_ROOT.iterdir() if p.name.startswith('Gaming Room'))
    inner = next(p for p in root.iterdir() if p.is_dir())
    out = {}
    for p in inner.glob('*.png'):
        n = int(p.name.split('.')[0])
        out[n] = p
    return out


def find_pieces(img, dilate, alpha_min):
    """Bounding boxes (x0, y0, x1, y1) of every blob that is not the banner.

    The banner is found, not assumed: it is the one component wider than
    BANNER_MIN_W whose top is inside the top BANNER_TOP px. A fixed cut-off
    line was tried first and sliced through the first row of the snacks
    sheet, which sits closer under its banner than the others."""
    a = np.array(img)[:, :, 3]
    mask = a >= alpha_min
    grown = ndimage.binary_dilation(mask, iterations=dilate) if dilate else mask
    labels, n = ndimage.label(grown)
    objects = ndimage.find_objects(labels)
    # The banner's bottom edge: its sparkles and dots sit beside it as
    # separate blobs and must go with it, not become pieces.
    banner_bottom = 0
    for sl in objects:
        y0, y1, x0, x1 = sl[0].start, sl[0].stop, sl[1].start, sl[1].stop
        if x1 - x0 > BANNER_MIN_W and y0 < BANNER_TOP:
            banner_bottom = max(banner_bottom, y1)
    boxes = []
    for sl in objects:
        y0, y1, x0, x1 = sl[0].start, sl[0].stop, sl[1].start, sl[1].stop
        if y1 <= banner_bottom:
            continue                                     # the banner and its trimmings
        # trim the box back to real pixels (the dilation grew it)
        sub = mask[y0:y1, x0:x1]
        if not sub.any():
            continue
        ys, xs = np.where(sub)
        bx0, bx1 = x0 + xs.min(), x0 + xs.max() + 1
        by0, by1 = y0 + ys.min(), y0 + ys.max() + 1
        if bx1 - bx0 < MIN_PIECE or by1 - by0 < MIN_PIECE:
            continue
        boxes.append((bx0, by0, bx1, by1))
    return boxes


def split_wide(img, boxes, min_w, n, alpha_min):
    """Cut any box wider than min_w into n equal slices, each trimmed back
    to its own pixels. For rows of pieces drawn touching end to end."""
    a = np.array(img)[:, :, 3]
    out = []
    for (x0, y0, x1, y1) in boxes:
        if x1 - x0 < min_w:
            out.append((x0, y0, x1, y1))
            continue
        step = (x1 - x0) / n
        for i in range(n):
            sx0, sx1 = int(round(x0 + i * step)), int(round(x0 + (i + 1) * step))
            sub = a[y0:y1, sx0:sx1] >= alpha_min
            if not sub.any():
                continue
            ys, xs = np.where(sub)
            out.append((sx0 + xs.min(), y0 + ys.min(), sx0 + xs.max() + 1, y0 + ys.max() + 1))
    return out


def split_tall(img, boxes, min_h, n, alpha_min):
    """The vertical twin of split_wide: cut any box taller than min_h into
    n equal slices, each trimmed back to its own pixels."""
    a = np.array(img)[:, :, 3]
    out = []
    for (x0, y0, x1, y1) in boxes:
        if y1 - y0 < min_h:
            out.append((x0, y0, x1, y1))
            continue
        step = (y1 - y0) / n
        for i in range(n):
            sy0, sy1 = int(round(y0 + i * step)), int(round(y0 + (i + 1) * step))
            sub = a[sy0:sy1, x0:x1] >= alpha_min
            if not sub.any():
                continue
            ys, xs = np.where(sub)
            out.append((x0 + xs.min(), sy0 + ys.min(), x0 + xs.max() + 1, sy0 + ys.max() + 1))
    return out


def assign_rows(boxes):
    """Group boxes into rows by vertical centre, then order left to right.
    Returns [(row, col, box)]. Rows are what make ids positional."""
    items = sorted(boxes, key=lambda b: ((b[1] + b[3]) / 2, b[0]))
    rows = []
    for b in items:
        cy = (b[1] + b[3]) / 2
        h = b[3] - b[1]
        for row in rows:
            rcy = sum((x[1] + x[3]) / 2 for x in row) / len(row)
            rh = sum(x[3] - x[1] for x in row) / len(row)
            if abs(cy - rcy) < max(h, rh) * 0.5:
                row.append(b)
                break
        else:
            rows.append([b])
    rows.sort(key=lambda r: sum((x[1] + x[3]) / 2 for x in r) / len(r))
    out = []
    for ri, row in enumerate(rows):
        for ci, b in enumerate(sorted(row, key=lambda x: x[0])):
            out.append((ri + 1, ci + 1, b))
    return out


def square_tile(piece):
    """Floor tiles become exactly CELL x CELL by CENTRE CROP, never resampled.

    The source tiles are painted ~133 px with a 3-4 px anti-aliased fade at
    the edge and a dark outline just inside it; the hard core varies from
    tile to tile. Cropping the middle 128 drops the fade (which would show
    as a seam between cells) and keeps every pixel that remains untouched.
    A tile that is not big enough to crop is a sheet this script does not
    understand, and says so."""
    w, h = piece.size
    if w < CELL or h < CELL or w > CELL + 24 or h > CELL + 24:
        raise SystemExit(f'floor tile is {w}x{h}, not within crop range of {CELL}: the sheet is not what this script expects')
    x0, y0 = (w - CELL) // 2, (h - CELL) // 2
    return piece.crop((x0, y0, x0 + CELL, y0 + CELL))


WALL_H = 176


def wall_tile(piece):
    """Wall faces become exactly CELL wide by WALL_H tall, centre-cropped.
    They are repeating textures ~160x181 with the same soft fringe as the
    floor; one per edge cell means one cell wide, and a common height is
    what lets the wall band be one straight line."""
    w, h = piece.size
    if w < CELL or h < WALL_H or w > CELL + 48 or h > WALL_H + 24:
        raise SystemExit(f'wall tile is {w}x{h}, not within crop range of {CELL}x{WALL_H}: the sheet is not what this script expects')
    x0, y0 = (w - CELL) // 2, (h - WALL_H) // 2
    return piece.crop((x0, y0, x0 + CELL, y0 + WALL_H))


def contact_sheet(category, entries, images):
    """Every piece with its id under it, for review."""
    cols = 8
    cell_w = max(max(i.width for i in images) + 16, 120)
    cell_h = max(i.height for i in images) + 34
    rows = (len(images) + cols - 1) // cols
    sheet = Image.new('RGBA', (cols * cell_w, rows * cell_h + 30), (24, 24, 24, 255))
    d = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.truetype('arial.ttf', 13)
    except Exception:
        font = ImageFont.load_default()
    d.text((8, 8), f'{category}  ({len(images)} pieces)', fill=(255, 80, 80, 255), font=font)
    for i, (e, im) in enumerate(zip(entries, images)):
        cx, cy = (i % cols) * cell_w, 30 + (i // cols) * cell_h
        sheet.alpha_composite(im, (cx + (cell_w - im.width) // 2, cy + 4))
        d.text((cx + 6, cy + cell_h - 22), e['id'], fill=(220, 220, 220, 255), font=font)
    return sheet


def main():
    dry = '--dry-run' in sys.argv
    sheets = source_sheets()
    catalog = []
    counts = {}
    if not dry:
        OUT_PIECES.mkdir(parents=True, exist_ok=True)
        REVIEW.mkdir(parents=True, exist_ok=True)

    for n in sorted(SHEETS):
        category, layer, tier, surface, ov = SHEETS[n]
        img = Image.open(sheets[n]).convert('RGBA')
        boxes = find_pieces(img, ov.get('dilate', DEFAULT_DILATE), ov.get('alpha', ALPHA_MIN))
        if 'split_wide' in ov:
            boxes = split_wide(img, boxes, *ov['split_wide'], ov.get('alpha', ALPHA_MIN))
        if 'split_tall' in ov:
            boxes = split_tall(img, boxes, *ov['split_tall'], ov.get('alpha', ALPHA_MIN))
        placed = assign_rows(boxes)
        entries, images = [], []
        for row, col, (x0, y0, x1, y1) in placed:
            piece = img.crop((x0, y0, x1, y1))
            if layer == 'floor':
                piece = square_tile(piece)
            elif layer == 'wall':
                piece = wall_tile(piece)
            pid = f'{category}-r{row}c{col}'
            entry = {'id': pid, 'pack': PACK, 'category': category, 'layer': layer,
                     'tier': tier, 'surface': surface, 'w': piece.width, 'h': piece.height}
            entries.append(entry)
            images.append(piece)
            if not dry:
                d = OUT_PIECES / category
                d.mkdir(parents=True, exist_ok=True)
                piece.save(d / f'{pid}.png', optimize=True)
        catalog.extend(entries)
        counts[category] = len(entries)
        ws = sorted(e['w'] for e in entries)
        hs = sorted(e['h'] for e in entries)
        print(f'{n:2d}. {category:14s} {len(entries):3d} pieces   w {ws[0]}-{ws[-1]}   h {hs[0]}-{hs[-1]}')
        if not dry:
            contact_sheet(category, entries, images).convert('RGB').save(REVIEW / f'{category}.png')

    if not dry:
        OUT_CATALOG.parent.mkdir(parents=True, exist_ok=True)
        OUT_CATALOG.write_text(json.dumps({
            'v': 1, 'cell': CELL, 'packs': {PACK: 'Gaming Room Interiors MegaPack'},
            'categories': {c: {'layer': layer, 'tier': tier, 'surface': surface}
                           for (c, layer, tier, surface, _ov) in SHEETS.values()},
            'pieces': catalog,
        }, indent=1) + '\n', encoding='utf-8')
        total_kb = sum(p.stat().st_size for p in OUT_PIECES.rglob('*.png')) // 1024
        print(f'\n{len(catalog)} pieces, {total_kb} KB on disk. Review sheets in {REVIEW}')
    else:
        print(f'\n{len(catalog)} pieces (dry run, nothing written)')


if __name__ == '__main__':
    main()
