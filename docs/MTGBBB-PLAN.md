# MTGBBB — Magic: The Gathering Booster Box Bingo

**Status:** all seven build-order steps are built — the whole game plus
overlay and engagement. 989 assertions across 16 offline test files, green;
the two pages and the overlay contract have real browser verification too
(see the build order note). Remaining: a per-room winner badge needs
artwork, not code; `games.html` needs an image asset to list the game;
`server/sql/003_mtgbbb.sql` needs applying on the rig.
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
| Each treatment on a pulled card | **1** |
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

**Every treatment is worth 1 point, flat.** A frequency-ranked ladder was
considered and rejected: treatments stack, so a ladder makes one lucky pack
outweigh a completed line, and the ranking would have rested on a proxy that
cannot actually measure pull rates — Scryfall knows how many cards carry a
treatment, not how often one comes out of a pack.

What remains from that design, and still matters:

- The treatment list is **derived per set**, so only treatments genuinely
  possible in that set are offered. Serialized cards do not appear in Play
  Boosters and so will not appear at all.
- **It is derived by baseline, not by a list of known treatments.** Scryfall’s
  `frame_effects` and `promo_types` are mostly not treatments at all: `legendary`
  sits on 75 Avatar prints, `universesbeyond` tags every card in two sets, and
  Final Fantasy carries sixteen tags `ffi` through `ffxvi` on ordinary cards. So
  the deriver reads what the set’s own *plain* printings carry — black border,
  not full art, not textless, no `boosterfun` — and treats anything a plain card
  has as, by definition, not a treatment. A hardcoded ignore list would have
  rotted on the next set; this self-corrects for sets that do not exist yet.
- The list is shown to the moderator at room creation and **can be adjusted**.
- It is then **frozen into the room**. Scores must never move because an
  upstream data source changed mid-game.

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
- **Query with `unique=prints`, not `unique=cards`.** `unique=cards` returns one
  printing per card, which destroys the treatment axis — treatments exist only
  *across* printings. Fetch every print and collapse to names locally; that
  yields the pool and the treatment table from a single query.
- A set is fetched **once**, when the first room for it is created, and cached
  under `mtgbbb_set_<SETCODE>` permanently. A set's contents never change.
  **Nothing touches Scryfall during a live game.**
- The set dropdown lists `CODE — Set Name`, newest release first, restricted to
  real paper sets that actually have boosters.
- **`booster: true` is right about the pool and lies about treatments.** For the
  pool it is exact — Bloomburrow gives 60 rares and 20 mythics, correctly
  dropping six rares that exist only in starter decks and would otherwise be
  permanently unmarkable squares. For treatments it is unusable: **all 87
  Bloomburrow Booster Fun prints are flagged `booster: false`** despite
  unquestionably coming out of Play Boosters, while the same variants in Avatar
  and Lost Caverns are flagged `true`. The flag tracks the base numbered set,
  not the product. **So the pool comes from `booster: true`, and the treatment
  table from every print of a pooled name.** Step 3 must not re-derive
  treatments from the flag.
- **Scryfall cannot say which product a variant came from.** There is no
  Play-Booster-versus-Collector field, so the `collectorOnly` marking is curated
  judgement. It only decides whether a chip starts ticked in the moderator’s
  adjustable list, so a wrong guess costs a click and never a point.
- **A set with fewer than 25 rare/mythics cannot fill a card.** Room creation
  refuses it rather than building a broken grid. The guard fires on a real set
  today, but not for the reason expected: TMT has 158 prints and **zero** flagged
  in-booster, because Scryfall has not published its pack data yet. The trigger
  is **unreleased** sets, not small ones — so the refusal distinguishes the two,
  and an unplayable set is deliberately **not cached**, since caching "forever"
  would freeze that gap for a set that will be fine next week.
- Images: read `image_uris`, falling back to `card_faces[0].image_uris`. Both
  occur — adventure and split cards keep one top-level image while transform
  and modal cards split theirs — so reading only one blanks a chunk of the grid.

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

**Call your shot — press your luck.** Each player names a mythic they think will
be pulled, and chooses how specific to be. The more they commit to, the better
the giveaway code:

| The call | Reward | Roughly |
|---|---|---|
| Card | Common code | ~23% per box |
| Card + foil | Uncommon code | ~5% |
| Card + foil + a named treatment | Rare code | ~1–2% |

**All or nothing.** Call a borderless foil, watch it come out plain foil, and
you get nothing — that is what makes it a wager rather than a guess. This is
the only decision a player makes all night, so it should cost something.

Two rules that keep it honest:

- The picker only offers combinations that **actually exist in that set**.
  Nobody wagers a rare code on a printing that was never possible.
- A late joiner **can** still call a shot, but only on cards not yet pulled, and
  it counts forward only. Retroactive credit would make arriving late a
  guaranteed win. Fewer packs remain, so a late shot is strictly worse — which
  is fair, and self-balancing.

