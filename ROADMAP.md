# PhantomACE — Expansion Roadmap

Everything "fix" from the Oct 2 site audit is shipped (Fix now → Before Nov 1 →
Next up → Quick wins). This roadmap covers the remaining **Ideas** tier: 16 new
features, grouped into four epics. Community engagement is first by choice; the
rest follow in dependency order.

## How we build (applies to every epic)
- **Rig is production.** Deploy = `git pull` on the rig (+ `nssm restart phantomace-web`
  for `server/**` or `functions/**` changes; static-only changes need no restart).
- **Parallel sub-agents, manager commits.** Agents EDIT FILES ONLY; the manager owns
  git, `server/lib/registry.js`, `functions/api/leaderboards.js`, `server/index.js`,
  and `server/package.json`. One commit + test group per sub-feature.
- **Every new exact KV key / prefix → `server/lib/registry.js`** or the route 500s.
  A handler-less file under `functions/` → `NON_ROUTE_MODULES` in `server/router.js`.
  Contended writes use `env.MARKETPLACE.mutate(key, fn)`.
- **Design identity is permanent** (see CLAUDE.md): gothic black/grey/red/white, no
  box-shadow, no side-border accent rails, no backdrop-filter, no icon libraries,
  GodOfWar display + Grenze body. The overlay is never themed and must return to a
  fully idle state after anything fires.
- **Tests per group** under `server/scripts/test-*.js` (node, no framework), wired
  into `npm test`; full suite green before each push.
- **Month boundaries are Pacific** via `functions/api/season-time.js`.

