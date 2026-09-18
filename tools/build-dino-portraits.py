# -*- coding: utf-8 -*-
"""Rebuild the Dino Park portraits from the pack's ORIGINAL artwork.

    python tools/build-dino-portraits.py            # report only
    python tools/build-dino-portraits.py --write    # write the folder + patch the game
    python tools/build-dino-portraits.py --write --raw-colours  # skip the palette transfer

WHY THIS EXISTS. The game served 72x72 portraits, and the source pack turns
out to ship the same art at 150-310px per side -- the 72s are downscales
that threw away roughly ninety percent of the pixels. Rendering them at
96px (a 1.33x nearest-neighbour stretch) is what made the Dinodex look sad.

WHERE THE BIG ART LIVES. Roughly a third of the species have an individual
high-res PNG named after them. The rest sit inside three 1536x1024 batch
sheets with no names at all. But the 72s were MADE from this art, so each
sheet sprite can be identified by downscaling it and finding which 72x72
portrait it best resembles: the match is not a guess about what a dinosaur
looks like, it is a search for the downscale we already have.

THE OUTPUT IS TRACKED. Portraits land in games/dino-park/assets/portraits/,
deliberately OUTSIDE the gitignored dino-assets tree, so they reach the rig
with git pull instead of a hand copy. Species with no recoverable large art
keep their 72x72 file, copied in under its -72x72 name -- the suffix is the
contract portraitImg() uses to decide pixelated-vs-smooth rendering.

The art itself is never resampled: sheet sprites are cropped and padded to
a square, individuals are padded to a square, and that is all. The browser
does the final scaling, from above the display size, where scaling is
harmless.
"""
import io
import os
import struct
import sys

if __name__ == "__main__":
    # Only when run as a tool: an importer (the matching sanity checks live
    # in scratch scripts) must not have its stdout re-wrapped from a module
    # import, which closes the wrapper when the module is collected.
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
from PIL import Image

HOME = os.path.expanduser("~")
SRC = os.path.join(HOME, "OneDrive", "Documents", "Itch-io-assets", "dino-assets", "AncientBeastsPack")
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVED = os.path.join(REPO, "games", "dino-park", "assets", "dino-assets", "AncientBeastsPack")
OUT = os.path.join(REPO, "games", "dino-park", "assets", "portraits")

SHEETS = ["CommonDinoBatch.png", "UncommonDinoBatch.png", "moredinos.png"]

# A LABELLED SHEET, and the best source in the pack. It sits one directory
# up from the rest -- in dino-assets/ rather than AncientBeastsPack/ --
# which is why nothing found it until it was pointed out.
#
# Every tile carries the species name as a caption, so identity is READ,
# not inferred: no silhouette matching, no confidence margin, no chance of
# shipping one dinosaur under another's name. It also covers exactly the
# gap -- all seven species the palette gate had rejected, plus twelve more
# that had no large art at all.
#
# IT IS NEW ART, NOT THE MISSING ORIGINALS. Silhouette distance to the
# matching 72 runs 5800-19300 where a true same-drawing pair measures
# 22-2400: different poses, different drawings of the same animals. That
# is a redesign rather than a recovery, and it is why these go through the
# hue gate below instead of the correspondence-based palette check, which
# measures pose mismatch as much as colour when the drawings differ.
LABELLED = os.path.join(os.path.dirname(SRC), "evenmoredinos.png")
LABELLED_GRID = (5, 4)
LABELLED_NAMES = [
    ["Allosaurus", "Carnotaurus", "Andrewsarchus", "Brontosaurus", "Cave_Lion"],
    ["Cryolophosaurus", "Deinocheirus", "Diplodocus", "Kronosaurus", "Troodon"],
    ["Utahraptor", "Deinonychus", "Tylosaurus", "Pterodactylus", "Dimorphodon"],
    ["Tapejara", "TerrorBird", "Helicoprion", "Ornithomimus", None],
]
# Background is alpha 0-3 and sprites are 249-254, so the split is clean.
# The captions are separate components and never the largest in a tile.
LABELLED_ALPHA = 128

# Hue after the transfer, weighted by saturation. THE POSE-INDEPENDENT
# GATE, and the one that actually describes what the mutation filters
# need: they are hue-rotations calibrated against the 72 palettes, so what
# has to hold is that the base hue lands where they expect. Measured
# across all nineteen, the transfer lands within 4 degrees every time --
# Cryolophosaurus comes in at 249 and leaves at 29 against a target of 29.
# 15 is generous against that and still catches a real miss.
MAX_HUE_DRIFT = 15.0

