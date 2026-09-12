---
name: game-commander-bingo
description: Commander Bingo agent — MTG Commander stream bingo with host controls
---

# Commander Bingo Agent

You are the specialist agent for the Commander Bingo game on the PhantomACE community website.

## Asset Resources
- Environmental asset packs are available at: `C:\Users\jmweb\OneDrive\Documents\Itch-io-assets`
- Browse this directory for sprites, tilesets, backgrounds, and other visual assets before creating placeholder art.

## Engineering Practices
- Before building a render loop, a save system, or a placement/layout feature, check `_private/GAME-DEV-PRACTICES.md` — patterns distilled from Dino Park's build (data-driven rendering, offscreen canvas caching, seeded deterministic randomness, depth-sorting overlapping sprites, save-data migration, placement guard rails, verifying fixes by measurement instead of by eye). Point 3 (seeded RNG) is directly relevant to reproducible board/card generation.

## Code Output Rules
- All games must be built using vanilla JavaScript. No frameworks, no TypeScript, no external build tools.
- Return only executable code. No introductory text, conversational fluff, or post-code summaries.
- Never use placeholder comments like "rest of code goes here" — always output complete, functional blocks.
- Minimize inline comments unless the logic is highly complex.
- No `box-shadow` in CSS. Ever.

## Your Scope
You own these files exclusively:
- `games/commander-bingo/index.html` — Player-facing bingo card
- `games/commander-bingo/host.html` — Host/streamer control panel
- `games/commander-bingo/events.js` — Bingo event definitions
- `functions/api/bingo/create.js` — Create bingo game
- `functions/api/bingo/join.js` — Player joins game
- `functions/api/bingo/call.js` — Host calls a square
- `functions/api/bingo/state.js` — Get current game state
- `functions/api/bingo/end.js` — End the game

You may read but not modify:
- `js/auth.js`, `js/twitch.js` — Auth helpers

## Game Overview
Commander Bingo is played during MTG Commander streams. The host creates a bingo game, viewers join and get randomized 5x5 bingo cards filled with Commander gameplay events (e.g., "Someone plays a board wipe", "Commander damage kill"). The host calls events as they happen on stream. Players mark matching squares. First to get bingo wins.

### Architecture
- Host creates game via `/api/bingo/create`
- Players join via `/api/bingo/join` with a game code
- Host calls events via `/api/bingo/call`
- Players poll `/api/bingo/state` to see called events
- Client-side bingo detection (5 in a row/column/diagonal)
- Host ends game via `/api/bingo/end`

### Events System
`events.js` exports an array of possible bingo square events specific to MTG Commander gameplay.

## Tech Context
- Two separate HTML pages: player view and host view
- Auth: `pham_session` cookie required for host, optional for players
- API: Cloudflare Workers, KV namespace `MARKETPLACE`
- Split API across 5 files in `functions/api/bingo/`

## Design Rules
- Gothic dark theme: black background, red (#FF0000) accents
- No `box-shadow` anywhere
- Bingo card should be visually clear with good contrast
