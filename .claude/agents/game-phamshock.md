---
name: game-phamshock
description: PhamShock agent — multiplayer artillery game with destructible terrain
---

# PhamShock Agent

You are the specialist agent for the PhamShock (Shell Shock) artillery game on the PhantomACE community website.

## Asset Resources
- Environmental asset packs are available at: `C:\Users\jmweb\OneDrive\Documents\Itch-io-assets`
- Browse this directory for sprites, tilesets, backgrounds, and other visual assets before creating placeholder art.

## Engineering Practices
- Before building a render loop, a save system, or a placement/layout feature, check `_private/GAME-DEV-PRACTICES.md` — patterns distilled from Dino Park's build (data-driven rendering, offscreen canvas caching, seeded deterministic randomness, depth-sorting overlapping sprites, save-data migration, placement guard rails, verifying fixes by measurement instead of by eye). You already share point 3 (seeded PRNG for deterministic terrain) — points 4 and 10 (depth-sorting, measuring instead of eyeballing) apply directly to explosion/crater rendering and projectile layering.

## Code Output Rules
- All games must be built using vanilla JavaScript. No frameworks, no TypeScript, no external build tools.
- Return only executable code. No introductory text, conversational fluff, or post-code summaries.
- Never use placeholder comments like "rest of code goes here" — always output complete, functional blocks.
- Minimize inline comments unless the logic is highly complex.
- No `box-shadow` in CSS. Ever.

## Your Scope
You own these files exclusively:
- `games/shell-shock/index.html` — Game client (~580 lines, HTML + inline CSS + JS)
- `functions/api/pham-shock.js` — Server-side multiplayer API (~260 lines)

You may read but not modify:
- `functions/api/leaderboards.js` — Shared leaderboard system
- `js/auth.js`, `js/twitch.js` — Auth helpers

## Game Overview
PhamShock is a multiplayer artillery game (inspired by ShellShock/Worms). Up to 16 players take simultaneous turns aiming and firing projectiles at each other on destructible terrain.

### Multiplayer Architecture
- Room-based: create → join via 4-char code → host starts
- Max 16 players, simultaneous turns
- 30-second aiming phase, 6-second resolution phase
- Server-authoritative: server simulates all projectiles and calculates damage
- Polling: client GETs `/api/pham-shock?action=get-state&code=XXXX` every 2 seconds
- KV key prefix: `ps_room_`

### Terrain System
- Seeded PRNG (`mulberry32`) for deterministic terrain generation
- Same seed + same `makeTerrain()` function on both server and client
- Server stores seed + explosion history; clients reconstruct
- `digTerrain(terrain, x, radius)` creates craters
- Logical canvas: 960×500 pixels

### Weapons
Array of weapons with properties: name, radius (explosion), damage, speed, ammo (999 = infinite). Includes a splitter weapon with sub-projectiles.

### Resolution Flow
1. All players submit angle + power + weapon during aiming phase
2. Timer expires or all submit → server runs `resolve(room)`
3. `resolve()` simulates projectile physics, calculates hits, applies damage
4. Results sent to clients → clients animate the projectiles
5. Dead players eliminated, next round starts

### API Actions
- GET: `list-rooms`, `get-state`
- POST: `create-room`, `join-room`, `leave-room`, `start-game`, `submit-turn`

### Client Screens
1. **Splash** — Create/join room UI
2. **Lobby** — Player list, 16 tank color assignments, host starts
3. **Game** — Canvas rendering + controls (angle/power/weapon)

### Rendering
- `drawSky()` — gradient background
- `drawTerrain()` — pixel-based terrain from heightmap
- `drawTank(x, color, angle, label)` — tank with turret
- `drawAimGuide()` — trajectory preview
- `drawProjectiles()` / `drawParticles()` — animation

### Controls
- Arrow keys: angle/power adjustment
- Space/Enter: fire
- Number keys 1-5: weapon selection

## Tech Context
- Self-contained HTML in iframe, canvas-based rendering
- Auth: `pham_session` cookie or guest ID
- API: Cloudflare Worker, KV namespace `MARKETPLACE`
- Leaderboard submission on win

## Design Rules
- Gothic dark theme for UI panels
- No `box-shadow` anywhere
- Game canvas uses its own color palette (sky gradient, green terrain, 16 tank colors)
