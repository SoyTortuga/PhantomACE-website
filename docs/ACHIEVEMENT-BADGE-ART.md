# Achievement badge art

Twelve badges. **The frames already exist** in `assets/badges/` — a 144x144
roundel ringed in the badge's rarity colour, generated from the same
`--rarity-*` tokens the rest of the site uses, so all twelve match and each
ring agrees with the colour the UI draws around that badge.

**Draw the glyph into the middle.** The clear area is 96x96 centred on the
canvas (24px in from every edge); stay inside it and the ring stays clean.
Save over the same filename. They can land one at a time, in any order.

Regenerate a frame by deleting the file and running:
`node server/scripts/make-badge-frames.js --write` — it never overwrites a
file that is already there, so it cannot wipe art you have drawn.

## Memory Match

| File | Badge | Rarity | Ring | Earned by |
|---|---|---|---|---|
| `mm-flawless.png` | Flawless | rare | `#cc88ff` | Clear a 20-pair board in 20 moves — every single flip a match. |
| `mm-fifty.png` | Card Counter | uncommon | `#00cc66` | Finish 50 ranked games. |
| `mm-daily-five.png` | Daily Devotion | uncommon | `#00cc66` | Play the daily puzzle on 5 different days. |

## Commander Bingo

| File | Badge | Rarity | Ring | Earned by |
|---|---|---|---|---|
| `cb-first.png` | Called | common | `#FFFFFF` | Hit your first bingo. |
| `cb-blackout.png` | Blackout | rare | `#cc88ff` | Fill every square on a card. |
| `cb-ten.png` | Regular | uncommon | `#00cc66` | Play 10 games through to the end. |

## PhamShock

| File | Badge | Rarity | Ring | Earned by |
|---|---|---|---|---|
| `ps-first.png` | First Shot | common | `#FFFFFF` | Win your first match. |
| `ps-streak.png` | Dialled In | rare | `#cc88ff` | Win 3 matches in a row. |
| `ps-ten.png` | Veteran | uncommon | `#00cc66` | Win 10 matches. |

## MTGBBB

| File | Badge | Rarity | Ring | Earned by |
|---|---|---|---|---|
| `bbb-first.png` | Cracked | common | `#FFFFFF` | Score a point in a box crack. |
| `bbb-five.png` | Box Fiend | uncommon | `#00cc66` | Play through 5 box cracks. |
| `bbb-blackout.png` | Full Box | mythic | `#ff6600` | Black out a card in a box crack. |

Two are called **Blackout** (`cb-blackout`, `bbb-blackout`) and three are
a *first* something — they sit side by side on a profile, so they want to
read apart at a glance.

Rarity is written into the item when somebody earns it and never read back,
so changing one afterwards means a repair script over every inventory holding
it. Cheap to change now, expensive later.