# After the transfer, measure. A species whose colours still cannot be
# brought home is DEMOTED to its crisp 72: a regional recolour (shell
# one way, fins another) is beyond a global moment match, and shipping
# it wrong would break every mutation of the species -- the filters are
# hue-rotations calibrated against these palettes. Shipped art is
# faithful and large, or faithful and small, never wrong.
#
# There WAS a contrast-retention gate here too, defending against the
# flattening the least-squares transfer used to cause. Moment matching
# made it obsolete and then it turned actively wrong: the 72s are
# smooth DOWNSCALES, their pixel variance is inherently below sharp
# full-res art, so "keep the raw's contrast" condemned outputs that a
# side-by-side board showed to be perfectly detailed. The board
# (tan Archelon with its shell pattern, red Ceratosaurus with skin
# texture) is what removed it; do not reinstate it from a number.
PALETTE_LIMIT = 3500.0

MIN_AREA = 900          # a real sprite; stray pixels and watermarks are smaller
THUMB = 28              # comparison size; small enough to forgive crop noise

# Match acceptance is a MARGIN, not a distance. The sheets have been
# resampled, so even a true pair (a named individual against its own sheet
# sprite) scores 6-10k MSE -- measured, not guessed. What separates a real
# match from noise is how far ahead of the runner-up it is: true pairs come
# in 1.4-4x ahead, and species with no counterpart in the sheets at all
# (the pack's original fourteen classics exist ONLY at 72px) score ~25k
# with the runner-up a percent behind.
# Two tiers, calibrated against the review sheets rather than invented:
# true pairs measured 22-2400 with margins from 1.8 up to 176, while the
# noise floor (species with no counterpart) starts around 2800 with margins
# hugging 1.0-1.4. The band between is where both live, so it needs the
# margin as well as the distance.
SURE_MSE = 2500.0
BAND_MSE = 4000.0
BAND_MARGIN = 1.55

# Judgment pins from eyeballing the review boards. Numbers propose, eyes
# dispose, in both directions:
#
# Stygimoloch's best score passes the band rule and is WRONG -- the 72 is
# a pachycephalosaur, the sprite it claims a frilled ceratopsian.
FORCE_KEEP72 = {"Stygimoloch"}

# And these fail the band rule and are RIGHT -- eyeballed against the 72
# at full size, not merely scored, because a shared silhouette score is not
# the same claim as a shared species. Kept to the ones with a distinctive
# anatomical feature actually visible in both: Amargasaurus's double sail
# of neck spikes, Styracosaurus's spiked frill, TerrorBird's oversized
# beak, Baryonyx's crocodile snout, Helicoprion's spiral tooth whorl.
#
# Deinonychus and Utahraptor were LOOKED AT and left out on purpose: both
# candidates are feathered dromaeosaurs, which is the right family, but
# the wing pose is different enough from the 72 that "same species" is a
# guess rather than a reading. A wrong portrait is worse than a small
# right one, so they stay at 72 until someone who knows the source art
# confirms them.
#
# Wrong-species risk is bounded twice over: distinctive-feature matching
# here, and the palette gate below, which still has to pass before a
# pinned sprite ships -- Helicoprion and TerrorBird are confirmed correct
# and STILL render at 72, because their colours cannot be honestly
# recovered (see PALETTE_LIMIT).
FORCE_ACCEPT = {
    "Amargasaurus", "Baryonyx", "Helicoprion", "Styracosaurus", "TerrorBird",
}

# A match is the same SHAPE; it is not always the same colours -- the pack
# ships alternate palettes, and even some named individuals drifted from
# the served 72s. Colour fidelity here is not taste: the game's mutation
# system is CSS hue-rotate/saturate stacked on the BASE art, calibrated
# against the tan 72px palettes, so a portrait that arrives blue renders
# every mutation of that species wrong. Every piece of recovered art is
# therefore RE-PALETTED onto its own 72's colours before it is written --
# the output palette is a subset of what the filters were tuned against,
# and the detail is what the large art brings. --raw-colours skips the
# transfer, for eyeballing what the pack originally looked like.
SAME_PALETTE_MSE = 13000.0

WRITE = "--write" in sys.argv


def trim(im):
    box = im.getbbox()
    return im.crop(box) if box else im


