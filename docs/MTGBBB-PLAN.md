# MTGBBB — Magic: The Gathering Booster Box Bingo

**Status:** design agreed, not yet built.
**Agent:** `game-mtgbbb`.

Chat plays along while the broadcaster cracks a sealed booster box on stream.
Everyone gets a bingo card of cards that could come out of that box; the
moderator marks each rare and mythic as it is pulled; points accrue live.

---

## 1. The loop

1. A moderator opens a room, picks an **MTG set** and a **box count**.
2. Players join and each receives a 5x5 card — 25 distinct rare/mythic card
   names from that set's booster pool, tied to their Twitch account.
3. The broadcaster opens packs. For each rare/mythic pulled, the moderator marks
   the card and ticks any special treatments.
4. Marks, treatments, bingos and blackout score live.
5. The host ends the game and awards a prize.

Entry stays open for the whole game. **A late joiner's card has every pull so
far applied retroactively** — nobody is punished for finding the stream at pack
twelve. Their card is random either way, so this costs no fairness.

---

## 2. Scoring

| | Points |
|---|---|
| Mark — the card was pulled | **1** |
| Each treatment on a pulled card | **1–3** (see below) |
| Bingo — any completed pattern | **5** |
| Blackout — all 25 marked | **25** |

**Thirteen bingo patterns**, cumulative — a card completing three of them scores
15:

- 5 rows
- 5 columns
- 2 diagonals
- the four corners **and** the centre, as one five-square pattern

**No free centre square.** Deliberate.

A perfect card is therefore 25 marks + 65 bingo + 25 blackout = **115 before
treatments**.

### Duplicates and stacking

A card can only be **marked once**, however many times it is pulled. Treatments
score **once per pull**: a plain copy followed later by a borderless foil copy
scores the mark once and both treatments on the second copy. Treatments stack
within a single physical card — a borderless foil is two treatments.

### Treatment values

Treatments are worth 1, 2 or 3 points, **ranked per set**: the treatment carried
by the fewest rare/mythics in that set's booster pool is worth the most.

This is a proxy and should be understood as one. Scryfall can say how many cards
carry a treatment; it cannot say how often you pull one. Those correlate but are
not the same thing. So:

- The computed table is shown to the moderator at room creation and **can be
  adjusted** before the game starts. They know the set.
- The final table is **frozen into the room**. Scores must never move because an
  upstream data source changed mid-game.
- The ladder is **capped at 3 tiers**. Treatments stack, so on a 1-2-3 ladder a
  borderless foil is already 4 points — near a bingo. A deeper ladder lets one
  lucky pack outweigh a completed line.

Serialized cards do not appear in Play Boosters and so will not appear in the
table for this product.

---

## 3. The odds, and why box count matters

Assuming a typical modern set — roughly 60 rares and 20 mythics in the booster
pool — and a 30-pack Play Booster box yielding about 31 rare and 5 mythic pulls:

| Boxes | Chance a given square is marked | Squares marked | Card gets ≥1 bingo | Blackout, per card |
|---|---|---|---|---|
| 1 | 36% | ~9 of 25 | ~8% | 1 in 114 billion |
| 2 | 59% | ~15 of 25 | ~60% | 1 in 640,000 |
| 3 | 73% | ~18 of 25 | ~95% | **1 in 2,900** |

**Blackout is decorative at one box and real at three.** With 60 players opening
three boxes it lands roughly once every fifty streams — often enough to be a
genuine event, rare enough to stay one. Bingo, meanwhile, goes from a prize for
the luckiest few to something most of the room achieves, so at high box counts
the score spread is carried by marks and treatments rather than by lines.

These are estimates from a generic set profile, not guarantees.

---

## 4. Card data

**Source: the Scryfall API.** Free, unauthenticated, and it knows which cards
actually appear in a given set's boosters — so "possible to pull from the base
set boosters" is a real query rather than a hand-curated list.

- **A square is a card *name*.** Modern sets print one card in several versions;
  those collapse to one square, and how it came out of the pack is the separate
  treatment axis. This is exactly the shape the game already assumes.
- A set is fetched **once**, when the first room for it is created, and cached
  under `mtgbbb_set_<SETCODE>` permanently. A set's contents never change.
  **Nothing touches Scryfall during a live game.**
- The set dropdown lists `CODE — Set Name`, newest release first, restricted to
  real paper sets that actually have boosters.
- **A set with fewer than 25 rare/mythics cannot fill a card.** Room creation
  refuses it with a clear reason rather than building a broken grid. No recent
  set is anywhere near this, but the guard is three lines.

Card images are Wizards of the Coast property served from Scryfall's CDN.
Hotlinking is how every client renders them; hammering is not. Small images on
the grid, larger art only for the single "just pulled" card.

---

## 5. Product