> **Watch the volume.** At 60 players a common-tier call lands ~14 codes per
> box. Pressing up thins that out, but the safe play is still the common one.

**Heat map.** Once the box opens, show the three cards appearing on the most
player cards, so the room has a collective rooting interest before a pack is
cracked.

**Season standings.** ~~A leaderboard across box openings, `lb_mtgbbb_<YYYY-MM>`.~~
**Built, but not as a per-month key** — that shape was this document guessing
at what "the site's existing monthly leaderboards and awards" actually look
like, and it guessed wrong. The real system (`functions/api/leaderboards.js`)
keeps exactly ONE rolling board per game — `lb_bingo`, `lb_mana_clash`, and now
`lb_mtgbbb` — and on the last day of the month pays the top 3 and wipes it back
to empty (`maybeRunMonthlyAwards()`). There is no per-month key anywhere in
that system, for any game. `end.js` writes every player's best session score
into `lb_mtgbbb` the same way `mana-clash.js` writes `lb_mana_clash`; the rest
— the monthly reset, the top-3 whisper, the badge — is two map entries in
`leaderboards.js` (`BOARDS`, `MONTHLY_GAME_LABELS`) and needed no new code at
all.

**Badges.** ~~A winner badge, and season badges for the top three each month,
through the existing event badge system.~~ **Half already covered, half is not
code.** The season top-3 badges are automatic now that MTGBBB is in
`leaderboards.js` — `maybeRunMonthlyAwards()` mints one via `createItemCode()`
for every registered game, MTGBBB included. A per-room **winner** badge is a
different thing, and turns out not to be a code path anywhere in this project:
every existing event badge (Agate Hunt, Dino Park Beta) is hand-minted by a
human running `server/scripts/mint-badge-code.js --badge <id> --confirm` on
the rig, against real artwork the script refuses to run without. There is
nothing here for an agent to wire up automatically — award.js already lets a
host hand out any prize tier to anyone; a badge on top of that is an art asset
plus a `mint-badge-code.js` entry, both blocked on artwork. Flagged in the
open items below rather than invented.

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
| Live room pointer | `mtgbbb_current` (exact singleton — set on create, cleared on end, read by the overlay) |
| Season board | `lb_mtgbbb` (exact singleton — see step 9; NOT `lb_mtgbbb_<YYYY-MM>`) |

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

1. ~~**Scoring module and its tests.**~~ **Done.** `functions/api/mtgbbb-scoring.js`
   and `server/scripts/test-mtgbbb.js` — 77 assertions, wired into
   `npm --prefix server test`.
2. ~~**Set data.**~~ **Done.** `functions/api/mtgbbb-scryfall.js`,
   `functions/api/mtgbbb/sets.js`, `server/sql/003_mtgbbb.sql`, and
   `server/scripts/test-mtgbbb-sets.js` — 154 assertions against captured
   fixtures, so the suite runs offline and never hammers a free service.
3. ~~**Room lifecycle.**~~ **Done.** `functions/api/mtgbbb/{create,join,mark,
   state,end,award}.js`. Authorization is deliberately NOT Commander Bingo's
   shape: create/mark/end are moderator-or-broadcaster (any of them, not only
   the room's creator — a mod's panel dying mid-box must not lock the game),
   award is moderator AND that room's host, exactly like bingo. Scoring is
   computed live in state.js from mtgbbb-scoring's pure functions on every
   poll, never stored, so there is exactly one place it can be wrong. The
   pool and treatment table are snapshotted into the room at creation rather
   than read live from the mtgbbb_set_ cache, so a future DATA_VERSION bump
   can never change cards out from under a game in progress.
   `server/scripts/test-mtgbbb-rooms.js` — 67 assertions, offline (a stubbed
   `fetch` throws on any call, so a set code escaping the KV cache fails
   loudly instead of hitting Scryfall).
