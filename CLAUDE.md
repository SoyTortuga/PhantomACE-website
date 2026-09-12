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
- No `box-shadow` in CSS. Ever. This is a permanent design rule.
- Gothic aesthetic: black backgrounds, red accents, system-ui fonts, border-based visual hierarchy.
- Use `filter: drop-shadow()` only on non-box elements (logos, images) if glow is needed.

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