Play Booster boxes only. The moderator picks the product at room creation, and
**Collector Booster appears in the dropdown but is disabled** until we choose to
support it — a Collector box is 12 packs with 60+ rares and treatments on nearly
everything, which is a materially different game and needs its own odds work.

Multiple boxes per game are allowed, minimum one. The pack counter is
`boxes × 30`.

---

## 6. Moderator panel

The hardest UI in this game, and the only input to the entire scoring system. It
runs live, on camera, under time pressure, roughly 35 times per box, while the
broadcaster is already opening the next pack.

- **Type-ahead search**, not a grid. Three letters, Enter.
- **Treatment chips** for that set, from the frozen table, with point values
  visible.
- **Recent pulls list with undo.** Mistakes at this pace are certain, and every
  one of them changes somebody's score.
- **A visible pull count** — "pack 12 of 30" — so the broadcaster can sanity
  check against the packs actually opened and catch a missed mark early.

---

## 7. Player page

The 5x5 grid, marks appearing live, running score, and position.

- **"One away"** — when a square would complete a pattern, it is highlighted.
  With thirteen patterns a player can be one away on several at once; all of
  them light up. This is what turns the back half of a box from watching into
  waiting for one specific name.
- Cards are stored server-side and generated from a seed seeded by room and
  user id, so a refresh cannot reroll them and nobody can shop for a better
  card.

---

## 8. Overlay

MTGBBB adds **event types to the existing overlay feed**. It does not need a new
overlay: `js/pages/overlay.js` already queues alerts one at a time, and the
scramble panel is a working example of a persistent panel that hides itself when
idle.

- **The pull** — card image and treatment badges, big and brief.
- **"41 of 62 cards had this"** — the count of players holding the card just
  pulled. The single highest-value number in the game: it makes every pull a
  shared event, loud when almost everyone had it and loud when almost nobody
  did.
- **Bingo alerts** — the player's name on screen, straight into the existing
  alert queue.
- **Live top five**, small and persistent.
- **Pack counter**, so the box running out has a visible shape.

---

## 9. Engagement features

Additive. None of them can break scoring if they land later.

**Call your shot.** Before the first pack, each player names a mythic they think
will be pulled. A specific mythic comes out of one box about 23% of the time —
frequent enough to chase, rare enough to matter — and it is the only decision a
player makes all night.

> **Open item.** At 60 players that is roughly 14 giveaway codes per box. If the
> pools do not support that, the fix that keeps it exciting rather than merely
> capping it is to call **card *and* treatment** — "Sheoldred, foil" — or to
> tier it: right card scores points, right card and right treatment earns a code.

**Heat map.** Once the box opens, show the three cards appearing on the most
player cards, so the room has a collective rooting interest before a pack is
cracked.

**Season standings.** A leaderboard across box openings. **A season is a calendar
month**, matching the site's existing monthly leaderboards and awards so this
rides machinery that already exists rather than needing its own clock.

**Badges.** A winner badge, and season badges for the top three each month,
through the existing event badge system. A "first blackout" badge is worth
minting even though it may never be earned.

---

## 10. Namespace

| | |
|---|---|
| Pages | `games/mtgbbb/index.html`, `host.html` |
| Routes | `functions/api/mtgbbb/*` |
| Scoring | `functions/api/mtgbbb-scoring.js` (pure, no I/O, in `NON_ROUTE_MODULES`) |
| Tests | `server/scripts/test-mtgbbb.js`, wired into `npm --prefix server test` |
| Rooms | `mtgbbb_<CODE>` |
| Set cache | `mtgbbb_set_<SETCODE>` |
| Season | `lb_mtgbbb_<YYYY-MM>` |

Commander Bingo already owns `games/commander-bingo/`, `/api/bingo/*` and the
`bingo_` prefix. MTGBBB shares none of them.

**Registry prefix trap:** `mtgbbb_` would also swallow `mtgbbb_set_`. Both get
their own entry in `server/lib/registry.js` with their own tables; longest
prefix wins. This is the same shape as the `item_code_queue`-inside-`item_code_`
hack and should not be repeated.

Authorization follows Commander Bingo as corrected: a login to play, moderator
or broadcaster to run a room, and **both moderator status and being that room's
host** to award a prize.

---

## 11. Build order

1. **Scoring module and its tests.** Pure functions, no room, no session, no
   network. Everything else depends on this being right, and it is the one part
   that can be proven correct in isolation.
2. **Set data** — Scryfall fetch, cache, pool filter, the under-25 guard, the
   treatment table.
3. **Room lifecycle** — create, join, card generation, state, end.
4. **Moderator panel.**
5. **Player page**, including one-away.
6. **Overlay events.**
7. **Engagement** — call your shot, heat map, season standings, badges.

Steps 1–5 are the game. Everything after is addition.

---

## 12. Open items

- Call-your-shot reward: giveaway code volume, or the card+treatment variant.
- Collector Booster support, and the odds work it needs.
