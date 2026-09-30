# Overlay Dashboard & Stream Tools — plan

A dedicated, broadcaster/mod-gated **Overlay Dashboard** (`overlay-dashboard.html`)
that consolidates everything overlay-related into one focused control surface,
plus new stream-enhancement tools. Overlay-only controls **move** out of Bot
Control (they are not duplicated). Built piece by piece; this doc is the living
reference. Every overlay-facing piece must obey the marathon-safety rules in
CLAUDE.md (self-clearing, hide to `display:none`, no per-frame work while hidden,
no `box-shadow`/`backdrop-filter`).

## Locked decisions
1. **Predictions** — the overlay panel (show/test) lives on the Overlay Dashboard;
   create / lock / resolve / cancel stay on Bot Control.
2. **Giveaways** — draws stay on Bot Control; add a **"Replay last reveal"** button
   on the Overlay Dashboard (re-pushes the last giveaway/monthly reel).
3. **Admin side** — rename **Mod Toolbox → "Admin Dashboard"** (`functions/api/admin/toolbox.js`),
   dedicated nav link, cards grouped by access level, **all visible but role-gated**
   (broadcaster-only cards render locked for mods rather than hidden).
4. **Test-alert suite** — a button to fire EVERY overlay alert/event type for
   preview/positioning.
5. **Scramble / Maze / MTGBBB** — net-new **manual start/stop + show/hide** buttons
   on the Overlay Dashboard (no manual controls exist today; they are chat/host driven).
6. **Live alerts bar** — mirror the alert/event log on the dashboard, **timestamped**,
   so the broadcaster never misses one.
7. **Streamlabs** — SPLIT. Migrate all **Twitch-native** alerts into our overlay so
   they run through our single alert queue and stop fighting Streamlabs for screen
   space; keep **tips/donations on Streamlabs** (those need the Streamlabs Socket
   API and can stay there). No bulk export exists, so existing media is provided by
   the broadcaster and rebuilt as our alert variants.

## Access / gating
Same staff gate as Bot Control (`isModerator` / broadcaster via the dashboard
endpoint). Reached via a dedicated nav link (and a `/overlay-dashboard` route).
Broadcaster + mods; broadcaster-only actions gated within.

## Inventory — what the Overlay Dashboard holds
**Status bar:** live timestamped alert bar; "on screen now" (active panels); a
🚨 **Clear Overlay** panic button; Reload overlays [move]; OBS source URL [move].
**Alerts & sound:** alert volume [move]; dino-hatch sounds [move]; self-reload
interval [new]; **test-alert suite** [new].
**Layout:** preset switcher [move]; link to the layout editor [move].
**Standing panels (show/hide + trigger):** Mana Clash [move], Commander Bingo
[move], Skull Raid Boss [move], Pham Check-In reminder + manual nudge [move],
Prediction panel (show/test) [move-overlay-part], Scramble / Maze / MTGBBB
[new manual controls].
**Giveaway:** Replay last reveal [new] (draws stay on Bot Control).

## Existing alert/event types (baseline for the test suite + Streamlabs)
sub, giftsub, raid, hype-level, drop, dino-hatch, giveaway-spin, prediction,
pham-checkin, bingo-call, bingo-win, mtgbbb-pull, mtgbbb-bingo (+ scramble, maze
panels). EventSub today: subscribe, subscription.gift, raid, hype_train, bits.use.
**Missing for a Streamlabs replacement:** channel.follow, channel.cheer alerts,
per-alert customizable media, tips (stay on Streamlabs).

## Phases (piece by piece)
1. **Dashboard shell + move** — the gated page, nav link, relocate the overlay
   controls out of Bot Control, timestamped live-alert bar, panic Clear Overlay.
   ("on screen now" live panel state may follow in a later pass if it needs
   overlay→server reporting.)
2. **Test-alert suite** (all types) + **giveaway Replay** + **prediction panel** migration.
3. **Manual game controls** — Scramble / Maze / MTGBBB start-stop / show-hide.
4. **Admin Dashboard** — rename Mod Toolbox, dedicated link, role-gated all-visible cards.
5. **Customizable Wheel** — broadcaster-defined segments/weights/colors, spun on the
   overlay via the marathon-safe reveal engine (a dormant `spin-the-wheel`
   channel-point handler already exists to wire to).
6. **Streamlabs replacement (Twitch-native)** — add follow + cheer alerts, make all
   alerts customizable (sound + image/GIF + text template + duration), media
   uploader; tips remain on Streamlabs.
7. **Grab-bag** — goal meters, Starting-Soon/BRB timers, on-screen `!vote` poll,
   emote cannon, Now/Next ticker.

## Notes
- Deploys: functions/** or server/** changes need `nssm restart phantomace-web`
  on the rig; static changes are pull + refresh. See DEPLOY-NOTES.md.
- Any new handler-less file under `functions/` MUST be declared in
  `NON_ROUTE_MODULES` (server/router.js) or the rig boot crashes.
