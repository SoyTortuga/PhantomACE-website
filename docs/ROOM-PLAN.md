# My Room — plan

**Status:** proposed. Nothing built. Awaiting answers to §10.
**Owner:** `cosmetics` agent for the profile section; `asset-manager` for the atlas.

A top-down pixel-art room that each member builds from the *Gaming Room
Interiors MegaPack* and shows on their profile at `/user/<login>`: floor tiles
on a grid, walls around it, and furniture, lights, posters and gear placed
freely and scaled to taste.

---

## 1. What the pack actually is

Measured, not assumed — `newfolder/` holds nine MegaPacks; this plan covers the
one named. It is **20 sheets, each 1536×1024 RGBA, ~600 pieces in all**:

| # | sheet | pieces | typical size | notes |
|---|---|---|---|---|
| 1 | Floor tiles | 45 | ~128×128 | clean 5×9 grid; the "pack 1" floor |
| 2 | Wall tiles | 24 | ~170×194 | taller than wide: top-down wall faces |
| 3 | Gaming desk setups | 18 | ~235×228 | desk + chair as one piece |
| 4 | RGB PC towers | 16 | ~154×333 | tall |
| 5 | Mechanical keyboards | 24 | ~237×140 | |
| 6 | Gaming chairs | 32 | ~153×191 | |
| 7 | Multimonitor setups | 21 | 185–342 wide | |
| 8 | LED strip lights | 52* | 47–1479 wide | *strips touch and merge — needs overrides |
| 9 | Streaming equipment | 33 | ~146×159 | |
| 10 | Shelves and decor | 36 | 58–310 wide | |
| 11 | Neon signs | 35 | ~165×138 | wall items |
| 12 | Sofas and lounge | 35 | 100–271 wide | |
| 13 | Snack and drinks | 59* | 83–959 wide | *one merged row |
| 14 | Consoles and controllers | 36 | ~184×130 | |
| 15 | Posters and wall art | 9* | up to 733×799 | *clusters merge — needs overrides |
| 16 | Rugs and carpets | 23 | ~256×157 | floor layer, under props |
| 17 | Plants and greenery | 29 | ~168×174 | |
| 18 | Smart devices | 28 | ~161×178 | |
| 19 | Studio lights | 21 | ~151×186 | |
| 20 | Room and modular decor | 36 | ~157×142 | |

Facts that shape the design:

- **Backgrounds are transparent.** They render black in a viewer, but 35–68% of
  each sheet is alpha 0 and the stray pixels around pieces are alpha ≤ 3. So
  pieces can be cut out by connected components, not by colour keying.
- **Every sheet has a title banner** across the top ~210 px. It is not an asset
  and must be excluded.
- **Pieces are not on a regular grid** except sheet 1. Sizes vary within a
  sheet by 2–3×, so slicing is "find each blob's bounding box", not "cut every
  N px". Three sheets (8, 13, 15) have blobs that touch; those need a smaller
  merge distance or hand-drawn boxes.
- **Floor tiles are ~128 px in the source.** 100 px is a 0.78× downscale, which
  is not an integer ratio: nearest-neighbour will drop rows unevenly and
  bilinear will blur. See §10 Q3.

---

## 2. The atlas pipeline

A build script, run on the dev box, whose output is committed:

```
tools/build-room-atlas.py            Pillow + scipy (both already used here)
assets/room/pieces/<sheet>/<n>.png   one file per piece, trimmed to its box
assets/room/catalog.json             what exists, with sizes and categories
```