4. ~~**Moderator panel.**~~ **Done, browser-verified** (against a mocked
   `fetch` — see the note on step 3's testing limits below). `games/mtgbbb/host.html`,
   now including the call-your-shot toggle and cap at room creation.
5. ~~**Player page**, including one-away.~~ **Done, browser-verified.**
   `games/mtgbbb/index.html`, now including a call-your-shot panel.
6. ~~**Overlay events.**~~ **Done, split as planned.** The server half
   (this agent): `mark.js` pushes one `mtgbbb-pull` event per pull (card,
   treatment labels, how many player cards hold it, room size) and one
   `mtgbbb-bingo` event per pattern newly completed, diffed before/after per
   player inside the same mutate() that records the pull — a blackout emits
   once, not once-plus-fourteen. `mtgbbb_current` is the pointer the overlay
   polls via `GET /api/mtgbbb/state?current=1`; verified live, end to end,
   against the manager's actual `overlay-mtgbbb.js` panel in a real browser
   (screenshot: room appeared with correct set name, pack count and player
   count within one poll of creation, no manual wiring). The rendering half
   (manager): `js/pages/overlay.js`, `js/pages/overlay-mtgbbb.js`,
   `overlay.html`, `css/pages/overlay.css`.
7. ~~**Engagement**~~ **Done: call-your-shot and heat map are new code;
   season standings and the season-badge half of badges ride existing
   machinery (see step 9's corrected write-up). The per-room winner badge is
   an art/ops task, not code — see open items.**
   - `functions/api/mtgbbb/shot.js` — set a shot. Off by default per room,
     with an optional cap, both chosen at creation. One shot per player,
     mythics only, refused on a card already pulled (uniformly, not just for
     late joiners — see the file's header for why the plan's late-joiner
     framing was really a general rule in disguise).
   - Resolution lives in `mark.js`, not `shot.js`: a shot can only resolve
     against a pull, and `mark.js` already holds the room's lock at the
     moment one is recorded. All-or-nothing against that one pull's own
     treatments. A win pulls a code from the same tiered pool chat drops use
     (`pullGiveawayCode`) and hands it back through `state.js`'s `you.shot` —
     no chat race, since the winner is already known.
   - Heat map: `hottest()` (already existed in mtgbbb-scoring.js) surfaced
     as `heatMap` in `state.js`. No UI built for it yet — see open items.
   - `server/scripts/test-mtgbbb-engagement.js` — 43 assertions, offline.

Steps 1–7 are all built now. `npm --prefix server test` is 989 assertions
across 16 files, green.

**Testing note carried over from steps 3-5, now resolved for `wrangler pages
dev` itself but not for everything it can reach.** The `node:crypto` boot
failure (`functions/api/milestones.js` → `server/lib/eventsub.js`, no
`nodejs_compat`) is fixed — the manager's step 6 commit moved eventsub.js to
Web Crypto. `wrangler pages dev` now boots and served live, real traffic for
create.js, sets.js, and `state.js?current=1` during this step, confirmed
against the real Scryfall API and a real (if local) KV binding. **What it
still cannot exercise is `env.MARKETPLACE.mutate()` and
`env.MARKETPLACE.pullGiveawayCode()`** — both are Postgres-DAL-only
extensions (`server/lib/kv.js`) with no equivalent on an actual Cloudflare KV
namespace, so every mutate-based route 500s under `wrangler pages dev`,
`bingo/award.js` included — this is not new and not MTGBBB's. `join.js`,
`mark.js`, `end.js`, `award.js` and `shot.js` were verified through the 989-
assertion offline suite and, for the two UI pages, by intercepting `fetch`
with realistic response shapes and driving the real page code (search,
select, mark, undo, pack +/-, end, award, call-a-shot, all three shot
outcomes) — genuine DOM and interaction coverage, just not through the real
mutate-backed server. A true end-to-end pass needs either a fix to the first
gap (flagged separately, task_8b31b0bb) or the self-hosted rig with
`003_mtgbbb.sql` applied.

---

## 12. Open items

- **Call-your-shot code volume** is still the user's call, not resolved —
  it now has a room-level off switch and cap, chosen at creation, so the
  volume question is a setting rather than a code change.
- **A per-room winner badge has no art and needs none of this agent's code**
  to exist once it does — see step 9. Suggested: `mtgbbb-winner`, rare or
  mythic rarity to taste, minted by the broadcaster per game the same way
  Agate Hunt was, registered in `server/scripts/mint-badge-code.js` once the
  artwork lands in `assets/badges/`.
- **`server/sql/003_mtgbbb.sql` must be applied on the rig** before any MTGBBB
  route is hit on the self-hosted server. It is idempotent. `lb_mtgbbb` and
  `mtgbbb_current` need no new table — both are ordinary rows in the
  `singletons` table 001_schema.sql already creates.
- Collector Booster support, and the odds work it needs.
- **No heat-map UI yet.** `state.js` returns `heatMap` (top 3 pulled-most
  cards by player-card count); nothing on host.html, index.html or the
  overlay displays it. A reasonable next stop for whoever picks up polish.
- **`games.html` does not list MTGBBB yet.** Every other game gets a card
  there via `launchGame(title, path)` plus an `/assets/images/game-*.png`.
  Not done here — it needs an actual image asset, which is outside this
  agent's scope (asset-manager's, or whoever supplies game art).
- **`wrangler pages dev` still cannot exercise a mutate-based route** —
  `env.MARKETPLACE.mutate()` and `.pullGiveawayCode()` exist only in the
  Postgres DAL (`server/lib/kv.js`), not on a real Cloudflare KV namespace,
  so `join`/`mark`/`end`/`award`/`shot` all 500 under local Cloudflare Pages
  dev. `bingo/award.js` has the identical gap already — not new, not
  MTGBBB's. Worth its own fix (a local KV-compatible `mutate`/
  `pullGiveawayCode` shim) if local end-to-end testing under Cloudflare Pages
  dev needs to work for any mutate-based game, but not attempted here since
  it is infrastructure well outside this feature's scope. See step 11's note
  for exactly what this session verified instead.