def keep_largest_blob(im):
    """Strip everything that is not the main sprite, then trim tight.

    THE SOURCES ARE DIRTY. Fourteen of the pack's 32 individual files carry
    a second blob of pixels away from the animal -- scattered flecks in most,
    and a 737-pixel fragment on Dimorphodon that belongs to nothing. Nothing
    filtered them, because individual files never went through the sheet
    segmenter: trim() took getbbox() over EVERY non-transparent pixel, so a
    fleck in a far corner both appeared in the crop and inflated the
    bounding box around it, pushing the animal off-centre inside a canvas
    mostly full of nothing.

    Flood-fill on alpha, keep the largest component, zero the rest. The
    main blob is the whole animal in all fourteen -- checked by rendering
    main-vs-rest side by side, not assumed.

    Sheet crops arrive here already single-component by construction, so
    this is a no-op safety net for them.
    """
    import numpy as np
    arr = np.array(im.convert("RGBA"))
    mask = arr[..., 3] > 0
    if not mask.any():
        return im

    h, w = mask.shape
    seen = np.zeros_like(mask)
    best, best_px = 0, None
    for sy in range(h):
        for sx in range(w):
            if not mask[sy, sx] or seen[sy, sx]:
                continue
            stack = [(sy, sx)]
            seen[sy, sx] = True
            px = []
            while stack:
                cy, cx = stack.pop()
                px.append((cy, cx))
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        ny, nx = cy + dy, cx + dx
                        if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not seen[ny, nx]:
                            seen[ny, nx] = True
                            stack.append((ny, nx))
            if len(px) > best:
                best, best_px = len(px), px

    keep = np.zeros_like(mask)
    for (cy, cx) in best_px:
        keep[cy, cx] = True
    arr[~keep, 3] = 0
    return Image.fromarray(arr)


