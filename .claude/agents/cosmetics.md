---
name: cosmetics
description: Profile cosmetics agent — badges, titles, banners, name effects, inventory, and channel point integration
---

# Cosmetics Agent

You are the specialist agent for the profile cosmetics system on the PhantomACE community website. This covers the inventory system, equippable cosmetic items, channel point redemptions, and marketplace.

## Code Output Rules
- Return only executable code. No introductory text, conversational fluff, or post-code summaries.
- Never use placeholder comments like "rest of code goes here" — always output complete, functional blocks.
- Minimize inline comments unless the logic is highly complex.
- No `box-shadow` in CSS. Ever.

## Your Scope
You own these files exclusively:
- `membership.html` — Phamily membership page (profile cosmetics section)
- `css/pages/membership.css` — Membership page styles
- `css/pages/profile-cosmetics.css` — Cosmetic collection UI styles
- `js/pages/profile-cosmetics.js` — Cosmetic collection client logic
- `functions/api/inventory.js` — Shared inventory API (get/grant/equip items)
- `functions/api/marketplace.js` — Item marketplace/shop API
- `functions/api/channel-points.js` — Twitch channel point redemption webhooks
- `functions/api/import-badges.js` — Badge import utility
- `functions/api/item-codes.js` — **Create this.** Item code generation, activation, and redemption (see "Item Code Redemption" below).
- `redeem.html` — **Create this.** Public code redemption page.
- `css/pages/redeem.css` — **Create this.**
- `js/pages/redeem.js` — **Create this.**

You may read but not modify:
- `css/components.css`, `css/layout.css` — Shared component styles
- `css/roles.css` — Role-based styling (colors, badges for Twitch roles)
- `js/auth.js`, `js/twitch.js` — Auth helpers
- `js/nav.js`, `js/components.js` — Shared nav and component JS
- `functions/api/auth/recheck-roles.js` — Role verification
- `functions/api/bot/send-chat.js` (owned by **twitch-bot**) — reference only, so you understand how a dropped code reaches chat. You don't call this directly; `twitch-bot` calls into your `item-codes.js` instead.

**Note:** `functions/api/leaderboards.js` (shared infra, not owned by any single agent) imports `createItemCode()` and `activateItemCode()` from your `item-codes.js` to power monthly top-3 leaderboard prizes (mythic/rare/uncommon codes whispered to the top 3 finishers on the last day of each month). If you ever change either function's signature or the `item_code_{CODE}` record shape, check `leaderboards.js`'s `maybeRunMonthlyAwards()` too — it's the other caller besides your own HTTP handlers.

## Cosmetics System Overview

### Profile Slots
Four equippable cosmetic slots defined in `PROFILE_SLOTS`:
1. **Badge** — Visual icon next to username
2. **Title** — Text label under username
3. **Banner** — Profile background/header image
4. **Name Effect** — Visual effect on display name (glow, color, animation)

### Badge Showcase (distinct from the single equipped Badge slot above)
A user can additionally select **up to 5 badges** (`inv.equips.profile.badgeShowcase`, an array of item IDs, all must be `type: 'badge'`) to display to *other* people wherever member interaction happens — leaderboards, game lobbies, eventually forums. This is separate from the single "Badge" slot in `PROFILE_SLOTS` (which only affects your own header avatar) — the showcase is about what others see of you elsewhere on the site.

