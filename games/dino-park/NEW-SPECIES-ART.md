# Dino Park — new epic/legendary species art ledger

13 species were added to the roster. **2 are live** (art already in the packs).
**11 are dormant** (`pending: true`) — defined, battle-wired, but hidden from
the Dinodex, hatch rolls, safari, trade-up and battle opponents until their art
exists. A test (`test-dino-battle.js` "art gate") refuses to let any species go
live without its icon on disk, so a dormant entry can never ship a broken sprite.

## Art spec (every piece)
- **32 × 32 px** PNG — these are pixel-art sprites, not hi-res (the "320" in the
  folder name is misleading; real icons are 32×32).
- Transparent background, single creature, side profile, limited palette —
  match the existing jurassic-dino icons.

## Need art — 11 (place the PNG at the EXACT path, then ping me to flip it live)

All paths are under the repo root.

| ✓ | Species | Tier | Path to create |
|---|---------|------|----------------|
| ☐ | Carcharodontosaurus | Legendary | `games/dino-park/assets/dino-assets/jurassic-dino-320-expansion160/icons/more_named_species/carcharodontosaurus.png` |
| ☐ | Titanoboa | Legendary | `games/dino-park/assets/dino-assets/jurassic-dino-320-expansion160/icons/more_named_species/titanoboa.png` |
| ☐ | Livyatan | Legendary | `games/dino-park/assets/dino-assets/jurassic-dino-320-expansion160/icons/flying_marine_reptiles/livyatan.png` |
| ☐ | Sarcosuchus | Legendary | `games/dino-park/assets/dino-assets/jurassic-dino-320-expansion160/icons/flying_marine_reptiles/sarcosuchus.png` |
| ☐ | Pliosaurus | Legendary | `games/dino-park/assets/dino-assets/jurassic-dino-320-expansion160/icons/flying_marine_reptiles/pliosaurus.png` |
| ☐ | Acrocanthosaurus | Epic | `games/dino-park/assets/dino-assets/jurassic-dino-320-expansion160/icons/more_named_species/acrocanthosaurus.png` |
| ☐ | Tarbosaurus | Epic | `games/dino-park/assets/dino-assets/jurassic-dino-320-expansion160/icons/more_named_species/tarbosaurus.png` |
| ☐ | Suchomimus | Epic | `games/dino-park/assets/dino-assets/jurassic-dino-320-expansion160/icons/more_named_species/suchomimus.png` |
| ☐ | Megalania | Epic | `games/dino-park/assets/dino-assets/jurassic-dino-320-expansion160/icons/more_named_species/megalania.png` |
| ☐ | Basilosaurus | Epic | `games/dino-park/assets/dino-assets/jurassic-dino-320-expansion160/icons/flying_marine_reptiles/basilosaurus.png` |
| ☐ | Patagotitan | Epic | `games/dino-park/assets/dino-assets/jurassic-dino-320-expansion160/icons/more_named_species/patagotitan.png` |

## Already live — 2 (no sourcing needed)
| Species | Tier | Existing file |
|---------|------|---------------|
| Yutyrannus | Legendary | `…/jurassic-dino-320-expansion160/icons/more_named_species/yutyrannus.png` |
| Gigantopithecus | Epic | `…/jurassic-dino-320/icons/prehistoric_mammals/giant_ape.png` |

## To take a dormant species live (one flip)
1. Drop its PNG at the exact path above.
2. Delete `pending: true` for that id in **both**:
   - `functions/api/dino-species.js`
   - `games/dino-park/index.html`
3. The art-gate test then passes for it; run `node server/scripts/run-all-tests.js`.

Everything else — icon path, battle archetype, apex signature move, ASSET_MAP —
is already wired. The 5 legendary apexes even have signatures defined
(Carcharodontosaurus→Serrated Bite, Titanoboa→Constrict, Livyatan→Raking Bite,
Sarcosuchus→Death Roll, Pliosaurus→Crushing Jaws); they just aren't reachable
until the species is live.

## Deploy caveat
`dino-assets/**` is **gitignored and deploys by manual copy**. Each finished PNG
must be placed in your local repo path **and** copied to the rig — a `git pull`
will not carry the art. (The 2 live icons were already in the packs, so confirm
they're present on the rig once; a pull won't add them.)
