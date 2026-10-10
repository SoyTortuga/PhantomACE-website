# Achievement badge art — what to make

Twelve badges, one per achievement. **The system already works without
them**: a badge whose PNG is missing falls back to the slot glyph on both
surfaces that draw badges (the inventory grid and the profile), so these
can land one file at a time, in any order, with no deploy beyond copying
the file to the rig.

**Spec:** 144x144 PNG, transparent background — the convention every
existing badge follows except the raid ladder (512, an outlier). Drop them
in `assets/badges/` named exactly as below.

## Memory Match

| File | Badge | Rarity | Earned by |
|---|---|---|---|
| `mm-flawless.png` | Flawless | rare | Clear a 20-pair board in 20 moves — every single flip a match. |
| `mm-fifty.png` | Card Counter | uncommon | Finish 50 ranked games. |
| `mm-daily-five.png` | Daily Devotion | uncommon | Play the daily puzzle on 5 different days. |

## Commander Bingo

| File | Badge | Rarity | Earned by |
|---|---|---|---|
| `cb-first.png` | Called | common | Hit your first bingo. |
| `cb-blackout.png` | Blackout | rare | Fill every square on a card. |
| `cb-ten.png` | Regular | uncommon | Play 10 games through to the end. |

## PhamShock

| File | Badge | Rarity | Earned by |
|---|---|---|---|
| `ps-first.png` | First Shot | common | Win your first match. |
| `ps-streak.png` | Dialled In | rare | Win 3 matches in a row. |
| `ps-ten.png` | Veteran | uncommon | Win 10 matches. |

## MTGBBB

| File | Badge | Rarity | Earned by |
|---|---|---|---|
| `bbb-first.png` | Cracked | common | Score a point in a box crack. |
| `bbb-five.png` | Box Fiend | uncommon | Play through 5 box cracks. |
| `bbb-blackout.png` | Full Box | mythic | Black out a card in a box crack. |

Rarity is written into the item at grant time and is never read back from
the catalogue, so changing one after somebody has earned it means a repair
script over every inventory holding it. Cheap to change now, expensive
later — same rule as the event badges.