- Cuts every sheet below the banner into connected components (alpha > 0,
  dilated a few px so a chair's legs join its seat), trims each to its box,
  saves it, and records `{ id, sheet, category, w, h, layer }`.
- Per-sheet overrides in the script for the three merging sheets: a smaller
  dilation, a minimum/maximum box size, or explicit boxes.
- Emits a contact sheet per category for a **human review pass** before the
  catalog is trusted — a merged blob or a split piece is obvious to an eye and
  invisible to a test.
- `server/scripts/test-room-catalog.js` asserts every catalog entry's file
  exists, every file is in the catalog, sizes are within sane bounds, floor
  tiles are square, and ids are stable across rebuilds (ids come from sheet +
  position, not from enumeration order).

Floor tiles are additionally emitted **pre-scaled to the cell size** (§10 Q3)
so the page never resizes pixel art at runtime.

The catalog carries a `pack` field from day one so a second pack (there are
eight more in that folder) is a second build, not a redesign.

---

## 3. The room

**Grid.** Cells of 100 px. Base **12 × 8 cells = 1200 × 800 px** of floor,
plus a wall band along the top (and optionally the sides). That is roomy at
desktop width and scales down to phone width with one CSS transform. (§10 Q2.)

**Three layers, stored separately because they behave differently:**

| layer | what | placement |
|---|---|---|
| floor | one tile id per cell (or one default for the whole floor) | grid only |
| walls | one wall tile id per top-edge cell; optional side walls | grid only |
| props | rugs, furniture, lights, posters, gear | free: `x, y, scale, z` |

A prop record: `{ id, x, y, scale, flip }` — `x, y` in room pixels (top-left),
`scale` clamped (0.5–2.0 proposed, §10 Q5), `flip` horizontal only (no
rotation: these are top-down sprites drawn for one orientation), and draw
order = array order, with "bring forward / send back" in the editor. Rugs
default to the bottom of the order. **No text anywhere in the room** — that
is what keeps it moderation-free (§10 Q11).

**Limits, server-enforced:** at most N props (60 proposed), positions within
the room (a piece may overhang the edge by up to half its size so things can
sit against walls), ids must exist in the catalog.

---

## 4. Storage

One document per person, `room_<userId>`, through the KV shim — the same
shape as `dino_park_<userId>` and `inv_<userId>`. It is written whole by its
owner and read whole by everyone else; that is exactly what the shim is for.
Migration `007_rooms.sql` adds the `rooms` table and registry entry
`{ prefix: 'room_', table: 'rooms', expiry: 'none' }` (`room_` collides with
nothing: `mc_room_` and `ps_room_` are different prefixes).

The document, ~2–6 KB:

```json
{ "v": 1, "w": 12, "h": 8, "floor": "f01", "cells": { "3,4": "f12" },
  "walls": { "top": "w03" },
  "props": [ { "id": "desk07", "x": 220, "y": 140, "scale": 1, "flip": false } ],
  "updatedAt": 1758000000000 }
```

**The server validates every field against the catalog and the limits** and
refuses the whole save on any bad value. A room is public content composed
entirely of known images, so once validated there is nothing in it a viewer
can be harmed by — no free text, no URLs.

---

## 5. Pages

- **`/user/<login>`** — a **Room** section under Showcase, rendered read-only
  by `js/pages/profile-room.js` on the same `profile:rendered` event the
  comment wall uses. Renderer: absolutely-positioned `<img>` elements inside a
  1200×800 box with `image-rendering: pixelated`, scaled to fit the column.
  A member with no room shows nothing (§10 Q9).
- **`/room/edit`** (`room-editor.html`, owner only) — the same renderer plus:
  a palette down the side with the 20 categories, a search box, click-to-place,
  drag to move, a scale slider and flip button on the selected piece,
  forward/back/delete, undo (client-side stack), and Save. Floor and wall
  cells are painted by choosing a tile and clicking cells. Autosaves nothing:
  Save is explicit and confirms.

Both pages get the header scripts (the boot check enforces it).

---

## 6. API

`functions/api/room.js`:

| | |
|---|---|
| `GET ?id=<userId>` | the room, or 404. Public. |
| `POST` `{ room }` | validate against the catalog, write `room_<me>` via `mutate()`. Session required. |
| `POST` `{ action: 'clear' }` | delete `room_<me>`. |

`functions/api/room-catalog.js` (library, `NON_ROUTE_MODULES`) loads
`catalog.json` once and exposes `validateRoom(room)` — pure, so it is tested
one bad field at a time and mutation-checked like the forum rules.

---

## 7. Build order

0. **Answers to §10.** Q1 and Q3 change the pipeline; Q2 and Q5 change the
   validator; the rest change pages.
1. **Atlas** — script, overrides, contact sheets, review, catalog test.
2. **Validator + storage** — `room-catalog.js`, `room.js`, migration, tests
   including "a piece id not in the catalog is refused" and "sixty-one props
   is refused".
3. **Viewer** — the profile section, from a hand-written room document.
4. **Editor** — place, move, scale, flip, order, paint floor/walls, undo, save.
5. **Polish** — a thumbnail on the profile head, keyboard nudging, snap toggle.

---

## 8. What this deliberately is not

- Not a game: nothing moves, nothing is collected, nothing costs anything
  (unless §10 Q7 says otherwise).
- Not a canvas drawing tool: only pieces from the catalog, no colours, no text.
- Not isometric: the pack is top-down and is drawn as such.

---

## 9. Risks

- **The pack's licence.** Slicing and serving the pieces as individual files
  on a public site is redistribution of a kind; most itch.io asset licences
  allow use "in a project" and forbid redistribution "as assets". Serving them
  behind our own editor is a grey area worth one read of the licence text
  before anything ships. (§10 Q1.)
- **Slicing quality.** Three sheets will need hand attention; budget for it.
- **Page weight.** ~600 small PNGs is fine on demand (only placed pieces load
  on a profile), but the editor palette should lazy-load per category.

---

## 10. Questions before building

1. **Licence.** Does the pack's licence allow the pieces to be served as
   individual image files on the website (which is what any web editor needs)?
   If there is a licence file or the itch.io page's terms, I need its wording.
2. **Room size.** 12 × 8 cells at 100 px (1200 × 800) as the base — right
   size? Fixed for everyone, or a choice of sizes (S/M/L)?
3. **The 100 px floor.** Source tiles are ~128 px; 100 px is a non-integer
   downscale and will look slightly soft or uneven. Options: (a) 100 px as
   asked, bilinear, accept the softness; (b) **96 px** — an exact 3/4, crisp
   with nearest-neighbour, room becomes 1152 × 768; (c) keep 128 px cells and
   make the room 10 × 6. Which?
4. **Walls.** Top edge only (classic top-down), or all four sides? Sheet 2
   has 24 wall tiles, taller than wide, drawn as a face — they read best along
   the top.
5. **Prop scale range.** 0.5× to 2.0× proposed. Wider? Narrower? Should
   scaling snap to steps (0.5, 0.75, 1, 1.5, 2) or be continuous?
6. **Flip / rotate.** Horizontal flip yes; rotation no (the sprites have one
   drawn orientation). Agree?
7. **Who gets a room, and are pieces unlockable?** Everyone logged in, all
   ~600 pieces free? Or some categories (neon signs, RGB towers…) as Phamily
   Time / subscriber / milestone rewards — the inventory already exists for
   that. This decides whether the validator checks ownership.
8. **Item cap.** 60 props proposed. Fine?
9. **Empty rooms.** Show nothing on a profile with no room, or an empty default
   floor with a "build yours" prompt to the owner?
10. **Where else is it shown?** Profile only, or also a **Rooms gallery** page
    on Community, a "room of the week" on the overlay, or a thumbnail in the
    member search results?
11. **Any text?** A room name or caption? It is the only thing that would
    need moderation; without it a room can't contain anything a moderator has
    to look at.
12. **Snap.** Props free-placed (as asked) with an optional snap-to-grid
    toggle, or always free?
13. **One room per person**, or several with one chosen as public?
14. **Editor location.** A dedicated `/room/edit` page (proposed), or edit in
    place on your own profile?
15. **Other packs.** The folder holds eight more MegaPacks (Haunted Victorian,
    Dragon Kingdom, Atlantis…). Is "themes" a later goal? It costs nothing now
    to design the catalog for it and I would rather not retrofit.