## Recommended overall sequence
A light **season manifest** (slice of Rewards #6) → **Community** (C1–C4) →
**Rewards** (#6 full, #7, #8) → **Overlay** (#3 → #1 → #5 → #2) →
**Stream interactivity** (#10 → #9 → #11 → #12). `#4` (ad holds) stays parked until
the broadcaster grants `channel:read:ads`.

---

## Epic C — Community engagement (FIRST)

### C0. Season item manifest (foundation slice, ~S)
The Grimoire needs to know "what items belong to month X's set." Rather than block on
the full season registry (Epic B #6), extract just the month→item-set mapping now.
- Build `functions/api/season-manifest.js` (NON_ROUTE library) exporting
  `setForMonth(monthKey) → [{type, name, theme, slot}]`, derived from the existing
  per-month reward tables (`phamily-time.js` / `phamily-rewards.js` theme tables) plus
  `KNOWN_THEMES` in `js/cosmetic-variants.js`.
- This becomes the seam the full #6 registry later implements behind the same export,
  so C1 doesn't get rewritten.

### C1. Seasonal Grimoire (#13, ~M)
A collection log on each profile: a page per month showing owned vs missing items from
that month's set; completing a set grants a set badge.
- **Read** `inv_<userId>` items (cosmetics), bucket by month/theme using `setForMonth`.
  Owned = inventory item matching the set entry by type+name (Memory Match already
  resolves cosmetics by name — reuse that rule). Missing = set entry with no match.
- **Set-badge grant**: when every entry in a month's set is owned, grant a
  `grimoire-<monthKey>` set badge via the inventory grant path (idempotent, inside
  `mutate(inv_...)` like other grants). Record completion so it isn't re-granted.
- **Surface**: a Grimoire section on the profile page (`profile.js` already returns
  collection counts — extend to per-month sets) + a `/api/grimoire?u=<login>` read.
- New KV: none required (sets derived; set-badge is an inventory item). Possibly a
  small `grimoire_<userId>` completion marker if we don't want to re-scan — decide at
  build time; register if added.
- Depends on C0.

### C2. Phamily Quests (#15, ~M)
Weekly, server-checked quests that pay giveaway entries or pass minutes, announced via
the notification bell.
- Add `weekKey(d)` to `season-time.js` (Pacific ISO week) — there is no week helper today.
- **Quest defs**: a small per-week manifest (visit 3 rooms, welcome a new member,
  finish Memory Match in ≤N moves, etc.). Progress per user at `quest_<userId>_<weekKey>`.
- **Verification is server-side**, hooked into the actions that already run: room
  visits (C3 browse), Memory Match result (`functions/api/memory-match.js` recordResult),
  forum welcome post, etc. Pay via `addEntries` (giveaway ledger) or pass minutes
  (phamily-time), inside `mutate`.
- **Announce** completion through the existing forum notification path
  (`functions/api/forum/notifications.js` + `js/notifications.js`).
- New KV: `quest_` prefix (per-user-per-week) → register. Reuse `addEntries`.
- Depends on C0 (reuses the manifest pattern) and benefits from C3 (room-visit quest).

### C3. Room Crawl (#14, ~M)
Browse other people's dino-park rooms, leave guestbook stamps, Room of the Week on stream.
- **Browse**: a read-only, sanitized public room endpoint over `dino_park_<id>.state`
  (echo the room layout the way `profile.js` echoes the favorite dino — already
  sanitized on save). A gallery page listing opted-in rooms.
- **Guestbook**: `roomguestbook_<ownerId>` — a bounded list (replace-children, cap ~50),
  one stamp per visitor, written via `mutate`. Register the prefix.
- **Room of the Week**: a `room_of_week` singleton the broadcaster sets; shown on the
  overlay/stream. October: a haunted-room contest (just a tagged entry list).
- Feeds C2's "visit 3 rooms" quest (a visit = a verified GET from a logged-in user).
- New KV: `roomguestbook_`, `room_of_week` → register.

### C4. Forum & member basics (#16, ~L — split into sub-groups)
The forum stack already exists (`functions/api/forum/*`: categories, threads, thread,
post, comments, mentions, moderate, notifications, queries, rules, authors). This is
breadth, so build it in independent slices, each its own commit + test:
- **Reading**: thread search, follow-a-thread (notify on reply), unread markers.
- **Posting**: quote replies, reactions (bounded emote set).
- **Moderation**: restore bin (soft-delete already exists — add undelete) + mod log.
- **Profiles**: bio + links (stored on `profile_`), a public member directory.
- **Gifting**: transfer a *duplicate* monthly cosmetic to another user (atomic
  two-inventory `mutate`; only dupes, never the last copy — mirrors the marketplace
  claim pattern).
- New KV: thread-follow + reaction prefixes → register. Reuse `authorsFor`, inventory
  grant/transfer patterns.

---

## Epic B — Rewards foundation

### #6 One season registry (~M, foundation)
Single month-keyed module (theme, rewards, titles, dice, computed room-drip index) that
both the server tables and the page read from — replacing the drift-guarded mirror in
`phamily-time.js` ↔ `phamily-rewards.js`. Implement `setForMonth` (C0) fully here; the
page fetches tables from the server instead of keeping a copy. Makes each new month pure
data entry and removes a whole bug class.

### #7 Auto-credit entries + stream-streak rewards (~M)
Credit giveaway entries as pass levels are reached (not on manual claim), so "added
automatically" is true; add 3/5/10-stream-streak bonuses using existing check-in streak
data. Reuse `addEntries`, the check-in streak records.

### #8 Pass preview / history / past winners (~S–M)
Locked "next month" tab, "past seasons" earned-view, a stored winners table to fill the
"Past Winners: Coming Soon" block, and owned-duplicate → "+N entries" so base months
still pay. New KV: a winners table (likely the existing monthly-winner records — confirm).

---

## Epic A — Overlay / leave Streamlabs

### #3 One overlay state snapshot (~M, foundation)
One record for current prediction, hype-train progress, ad countdown and goals, returned
with each overlay poll. Fixes the stuck-prediction panel and restore-on-reload, and gives
the hype bar / goal meters one source. Everything else in this epic reads from it.

### #1 Resub alerts + alert sounds (~M, highest visible value)
Subscribe `channel.subscription.message` (resubs currently show nothing) and add sound to
sub/raid/follow/cheer alerts. The explicit "biggest gap for leaving Streamlabs." Reuse the
single-reused-Audio-element pattern already used for the check-in chime; keep overlay
marathon-safe (clear everything after each fire).

### #5 Replay buttons, hype bar, wheel redemption (~S)
Replay button per activity-feed row, a hype-train progress bar (reads #3), and wiring the
spin-the-wheel channel-point reward to the wheel (today it only queues).

### #2 Custom alert media (~L, ~3–4 days)
Private alerts namespace accepting audio; per-alert config (image, sound, volume, text
template, duration, thresholds); bounded reused Audio pool on the overlay; an upload card
per alert type on the dashboard. `media-store.js` already does most of the storage work.

### #4 Hold drops during ad breaks — PARKED
Pause drops/reveals during ads, "ads incoming" 60s ahead, welcome-back nudge after. The ad
state is already computed but nothing reads it. **Dormant until the broadcaster grants
`channel:read:ads`.**

---

## Epic D — Stream interactivity (pulls in non-site viewers)

### #10 One "what's on stream" pointer (~M, foundation)
Replace the separate bingo / MTGBBB / maze / scramble pointers with one that expires on
inactivity, plus a light overlay payload. Fixes several picker / polling / never-stopping
issues at once and underpins #9 and #11.

### #9 !bingo verified in chat (~S–M)
Server already knows every card and call. A viewer types `!bingo`; the server verifies and
the overlay shows "VERIFIED BINGO"; the host gets a claim list to award from. Reuse the
bingo state + bot command path.

### #11 Chat fights the raid boss (~M)
Chatters strike with `!hit` / emotes, rate-limited per account server-side (the skull-raid
per-striker + per-IP bucket work from the Next-up tier is the template), with chat damage
vs site damage shown on the overlay.

### #12 Stream-night modes (~L, menu of smaller builds)
Skull Clicker "Bone Tithe" community goal on the overlay; Streamer-vs-Chat Mana Clash via
`!clash`; a PhamShock artillery night with chat changing the wind; a Memory Match daily
seed (also stops cheating); Dino Park "Stream Safari" wild spawns + Park of the Week. Pick
individually; each is its own group.

---

## Cross-cutting dependencies & risks
- **C0 season manifest** unblocks the Grimoire now and is finished by Rewards #6 later —
  same export, so no rework.
- **#4 ad holds** is blocked on broadcaster OAuth (`channel:read:ads`); build last.
- **Gifting (C4) and chat-raid (#11)** reuse existing atomic patterns (marketplace claim,
  skull-raid rate limits) — low novelty, mostly wiring.
- Each epic is multiple commit/test groups; none is a single PR.