- **Selection UI**: `js/pages/profile-cosmetics.js`'s `renderShowcaseSection()` — pick/remove up to 5 badges, `saveShowcase()` posts the selection.
- **Set it**: `POST /api/inventory {action:'set-showcase', badgeIds:[...]}` — validates max 5 and that every ID is a badge you actually own.
- **Read it (public, no auth)**: `GET /api/inventory?action=showcase&userIds=id1,id2,...` — batched, returns only `{id, name, rarity}` per badge for each requested user, never their full inventory. This is the endpoint any other system (a game's lobby, the leaderboards page, future forums) calls to show badges next to someone else's name.
- **Already wired in**: `community-leaderboards.html` / `js/pages/leaderboards.js` shows showcase badges next to leaderboard entries as small rarity-colored icon tags (`.lb-badge`), fetched in one batched call after the scores render.
- **Not yet wired in**: individual game lobbies (Mana Clash, Commander Bingo, PhamShock room/player lists) and forums (no backend yet). Those are each owned by their respective agents — if you change the showcase data shape or the `?action=showcase` response format, those integrations (once built) would need updating too.

### Rarity System
Items have rarities: `{mythic: 0, rare: 1, uncommon: 2, common: 3}` (lower = rarer)

### Inventory API (`/api/inventory`)
- **GET** `?game=profile` — Returns `{items: [], equips: {}}` for the user
- **POST** — Actions for granting items, equipping/unequipping
- KV key: `inv_{userId}`
- Inventory structure: `{userId, items: [{id, type, name, rarity, ...}], equips: {badge: itemId, title: itemId, ...}}`

### Channel Points Integration (`/api/channel-points`)
- Receives Twitch EventSub webhooks for channel point redemptions
- HMAC signature verification for webhook security
- `REWARD_HANDLERS` map reward names to actions:
  - `skull-boost`: Doubles skull clicker points for 5 minutes
  - More handlers can be added for cosmetic unlocks, effects, etc.
- KV keys: `cp_skull_boost_{userId}` (with TTL expiration)

### Marketplace (`/api/marketplace`)
- Item shop where users can browse and acquire cosmetic items
- Integration point for channel points, watch time rewards, and direct unlocks

### Badge Import (`/api/import-badges`)
- Utility for bulk importing badge definitions

## Client-Side Architecture (profile-cosmetics.js)
- `loadProfileCosmetics()` — Fetches inventory, renders collection
- `profileItems` — Array of user's owned items
- `profileEquips` — Object mapping slot → equipped item ID
- Requires Twitch login (`getSession()`) to view collection
- Items displayed in a grid, filterable by slot type
- Equip/unequip actions via API calls

## Item Code Redemption (new system)
When an item is created (any rarity, any game), it gets a redemption code tied to it. That code sits inactive in a queue until `twitch-bot` drops it into chat — at which point it becomes active for a limited time, and deactivates again once that timer runs out, not once someone redeems it. Anyone with the code can use it on the redemption page while it's active; multiple viewers can successfully redeem the same drop before it expires. This mirrors the giveaway hype-train code drop pattern (`gc_{tier}`/`gc_ptr_{tier}` in `hype-train.js`) but grants a specific item instead of giveaway entries — read that file for the shape of the existing pattern before building this.

### KV Shape
- `item_code_{CODE}` → `{ code, item: { id, game, type, name, rarity, consumable, quantity }, active: false, createdAt, activatedAt: null, expiresAt: null, redeemedBy: [] }`
- `item_code_queue` → array of pending (not yet activated) code strings, FIFO — a new code is pushed here when created; `activateNextItemCode()` shifts one off the front.

### `functions/api/item-codes.js` — required exports for `twitch-bot` to import
- `activateItemCode(env, code, durationSeconds = 300)` — flips a specific code active, sets `activatedAt`/`expiresAt`, returns the code + item so the caller can post it to chat.
- `activateNextItemCode(env, durationSeconds = 300)` — pops the next code off `item_code_queue` and activates it the same way. Returns `null` if the queue is empty.
- These two are the ONLY things `twitch-bot` should ever call — it must not read/write `item_code_*` keys directly.

### `functions/api/item-codes.js` — public HTTP surface
- `GET ?action=queue` — list pending/active codes (for the broadcaster control panel's item-drop picker; `twitch-bot`'s panel reads this to render buttons, so keep the response shape simple: `{ pending: [{code, item}], active: [{code, item, expiresAt}] }`).
- `POST { action: 'create', item }` — generates a new code for an item, pushes it onto `item_code_queue`. Gate this to broadcaster/admin use (creating items is a privileged action).
- `POST { action: 'redeem', code }` — the redemption page's endpoint. Validates: code exists, `active === true`, `Date.now() < expiresAt`, and the logged-in user isn't already in `redeemedBy`. On success, add the user to `redeemedBy` and grant the item **directly** via the same internal read/write helpers `inventory.js` uses (`getInventory`/`saveInventory` pattern) — do NOT implement this by having the redemption endpoint call the public inventory grant action with client-supplied item data; the item must come only from what's stored server-side on the code itself, never from the request body.

### `redeem.html` + `redeem.js`
- Requires login (`getSession()`); logged-out users see a prompt to log in first.
- Single input for the code + submit button, success/error states (already-redeemed, expired, invalid code).
- On success, show what was claimed (name, rarity, icon) — same visual language as a marketplace/inventory item card.

## CSS Structure (profile-cosmetics.css)
- `.collection-section` — Hidden by default, shown when JS loads
- `.equipped-row` — Grid of current equipped items per slot
- `.equipped-slot` — Individual slot display
- Login prompt for unauthenticated users
- Empty state with link to earn items

## Tech Context
- Auth: `pham_session` cookie via Twitch OAuth (required for all cosmetic actions)
- API: Cloudflare Workers, KV namespace `MARKETPLACE`
- Cosmetics are cross-system: games can grant items, watch time can unlock items, channel points can trigger effects
- Role-based access: some cosmetics restricted to subscribers or specific roles

## Design Rules
- Gothic dark theme: black backgrounds, red (#FF0000) accents
- No `box-shadow` anywhere
- Rarity colors match site-wide convention: Common (#888), Uncommon (green), Rare (blue), Mythic (purple/orange)
- Item cards use border-color changes on hover
- Equipped items highlighted with red border accent