def square(im):
    side = max(im.size)
    out = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    out.paste(im, ((side - im.size[0]) // 2, (side - im.size[1]) // 2))
    return out


def thumb(im):
    """A fixed-size, aspect-preserving thumbnail on a transparent square."""
    return square(trim(im)).resize((THUMB, THUMB), Image.LANCZOS)


def silhouette(im):
    """The shape alone: the alpha channel of the normalised thumbnail.

    MATCHING IS DONE ON SHAPE, NOT COLOUR, and the review sheets are why.
    moredinos.png turned out to hold RECOLOURED variants of the pack's
    species -- the blue Archelon to the served tan one, a red-striped
    Stygimoloch to the served sand one. A colour metric rejected every one
    of those true pairs and then matched Kronosaurus to a boar that merely
    shared its brown. A palette swap of a sprite keeps its silhouette to
    the pixel, and no two species here share a pose, so shape separates
    what colour muddles.
    """
    return square(trim(im)).resize((THUMB, THUMB), Image.LANCZOS).getchannel("A")


def colour_mse(a, b):
    """Mean squared RGBA error between two colour thumbnails."""
    pa, pb = a.load(), b.load()
    total = 0
    for y in range(THUMB):
        for x in range(THUMB):
            ca, cb = pa[x, y], pb[x, y]
            total += sum((ca[i] - cb[i]) ** 2 for i in range(4))
    return total / (THUMB * THUMB)


def palette_mse(a, b):
    """Colour distance where BOTH thumbnails are solid.

    The RGBA metric punishes shape as much as colour: on a thin-winged
    pterosaur, a one-pixel misregistration between two thumbnails swamps
    the palette signal entirely, which made faithfully re-paletted flyers
    measure as badly as genuinely blue ones. Comparing RGB only on
    mutually solid pixels asks the actual question -- are these the same
    colours -- and leaves alignment out of it.
    """
    pa, pb = a.load(), b.load()
    total, n = 0, 0
    for y in range(THUMB):
        for x in range(THUMB):
            ca, cb = pa[x, y], pb[x, y]
            if ca[3] >= 200 and cb[3] >= 200:
                total += (ca[0]-cb[0])**2 + (ca[1]-cb[1])**2 + (ca[2]-cb[2])**2
                n += 1
    return total / n if n else float("inf")


def mse(a, b):
    """Mean squared error between two silhouette thumbnails."""
    pa, pb = a.load(), b.load()
    total = 0
    for y in range(THUMB):
        for x in range(THUMB):
            d = pa[x, y] - pb[x, y]
            total += d * d
    return total / (THUMB * THUMB)


def is_checker(c):
    """Is this pixel the baked-in transparency checkerboard?

    The tones were MEASURED, not assumed: the sheets have been through a
    resample at some point (moredinos.png is 1535 wide — an odd number),
    so the checker is not two exact colours but a smear — 233-236 for the
    dark squares, 252-255 for the light, with blends where squares meet.
    What stays true of every one of them is bright and near-grey, which is
    also a combination the dinosaurs almost never are.
    """
    r, g, b = c[0], c[1], c[2]
    lo = min(r, g, b)
    return lo >= 210 and (max(r, g, b) - lo) <= 8


def strip_background(im):
    """Alpha out the checker. Detection only — the crops repair themselves
    afterwards, see repair_interior."""
    if im.getpixel((0, 0))[3] == 0:
        return im  # already transparent; nothing to do
    px = im.load()
    w, h = im.size
    for y in range(h):
        for x in range(w):
            if px[x, y][3] != 0 and is_checker(px[x, y]):
                c = px[x, y]
                px[x, y] = (c[0], c[1], c[2], 0)
    return im


def repair_interior(crop):
    """Restore bright-grey pixels that are INSIDE the sprite.

    The checker rule cannot tell background from teeth: a white fang is
    bright, near-grey, and gone. But a fang is enclosed by the sprite and
    the background is not, so: flood the transparency from the crop's own
    border, and any transparent pixel the flood cannot reach is interior —
    its colour is still in the RGB channels (the strip only zeroed alpha),
    so restoring it is one alpha write, not a guess.
    """
    w, h = crop.size
    px = crop.load()
    reach = bytearray(w * h)
    stack = []
    for x in range(w):
        for y in (0, h - 1):
            if px[x, y][3] == 0 and not reach[y * w + x]:
                reach[y * w + x] = 1
                stack.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            if px[x, y][3] == 0 and not reach[y * w + x]:
                reach[y * w + x] = 1
                stack.append((x, y))
    while stack:
        x, y = stack.pop()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h and not reach[ny * w + nx] and px[nx, ny][3] == 0:
                reach[ny * w + nx] = 1
                stack.append((nx, ny))
    for y in range(h):
        for x in range(w):
            if px[x, y][3] == 0 and not reach[y * w + x]:
                c = px[x, y]
                px[x, y] = (c[0], c[1], c[2], 255)
    return crop


def repalette(large, small):
    """Pull the large art's colours toward its 72px version's palette.

    PER-CHANNEL MOMENT MATCHING (Reinhard): shift and scale each RGB
    channel so the large art's solid pixels take on the 72's mean and
    spread. Third attempt, and each predecessor died of something a metric
    missed until a board showed it. Per-colour lookup voting turned finely
    shaded art into static, because neighbouring shades voted for unrelated
    targets. A least-squares affine fit could not speckle, but the pixel
    correspondences it fits on are noisy, and regression answers noise by
    contracting toward the mean -- it flattened Archelon's shell pattern
    into silhouette-coloured mush, and quietly desaturated even
    well-matched art in proportion to how badly its trim boxes aligned.

    Moment matching cannot do either: it never maps two shades to
    unrelated targets, and it EQUATES the spreads, so contrast survives by
    construction. What it cannot do is regional recolours -- a shell one
    way and fins another -- and it should not try: those still fail the
    palette gate afterwards and ship as the crisp 72 instead.
    """
    import numpy as np
    a = np.array(trim(large.convert("RGBA")), dtype=np.float64)
    b = np.array(trim(small.convert("RGBA")), dtype=np.float64)
    sa = a[..., 3] >= 200
    sb = b[..., 3] >= 200
    if sa.sum() < 50 or sb.sum() < 50:
        return large

    src = a[sa][:, :3]
    tgt = b[sb][:, :3]
    out = a.copy()
    for c in range(3):
        std_s = src[:, c].std()
        std_t = tgt[:, c].std()
        scale = (std_t / std_s) if std_s > 1e-6 else 1.0
        out[..., c] = (a[..., c] - src[:, c].mean()) * scale + tgt[:, c].mean()
    out[..., :3] = out[..., :3].clip(0, 255)
    out[..., 3] = a[..., 3]
    return Image.fromarray(out.astype(np.uint8))


def hue_sat(im):
    """Saturation-weighted mean hue, and mean saturation, of solid pixels.

    Weighted because a grey pixel's hue is arbitrary and would otherwise
    drag the average somewhere meaningless. Circular mean, because hue
    wraps: averaging 350 and 10 the naive way gives 180, the opposite
    colour.
    """
    import numpy as np
    a = np.array(im.convert("RGBA"), dtype=np.float64)
    solid = a[..., 3] >= 200
    if solid.sum() < 20:
        return 0.0, 0.0
    rgb = a[solid][:, :3] / 255.0
    mx = rgb.max(1)
    mn = rgb.min(1)
    d = mx - mn
    sat = np.where(mx > 0, d / np.maximum(mx, 1e-6), 0)
    r, g, b = rgb[:, 0], rgb[:, 1], rgb[:, 2]
    h = np.zeros(len(rgb))
    nz = d > 1e-6
    i = nz & (mx == r); h[i] = ((g - b)[i] / d[i]) % 6
    i = nz & (mx == g); h[i] = ((b - r)[i] / d[i]) + 2
    i = nz & (mx == b); h[i] = ((r - g)[i] / d[i]) + 4
    deg = np.deg2rad((h * 60) % 360)
    if sat.sum() < 1e-6:
        return 0.0, float(sat.mean())
    mean = np.rad2deg(np.arctan2((np.sin(deg) * sat).sum(),
                                 (np.cos(deg) * sat).sum())) % 360
    return float(mean), float(sat.mean())


def hue_drift(a, b):
    """Shortest angular distance between two images' mean hues."""
    ha, _ = hue_sat(a)
    hb, _ = hue_sat(b)
    return abs((ha - hb + 180) % 360 - 180)


def labelled_tiles():
    """Every sprite on the labelled sheet, keyed by its printed caption.

    Per tile rather than per sheet: the largest component inside one tile
    is always the animal, which drops the caption without having to read
    or erase it.
    """
    import numpy as np
    if not os.path.exists(LABELLED):
        return {}
    arr = np.array(Image.open(LABELLED).convert("RGBA"))
    mask = arr[..., 3] >= LABELLED_ALPHA
    cols, rows = LABELLED_GRID
    H, W = mask.shape
    tw, th = W / cols, H / rows

    out = {}
    for r in range(rows):
        for c in range(cols):
            name = LABELLED_NAMES[r][c]
            if not name:
                continue
            y0, x0 = int(r * th), int(c * tw)
            sub = mask[y0:int((r + 1) * th), x0:int((c + 1) * tw)]
            sh, sw = sub.shape
            seen = np.zeros_like(sub)
            best = None
            for sy in range(sh):
                for sx in range(sw):
                    if not sub[sy, sx] or seen[sy, sx]:
                        continue
                    stack = [(sy, sx)]
                    seen[sy, sx] = True
                    px = []
                    while stack:
                        cy, cx = stack.pop()
                        px.append((cy, cx))
                        for dy in (-1, 0, 1):
                            for dx in (-1, 0, 1):
                                ny, nx = cy + dy, cx + dx
                                if 0 <= ny < sh and 0 <= nx < sw and sub[ny, nx] and not seen[ny, nx]:
                                    seen[ny, nx] = True
                                    stack.append((ny, nx))
                    if best is None or len(px) > len(best):
                        best = px
            if not best:
                continue
            ys = [q[0] for q in best]
            xs = [q[1] for q in best]
            y1, y2, x1, x2 = min(ys), max(ys), min(xs), max(xs)
            crop = np.zeros((y2 - y1 + 1, x2 - x1 + 1, 4), dtype=np.uint8)
            for (py, px_) in best:
                crop[py - y1, px_ - x1] = arr[y0 + py, x0 + px_]
            out[name] = Image.fromarray(crop)
    return out


def components(im):
    """Connected sprites in a sheet, 8-connected on alpha, iterative flood.

    Each crop is MASKED to its own component's pixels, not just its
    bounding box. Sheets pack sprites tightly, so a long-tailed neighbour
    reaches into this sprite's rectangle -- the first build shipped an
    Apatosaurus with a blue smudge of someone else's tail in the corner,
    visible on the review board and inevitable with a bare bbox crop.
    """
    im = strip_background(im)
    w, h = im.size
    alpha = im.getchannel("A").load()
    seen = bytearray(w * h)
    out = []
    for sy in range(h):
        for sx in range(w):
            if alpha[sx, sy] == 0 or seen[sy * w + sx]:
                continue
            stack = [(sx, sy)]
            seen[sy * w + sx] = 1
            mine = [(sx, sy)]
            x0, y0, x1, y1 = sx, sy, sx, sy
            while stack:
                x, y = stack.pop()
                if x < x0: x0 = x
                if y < y0: y0 = y
                if x > x1: x1 = x
                if y > y1: y1 = y
                for dx in (-1, 0, 1):
                    for dy in (-1, 0, 1):
                        nx, ny = x + dx, y + dy
                        if 0 <= nx < w and 0 <= ny < h and not seen[ny * w + nx] and alpha[nx, ny] != 0:
                            seen[ny * w + nx] = 1
                            stack.append((nx, ny))
                            mine.append((nx, ny))
            if len(mine) >= MIN_AREA:
                cw, ch = x1 - x0 + 1, y1 - y0 + 1
                crop = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
                src = im.load()
                dst = crop.load()
                for (x, y) in mine:
                    dst[x - x0, y - y0] = src[x, y]
                out.append(repair_interior(crop))
    return out


def main():
    # ── The targets: every 72x72 the game serves ─────────────────────────
    served = {}
    for f in sorted(os.listdir(SERVED)):
        if f.endswith("-72x72.png"):
            served[f[: -len("-72x72.png")]] = Image.open(os.path.join(SERVED, f)).convert("RGBA")
    print(f"served portraits: {len(served)}")

    # ── Source 1: individuals, matched by their own filename ────────────
    individuals = {}
    for root, _, files in os.walk(SRC):
        for f in files:
            if not f.endswith(".png") or "72x72" in f or f in SHEETS:
                continue
            im = Image.open(os.path.join(root, f)).convert("RGBA")
            if max(im.size) > 100:
                individuals[f[:-4].lower()] = im

    def named(name):
        for cand in (name.lower(), name.lower().replace("_", " "), name.lower().replace("_", "")):
            if cand in individuals:
                return keep_largest_blob(individuals[cand])
        return None

    # ── Source 2: the sheets, cut into anonymous sprites ────────────────
    sprites = []
    for sheet in SHEETS:
        p = os.path.join(SRC, sheet)
        if not os.path.exists(p):
            print(f"  ! sheet missing: {sheet}")
            continue
        cut = components(Image.open(p).convert("RGBA"))
        print(f"  {sheet}: {len(cut)} sprites")
        sprites.extend(cut)
    sprite_thumbs = [silhouette(s) for s in sprites]

    # ── Match every target to its best large source ──────────────────────
    # THE LABELLED SHEET WINS. Its species names are read off the art, not
    # inferred from a silhouette, so there is no confidence question to
    # answer and no way to ship one dinosaur under another's name.
    captioned = labelled_tiles()
    print(f"  evenmoredinos.png: {len(captioned)} captioned sprites")

    results = {}          # name -> (kind, image, score)
    pending = []
    for name, small in served.items():
        if name in captioned:
            results[name] = ("labelled", keep_largest_blob(captioned[name]), 0.0)
            continue
        big = named(name)
        if big is not None:
            results[name] = ("name", big, 0.0)
        else:
            pending.append((name, small))

    # All distances first, then assignment by confidence: the most certain
    # match claims its sprite before a shakier one can steal it.
    scored = []
    for name, small in pending:
        st = silhouette(small)
        d = sorted((mse(st, cand), i) for i, cand in enumerate(sprite_thumbs))
        best, second = d[0], d[1] if len(d) > 1 else (float("inf"), -1)
        scored.append((best[0], second[0], best[1], name, small))
    scored.sort()

    used = set()
    for best, second, idx, name, small in scored:
        margin = second / max(best, 1.0)
        accepted = (best <= SURE_MSE) or (best <= BAND_MSE and margin >= BAND_MARGIN)             or (name in FORCE_ACCEPT)
        if idx not in used and accepted and name not in FORCE_KEEP72:
            used.add(idx)
            cd = colour_mse(thumb(small), thumb(sprites[idx]))
            kind = "sheet" if cd <= SAME_PALETTE_MSE else "variant"
            results[name] = (kind, sprites[idx], best)
        else:
            results[name] = ("kept72", small, best)

    by_kind = {}
    for name, (kind, im, score) in sorted(results.items()):
        by_kind.setdefault(kind, []).append(name)
        tag = {"labelled": "CAPTIONED", "name": "individual", "sheet": "sheet match",
               "variant": "RECOLOUR", "kept72": "NO LARGE ART"}[kind]
        size = "x".join(map(str, im.size))
        extra = f"  (mse {score:.0f})" if kind == "sheet" else ("" if kind == "name" else f"  (best mse {score:.0f})")
        print(f"  {name:24s} {tag:12s} {size:>9s}{extra}")

    print()
    for kind, names in sorted(by_kind.items()):
        print(f"{kind}: {len(names)}")

    if not WRITE:
        print("\nreport only -- rerun with --write to build the folder")
        return

    raw_colours = "--raw-colours" in sys.argv
    os.makedirs(OUT, exist_ok=True)
    # Wiped first, because outcomes RENAME: a species upgraded on one run
    # and kept at 72 on the next writes a different filename, and the stale
    # one would sit beside it forever, tracked and served.
    for f in os.listdir(OUT):
        if f.endswith(".png"):
            os.remove(os.path.join(OUT, f))


    chosen = {}   # name -> filename actually written
    demoted = []
    for name, (kind, im, _) in results.items():
        if kind != "kept72" and not raw_colours:
            im = repalette(im, served[name])
            if kind == "labelled":
                # A DIFFERENT DRAWING, so there is no pixel correspondence
                # and palette_mse would be reading pose mismatch as colour
                # error. Hue after the transfer is the honest question:
                # the mutation filters are hue-rotations, so what matters
                # is that the base hue lands where they were calibrated.
                drift = hue_drift(im, served[name])
                limit, unit = MAX_HUE_DRIFT, "deg"
            else:
                drift = palette_mse(thumb(im), thumb(served[name]))
                limit, unit = PALETTE_LIMIT, ""
            if drift > limit:
                demoted.append(f"{name} ({drift:.0f}{unit})")
                kind, im = "kept72", served[name]
        if kind == "kept72":
            # The suffix is the rendering contract: portraitImg treats a
            # -72x72 file as pixel art and everything else as smooth.
            fn = f"{name}-72x72.png"
            square(im).save(os.path.join(OUT, fn))
        else:
            # RECTANGULAR, NOT PADDED TO SQUARE. A pterosaur is three times
            # wider than it is tall and a sauropod wider still; padding every
            # one into a square canvas spent most of the file on transparency
            # and, once a stray fleck had inflated the bounding box, put the
            # animal off-centre inside it. The game sizes these to fit a
            # square slot while preserving aspect, so the file no longer has
            # to lie about its shape.
            fn = f"{name}.png"
            trim(keep_largest_blob(im)).save(os.path.join(OUT, fn))
        chosen[name] = fn
    total = sum(os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT))
    print(f"wrote {len(results)} portraits to {os.path.relpath(OUT, REPO)}  ({total/1024:.0f} KB)")
    if demoted:
        print(f"kept at 72 for palette fidelity: {', '.join(sorted(demoted))}")

    patch_game(chosen)


def patch_game(chosen):
    """Point the game's ASSET_MAP at whatever this run wrote.

    Same run, same script, on purpose: the folder and the map are two halves
    of one fact, and patching them separately is how they drift. The rewrite
    is idempotent -- it matches both the original BP paths and its own PT
    output, so rerunning after a decision change just moves the pointers.
    """
    import re
    page = os.path.join(REPO, "games", "dino-park", "index.html")
    src = open(page, encoding="utf-8", newline="").read()

    if "const PT" not in src:
        anchor = "const BP = AB + 'AncientBeastsPack/';"
        assert src.count(anchor) == 1
        lines = [
            anchor,
            "/* Rebuilt portraits, tracked in git so they deploy with a pull -- the",
            "   dino-assets tree is gitignored and every change to it means a hand",
            "   copy to the rig. Written by tools/build-dino-portraits.py, which",
            "   also rewrites the portrait paths below: the folder and the map are",
            "   two halves of one fact. */",
            "const PT = 'assets/portraits/';",
        ]
        block = chr(10).join(lines)
        src = src.replace(anchor, block, 1)

    counter = {"n": 0}
    def swap(m):
        base = m.group(1)
        fn = chosen.get(base)
        if fn is None:
            return m.group(0)
        counter["n"] += 1
        return f"portrait: PT+'{fn}'"
    src = re.sub(r"portrait: (?:BP|PT)\+'([A-Za-z_-]+?)(?:-72x72)?\.png'", swap, src)
    open(page, "w", encoding="utf-8", newline="").write(src)
    print(f"index.html: {counter['n']} portrait paths point at the new folder")


if __name__ == "__main__":
    main()
