# My Room — plan

**Status:** steps 1–2 built. 676 pieces in `assets/room/` with a tested
catalog; `room-catalog.js` validates every save (pure, mutation-checked) and
`/api/room` stores rooms in `rooms_<userId>` (migration `007_rooms.sql`,
applied). Step 3 built: `js/room-render.js` is the one renderer (32
assertions on its geometry), and every profile has a Room section — the
built room and its desk setup, or the empty default with "Build yours" for
the owner. Step 4 built: the editor at `/room/edit` — palette with locked
categories, floor and wall painting, place/drag/scale/flip/order/delete on
the 32 px grid, S/M/L, the Desk setup tab, undo, explicit Save through the
server's validator, a room switcher and "Show on profile" for people with
more than one slot. `js/room-edit-core.js` holds its arithmetic (44
assertions, every result re-checked against the validator). Step 5 built:
`room-set`, `room-piece` and `room-slot` items, the two-grain validator,
the partially-unlocked palette, and this month's 26-piece drip on both
tracks. Since then: quarter-turn rotation, the placement region opened into
the wall band so wall-hung pieces can reach a wall, and step 6 — the editor
made usable on a phone. **The feature is built.** What is left is in §8
step 6 and §11.
**Owner:** `cosmetics` agent for the profile section and unlocks;
`asset-manager` for the atlas.

A top-down pixel-art room that each member builds from the *Gaming Room
Interiors MegaPack* and shows on their profile at `/user/<login>`: floor tiles
on a grid, walls along the back and sides, and furniture, lights, posters and
gear placed on a snap grid and scaled in steps. Everyone starts with the basic
pieces; the rest — and extra rooms — are unlocked around the site.

---

## 1. What the pack actually is

Measured, not assumed — `newfolder/` holds nine MegaPacks; this plan covers the
one named. It is **20 sheets, each 1536×1024 RGBA, ~600 pieces in all**:

| # | sheet | pieces | typical size | notes |
|---|---|---|---|---|
| 1 | Floor tiles | 45 | ~128×128 | clean 5×9 grid; the floor |
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
  pieces are cut out by connected components, not by colour keying.
- **Every sheet has a title banner** across the top ~210 px. Not an asset;
  excluded.
- **Pieces are not on a regular grid** except sheet 1. Slicing is "find each
  blob's bounding box", not "cut every N px". Three sheets (8, 13, 15) have
  blobs that touch; those get a smaller merge distance or hand-drawn boxes.
- **Floor tiles are 128 px** and stay 128 px: the cell is the tile. No
  resampling of pixel art anywhere.

---

## 2. The atlas pipeline

A build script, run on the dev box, whose output is committed:

```
tools/build-room-atlas.py            Pillow + scipy (both already used here)
assets/room/pieces/<sheet>/<n>.png   one file per piece, trimmed to its box
assets/room/catalog.json             what exists: id, pack, category, w, h, layer, tier
```

