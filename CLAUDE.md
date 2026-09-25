# PhantomACE Community Website

## Project Overview
Static HTML/CSS/JS community website for Twitch broadcaster PhantomACE. Hosted on Cloudflare Pages with serverless API functions (Cloudflare Workers + KV storage). Gothic dark theme with red (#FF0000) accents on black backgrounds.

## Tech Stack
- **Frontend:** Vanilla HTML, CSS, JS (no frameworks)
- **Backend:** Cloudflare Pages Functions (`functions/api/`)
- **Storage:** Cloudflare KV (namespace: `MARKETPLACE`)
- **Auth:** Twitch OAuth via `pham_session` cookie
- **Fonts:** PHANTOMACE.otf (titles), GODOFWAR.TTF (headers), system-ui (body)
- **Dev Server:** `npx wrangler pages dev . --port 8789`

## Code Style Rules
- Return only executable code. No introductory text, conversational fluff, or post-code summaries.
- Never use placeholder comments like "rest of code goes here" — always output complete, functional blocks.
- Minimize inline comments unless the logic is highly complex.

## Design Identity — no generic "AI-template" tells
The site has a deliberate gothic identity. The rules below keep it from drifting
into the look of a default AI-generated site. They are permanent, apply to every
page AND every game, and sub-agents must follow them too.
- **Palette:** black / greys / red (`#FF0000`) / white only for the default
  (dark) theme, taken from `css/variables.css`. Never a slate or indigo "tech
  dark" (`#0b0f19`-style) background, never cyan or neon-indigo accents.
  `--purple` exists ONLY as the MTG "rare" rarity colour — never as a UI accent.
- **Theming:** the site has TWO themes driven by tokens in `css/variables.css`:
  the default **dark** (`:root`) and an opt-in **gothic light** mode
  (`:root[data-theme="light"]`) — aged parchment/bone grounds, oxblood red, ink
  text. This is a *deliberate gothic* light mode (a "grimoire on old paper"), NOT
  the generic cream/off-white "AI-template" light mode that is still banned. To
  keep it working: (1) style with the tokens (`--black`/`--gray-*` for surfaces,
  `--white`/`--text-*` for text, `--red`, `--border*`), never hardcoded hexes, so
  a surface flips with the theme; (2) text sitting on a red/accent FILL uses
  literal `#fff` (stays white in both themes — the fill is dark red in both);
  (3) the toggle + no-flash `<head>` script live in the header/each page and set
  `data-theme`; standalone games also `<link>` `variables.css`; (4) **the overlay
  is NEVER themed** (OBS legibility) — it has no toggle and no light block.
- **Rarity / medal / tier colours are the ONE sanctioned exception** to the
  black/grey/red/white palette, and only ever to signal rarity, leaderboard rank,
  or membership tier — never as general UI accents. They must come from the tokens
  in `css/variables.css`: `--rarity-uncommon` (green), `--rarity-rare` (= `--purple`),
  `--rarity-mythic` (orange), `--exclusive` (gold); `--medal-gold/-silver/-bronze`;
  `--tier-vip` (silver/white — VIP is never purple or pink). Do NOT hardcode a
  rarity hex (`#4488ff`, `#ff6600`, `#cc88ff`, `#ffd700`, …) in a stylesheet, and do
  NOT repurpose any of these as a button, tag, or category colour.
- **Fonts:** **GodOfWar** is the single gothic display face for every title and
  header (`--font-display` / `--font-gothic`); **GrimoireOfDeath** is the body face
  (`--font-ui`), with a **14px base** (`body { font-size: 14px }`). Both are owned,
  self-hosted fonts in `assets/fonts/` (GrimoireOfDeath as woff2 + ttf) — no Google Fonts
  / web-font CDN, and never Inter, Roboto, or another generic UI sans.
  `--font-system` (system-ui) remains only for utilitarian tool pages. The retired
  faces (PhantomACE / UnifrakturMaguntia / Cinzel Decorative / IM Fell English /
  Aurusenthial Gothic / Gotfridus) must not be reintroduced.
- **Keep `--font-ui` body text readable — ~14px minimum.** It is a display-weight
  face that turns to mush when tiny, so avoid going below ~13px for `--font-ui`
  text; the base is 14px. (GodOfWar headings and system-ui tool text are exempt.)
- **No `box-shadow`. Ever.** Depth comes from borders. For a glow, use
  `filter: drop-shadow()` on a NON-box element (sprite/logo/icon); to make a box
  read as "lit", brighten or thicken its border instead — do not reach for a
  shadow.
- **No coloured side-border accents. Ever. UNACCEPTABLE.** No `border-left` or
  `border-right` used as a colour rail, stripe, or divider — not red, not
  rarity/state colours, not neutral grey — on cards, panels, list rows, notes,
  the nav, page heroes, games, or the overlay. This is the "accent bar/rail"
  AI-tell and must not exist anywhere in the project. Signal rarity/state with
  text colour, a chip, or a full border instead. Allowed: full four-side box
  borders (`border:`) and `border-top`/`border-bottom`. The ONLY permitted
  left/right borders are functional rendering, never decoration (e.g. the
  chat-maze wall cells that draw the maze). The gothic corner-bracket accents
  (`.corner-accent`, the `::before/::after` corner ticks) are retired for the
  same reason — do not reintroduce them.
- **No `backdrop-filter` / `blur()` (glassmorphism / frosted glass).** Panels use a
  near-solid background (e.g. `rgba(10,10,10,0.96)`) plus a border. It is also
  per-frame GPU work that crashes the broadcaster's OBS on long streams.
- **Gradients** only as red/black gothic vignettes (see `css/pages/home.css`). No
  `bg-gradient-to-br`-style subtle background gradients, and never a gradient
  clipped onto headline text (a white→grey word fade).
- **No icon libraries** (Lucide, FontAwesome, Heroicons, Feather). Use the
  project's own sprites, Twitch emotes, or plain emoji.
- **No eyebrow kickers** — the small category label floated above a heading. Pages
  go straight to the shared `.page-hero` title. Those hero styles live in
  `css/components.css` (loaded on every page) — do not re-home them in a per-page
  stylesheet, or pages that miss it render an unstyled hero.
- **No generic hero formula** (eyebrow → bold heading → one paragraph → one filled
  + one outlined button) and no filler "feature-matrix" or "bento" grids of
  interchangeable cards. Every card and section must say something specific about
  PhantomACE, the games, or the community.
- **Copy is specific, not marketing filler.** No hollow slogans ("Boost Your
  Workflow", "Unlock Productivity", "Next-Generation…", "Seamlessly…"). Write in
  the site's casual gothic voice about real things.
- **Strip generated-image credentials.** Images made with an AI tool carry
  C2PA/XMP provenance metadata; re-encode losslessly (e.g. open + save via Pillow,
  preserving any ICC profile) to drop those chunks before committing, and don't
  commit unreferenced heavyweight source renders.

## Overlay (OBS browser source)
The stream overlay (`overlay.html`, `css/pages/overlay.css`, `js/pages/overlay*.js`)
runs inside an OBS browser source that stays open for an entire marathon stream, so
it MUST return to its exact idle state after anything happens — otherwise CEF's
GPU/compositor memory grows until OBS crashes.
- **Everything that fires must fully clear itself.** One-shot events (sub/raid/drop
  alerts, the giveaway reel, the check-in reminder) must be removed from the DOM (or
  set back to `display: none`) when done, and every `setTimeout`/`setInterval` they
  start must be cleared or self-terminating. Standing game panels (raid, Mana Clash,
  bingo, MTGBBB, maze, scramble) must hide when their game/event ends. Verified idle
  state after a fire = the stage has 0 children and every panel computes to
  `display: none`.
- **A hidden panel must reach `display: none`.** The `hidden` attribute alone is not
  enough: any author rule that sets `display` on a panel overrides the UA
  `[hidden]{display:none}`, so every panel that sets `display` needs a matching
  `.<panel>[hidden] { display: none; }` guard (see `.ov-raid`, `.ov-checkin`). Hiding
  with only `opacity`/`visibility` leaves it composited over the live capture — don't.
- **Nothing may run while hidden.** Animation/redraw loops bail immediately when
  their panel is hidden (`if (panel.hidden) return;`), and pollers back off to a slow
  idle interval — no per-frame work while nothing is shown.
- **No unbounded growth.** Rebuild lists by replacing children, never appending; do
  not retain removed nodes; reuse a single `Audio` element instead of `new Audio()`
  per fire; overwrite a small state key rather than growing one.
- **No `backdrop-filter`/blur** (also in Design Identity) — on the overlay it is the
  worst offender, re-blurring the live game capture every frame it is visible.

## Project Structure
```
├── index.html, about.html, events.html, ...   # Page shells
├── css/
│   ├── variables.css, reset.css, base.css      # Foundation
│   ├── components.css, layout.css, roles.css   # Shared
│   └── pages/*.css                             # Per-page styles
├── js/
│   ├── auth.js, twitch.js, nav.js              # Core scripts
│   ├── components.js, notifications.js         # Shared UI
│   └── pages/*.js                              # Per-page logic
├── games/
│   ├── skull-clicker/index.html
│   ├── mana-clash/index.html + assets/
│   ├── commander-bingo/index.html + host.html + events.js
│   ├── shell-shock/index.html (PhamShock)
│   ├── dino-park/index.html
│   └── memory-match/index.html
├── functions/api/                              # Cloudflare Workers
│   ├── auth/ (twitch.js, logout.js, recheck-roles.js)
│   ├── bingo/ (create, join, call, state, end)
│   ├── media/ (upload.js)
│   ├── mana-clash.js, skull-clicker.js, pham-shock.js
│   ├── inventory.js, marketplace.js, leaderboards.js
│   ├── phamily-time.js, channel-points.js, hype-train.js
│   └── twitch-status.js, twitch-schedule.js
└── assets/ (images, fonts, audio)
```

## API Pattern
All serverless functions follow this pattern:
- `getSession(request)` parses `pham_session` cookie
- `json(data, status)` helper returns JSON responses
- `onRequestGet(context)` / `onRequestPost(context)` exports
- KV keys use prefixes: `mc_room_` (Mana Clash), `ps_room_` (PhamShock), `inv_` (inventory), etc.
- Room-based multiplayer: polling pattern (client polls GET every 2s), server resolves state

## Auth Flow
Twitch OAuth → `/api/auth/twitch` → sets `pham_session` cookie with `{user_id, display_name, profile_image, roles}`. Guest fallback uses `localStorage` guest ID for game rooms.

## Web Game Best Practices
All games are internally built, so prefer **Direct DOM Integration** (injecting the canvas/game element directly into the main document) over iframe isolation to maximize performance. If an iframe is required:
- Always include `sandbox="allow-scripts"` at minimum.
- Only add `allow-pointer-lock`, `allow-same-origin`, or gamepad permissions if the game explicitly needs them.
- Never allow `allow-top-navigation` or `allow-popups` unless required for external auth.
- Implement automatic focus resolution on the parent page so keyboard controls work without requiring a click:
  ```javascript
  const gameFrame = document.querySelector('iframe');
  gameFrame.addEventListener('mouseenter', () => gameFrame.focus());
  ```
- All cross-frame data transfer (scores, save states, auth tokens) must use `postMessage` with verified origins. No direct DOM manipulation across frame boundaries.

## Agent Architecture
This project uses specialized sub-agents. The manager agent handles coordination, full updates, git operations, and the dev server. Sub-agents focus on specific domains:
- **game-skull-clicker** — Skull Clicker game
- **game-mana-clash** — Mana Clash dice game
- **game-commander-bingo** — Commander Bingo
- **game-phamshock** — PhamShock artillery game
- **game-dino-park** — Dino Park game
- **game-memory-match** — Memory Match game
- **asset-manager** — Itch.io asset pack browsing, extraction, and integration
- **twitch-bot** — Chat bot: posting drops/announcements to chat, inbound chat commands, streamer trigger panel
- **chat-system** — Community forums & chat
- **phamily-giveaway** — Phamily Time watch pass & Giveaway system
- **cosmetics** — Profile cosmetics, inventory, channel points
- **server** — Everything executed on the rig: Postgres, the self-hosted Node server, Windows
  services, the Cloudflare Tunnel, data migration runs, and cutover. Authors no application
  code — that arrives via `git pull`. See `server/MIGRATION-PLAN.md`.