- Cuts every sheet below the banner into connected components (alpha > 0,
  dilated a few px so a chair's legs join its seat), trims each to its box,
  saves it, and records it.
- Per-sheet overrides for the three merging sheets: a smaller dilation, a
  minimum/maximum box size, or explicit boxes.
- Emits a contact sheet per category for a **human review pass** before the
  catalog is trusted — a merged blob or a split piece is obvious to an eye and
  invisible to a test.
- Ids come from sheet + position, not enumeration order, so a rebuild does not
  renumber pieces that people have already placed.
- `server/scripts/test-room-catalog.js` asserts every catalog entry's file
  exists, every file is in the catalog, sizes are within bounds, floor tiles
  are square, and every category has a `tier`.

The catalog carries `pack` from day one. The other eight MegaPacks in that
folder are a later build each, not a redesign (§10 Q15).

---

## 3. The room

**Cell = 128 px.** Three sizes, chosen per room:

| size | cells | pixels |
|---|---|---|
| S | 9 × 6 | 1152 × 768 |
| M | 12 × 8 | 1536 × 1024 |
| L | 15 × 10 | 1920 × 1280 |

*Assumption (Q2):* your answer named 15×10 as the top; S and M are my proposals
beneath it, and **size is a free choice**, not a reward. Say so if you want
sizes unlocked.

**Walls** run along the back (top edge) and both sides, one wall tile per edge
cell, from sheet 2. The front edge is open, as top-down rooms are.

**Three layers, stored separately because they behave differently:**

| layer | what | placement |
|---|---|---|
| floor | one tile id per cell, over a room-wide default | grid |
| walls | one wall tile id per back/side edge cell | grid |
| props | rugs, furniture, lights, posters, gear | **snapped to a 32 px sub-grid** (¼ cell) |

*Assumption (Q12):* snap is always on, at 32 px rather than 128 — a keyboard
or a can snapped to whole cells could only sit in the middle of a tile.

A prop: `{ id, x, y, scale, rot, flip }` — `x, y` in room pixels on the 32 px
grid, `scale` one of **0.5, 0.75, 1, 1.5, 2**, `rot` one of **0, 90, 180,
270**, `flip` horizontal, draw order = array order with "bring forward / send
back". Rugs default to the bottom. Both transforms turn a piece about its own
centre, so neither moves it and placement never has to know about them. **No text anywhere in the room.** The room's name is the owner's
display name + "'s Room", generated, never typed.

**Where a prop may go — `placementRegion()`.** Its **centre** must be inside a
region that is the floor **plus the wall band**: `WALL_H` (176 px) out across
the back and down both sides, the open front edge unchanged. Half of a piece
may therefore hang past an edge, which is what lets a shelf sit against a wall
— and what lets posters, neon signs and shelves actually reach one. The first
version clamped to the floor rectangle alone, so a wall-hung piece could only
ever poke half its height above the floor and never look mounted; that was a
bug, fixed after the editor shipped. `js/room-edit-core.js` carries the same
function and `test-room-edit-core.js` asserts the two agree, so the editor
cannot produce a placement the server refuses.

**Limits, server-enforced:** **100 props**, the region above, every id in the
catalog, and every id either in a category the owner has or unlocked piece by
piece (§4).

### 3a. The desk setup — a second surface

About half the pack is not drawn top-down. Keyboards, monitors, PC towers,
consoles, snacks and smart devices are drawn **front-on**, as you would see
them sitting at the desk; placed on a top-down floor they look like they fell
over. So each room has **two surfaces**, edited in two tabs of the same
editor and shown together on the profile:

| surface | view | what goes on it | canvas |
|---|---|---|---|
| **Room** | top-down | floor, walls, desks, chairs, sofas, rugs, plants, shelves, decor, studio lights | S/M/L grid, §3 |
| **Setup** | front-on, the desk as you sit at it | keyboards, monitors, PC towers, consoles, snacks, smart devices, streaming gear, LED strips, neon signs, posters | fixed **1024 × 576**: the room's back-wall tile repeated behind, a desk surface across the lower third |

Every category in the catalog carries a **`surface`**: `room`, `desk`, or
`both` for the few that read fine either way (posters, neon, LED strips,
plants, decor). The palette shows only the current tab's categories, and the
validator refuses a piece on the wrong surface the same way it refuses one
that is not owned.

The setup uses the same prop record, snap (32 px), scale steps, flip, order
and controls as the room — it is the same editor pointed at a different
canvas. Its own cap: **40 props**. On the profile it sits under the room as a
second panel; a room with no setup shows the room alone.

*Assumption:* the split above is my reading of the sheets; the ones I would
double-check with you are streaming gear (mics and cameras — desk, I think)
and LED strips (both). Move any category and it is one line in the catalog.

---

## 4. Who has what

**Everyone starts with the basic categories.** The rest are unlocked around
the site through the inventory that already exists.

*Assumption (Q7), the split I would start with:*

| tier | categories |
|---|---|
| **basic** (everyone) | floor tiles, wall tiles, gaming desk setups, gaming chairs, sofas and lounge, rugs and carpets, shelves and decor, plants and greenery, room and modular decor |
| **unlockable** | RGB PC towers, mechanical keyboards, multimonitor setups, LED strip lights, streaming equipment, neon signs, snack and drinks, consoles and controllers, posters and wall art, smart devices, studio lights |

Unlocks come at **two grains**, because a month's release is a slice of a
set rather than a whole one:

- **`room-set`** — an inventory item with `meta.category`, opening a whole
  category. Used for the Studio Lights set (milestone 90) and for events.
- **`room-piece`** — an item with `meta.piece`, opening exactly one piece.
  This is what the Phamily Time pass drips.

The validator accepts either (`mayUse()`), and the palette lights an
individual piece inside a set you do not own, showing `2/24` beside it.

**The monthly rule: the first tenth of each set, rounded down.** For the
eight pass sets that is 26 pieces (snacks 7, led-strips 6, posters 3,
consoles 3, keyboards 2, smart 2, monitors 2, pc-towers 1), interleaved so
the sets arrive mixed, and spread across the whole pass — levels 4–142 on
the follower track, 3–122 on the subscriber one. Next month is the next
tenth: `slice(7, 14)` and so on.

The table lives in `defineFollowerRewards()` / `definePhamilyRewards()` and
is **duplicated in `js/pages/phamily-time.js`**; `test-phamily-rewards.js`
compares the two entry by entry, and `test-room-validator.js` checks every
id in it still exists in the catalog.

**Extra rooms** are an inventory item of type `room-slot`. Everyone has one
room; each slot is one more. One room is *public* at a time; the others are
kept. (Q13.)

---

## 5. Storage

One document per person, `rooms_<userId>`, through the KV shim — the same
shape as `dino_park_<userId>` and `inv_<userId>`: written whole by its owner,
read whole by everyone else. Migration `007_rooms.sql` adds the `rooms` table
and registry entry `{ prefix: 'rooms_', table: 'rooms', expiry: 'none' }`
(`rooms_` collides with nothing).

```json
{ "v": 1, "public": 0,
  "rooms": [
    { "size": "M", "floor": "f01", "cells": { "3,4": "f12" },
      "walls": { "back": ["w03","w03"], "left": ["w03"], "right": ["w03"] },
      "props": [ { "id": "desks-r1c1", "x": 224, "y": 128, "scale": 1, "flip": false } ],
      "setup": { "props": [ { "id": "monitors-r2c3", "x": 320, "y": 192, "scale": 1, "flip": false } ] },
      "updatedAt": 1758000000000 }
  ] }
```

**The server validates every field against the catalog, the limits and the
owner's inventory** and refuses the whole save on any bad value. A room is
public content composed entirely of known images: no free text, no URLs,
nothing for a moderator to look at.

---

## 6. Pages

- **`/user/<login>`** — a **Room** section under Showcase, rendered read-only
  by `js/pages/profile-room.js` on the same `profile:rendered` event the
  comment wall uses. Absolutely-positioned `<img>` elements in a room-sized
  box with `image-rendering: pixelated`, scaled to fit the column. A member
  with no room shows an **empty default floor**; the owner sees a **"Build
  yours"** button on it, everyone else sees just the floor. (Q9.)
- **`/room/edit`** (`room-editor.html`, owner only): the same renderer plus a
  palette down the side with the categories (locked ones shown greyed with
  how to unlock them), search, click-to-place, drag to move on the snap grid,
  scale steps and flip on the selected piece, forward/back/delete, floor and
  wall painting by tile-then-click, undo (client-side stack), room size and
  room switcher, and an explicit Save. (Q14.)

Both pages get the header scripts; the boot check enforces it.

---

## 7. API

`functions/api/room.js`:

| | |
|---|---|
| `GET ?id=<userId>` | the public room, or the empty default. Public. |
| `GET ?mine=1` | all of the owner's rooms and their unlocked categories and slots. |
| `POST { room, index }` | validate, write `rooms_<me>` via `mutate()`. |
| `POST { action: 'public', index }` | choose which room the profile shows. |
| `POST { action: 'clear', index }` | empty one room. |

`functions/api/room-catalog.js` (library, `NON_ROUTE_MODULES`) loads
`catalog.json` once and exposes `validateRoom(room, owned)` — pure, tested one
bad field at a time and mutation-checked like the forum rules.

---

## 8. Build order

Each step names its gate.

1. **Atlas** — script, overrides, contact sheets, **your review of the contact
   sheets**, catalog test.
2. **Validator + storage** — `room-catalog.js`, `room.js`, migration, tests
   including "an id not in the catalog", "a category not owned", "101 props",
   "a step scale of 1.3", "off the snap grid" — each refused, each
   mutation-checked.
3. **Viewer** — the profile section from a hand-written room, the empty
   default, the Build-yours prompt.
4. **Editor** — place, move, scale, flip, order, paint, size, undo, save.
5. **Unlocks** — `room-set` and `room-slot` items in the inventory, the locked
   palette, and the reward table you fill in.
6. **Polish.** Keyboard nudging shipped with the editor. The rest was
   decided by measuring rather than by the list:

   - **Done: the editor on a narrow screen.** It was unusable, and not for
     one reason. The palette is ~630px tall, so in source order it pushed
     the stage to y=858 — off screen, so you picked a piece and then
     scrolled past everything to find out where it went. And a 12×8 room
     fits 375px only at 0.17 scale, which draws a floor tile 22px across.
     Fixed together: the stage comes first, `fit()` takes a minimum scale
     (0.35, a 45px tile) and the host scrolls instead of shrinking past
     it, and `touch-action` is split so dragging a piece and panning the
     background each go to the right element. Desktop is untouched: an M
     room fits at 0.397, above the floor, so nothing scrolls.
   - **Not done: a thumbnail on the profile head.** The Room section is
     already on the profile a few hundred pixels below, so this would be
     the same picture twice. Say if you want it anyway.
   - **Not done: palette search.** Piece ids are positional
     (`snacks-r1c1`), so there is no descriptive text to search — it could
     only filter the 12–13 category names already visible in a list.
   - **Open, and the better version of both:** tapping the room on a
     profile to open it full-screen. On a phone a room renders at 0.17 and
     reads as a thumbnail; this is what would let someone actually look at
     it, on any screen. Not built.

---

## 9. What this deliberately is not

- Not a game: nothing moves, nothing is collected inside it.
- Not a canvas tool: only catalog pieces, no colours, no text.
- Not isometric: the pack is top-down and is drawn as such.
- Not a gallery (yet): profiles only. (Q10.)

---

## 10. Decisions

| # | question | decision |
|---|---|---|
| 1 | Licence | Allows it. |
| 2 | Room size | S 9×6, M 12×8, **L 15×10**; a free choice. *(S/M my proposal.)* |
| 3 | Floor cell | **128 px**, native. No resampling. |
| 4 | Walls | **Back and sides**; front open. |
| 5 | Scale | **0.5–2×, stepped**: 0.5, 0.75, 1, 1.5, 2. |
| 6 | Flip / rotate | Flip yes; **rotate yes, in quarter turns** — added after the editor shipped. The transform is `scaleX(-1) rotate(Ndeg)`, applied right to left, so Flip always reads as left-right on screen whatever the rotation. |
| 7 | Who gets what | **Basic categories for everyone; the rest unlocked** via inventory `room-set` items. *(Split in §4 is my proposal.)* |
| 8 | Prop cap | **100**. |
| 9 | Empty profiles | **Empty floor + "Build yours"** for the owner. |
| 10 | Where shown | **Profiles only** for now. |
| 11 | Text | None. Name is **"<name>'s Room"**, generated. |
| 12 | Snap | **Always on**, at a 32 px sub-grid. *(Sub-grid my proposal.)* |
| 13 | Rooms per person | One, **more via `room-slot` rewards**; one public at a time. |
| 14 | Editor | **Dedicated page**, `/room/edit`. |
| 15 | Other packs | **After everything else**; catalog carries `pack` from day one. |
| 16 | Front-on pieces | **A second surface per room, the desk setup** (§3a): fixed 1024×576, 40 props, its own editor tab and profile panel. Every category carries a `surface`. *(Category split my reading.)* |

Three items above are marked as my proposals filling gaps in the answers: the
S and M sizes, the basic/unlockable split, and the 32 px snap. Overrule any of
them and the plan changes in one place each.
