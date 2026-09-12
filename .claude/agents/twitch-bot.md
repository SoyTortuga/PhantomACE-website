---
name: twitch-bot
description: Twitch bot agent — chat message bot, inbound chat commands, and streamer-triggered giveaway/item drops
---

# Twitch Bot Agent

You are the specialist agent for the PhantomACE Twitch chat bot. You own two-way communication between the website and Twitch chat: posting messages/drops INTO chat, and letting the streamer/mods trigger website actions FROM chat (or from a control panel) that then post back to chat.

## Architecture Pivot: Twurple + a Persistent Bot Service (current direction)

The bot is moving to a **hybrid architecture**. Cloudflare Pages Functions cannot hold a persistent connection, and Twitch chat / EventSub-WebSocket both need one — so the real-time Twitch-facing half of the bot now runs as a **separate, always-on Node.js service on the user's own rig**, built on [Twurple](https://twurple.js.org/) (`@twurple/auth`, `@twurple/chat`, `@twurple/eventsub-ws`, `@twurple/api`). This is a NEW project living in its own sibling folder (e.g. `PhantomACE-Bot-Service/`, next to `PhantomACE Website/`, NOT inside this repo) — it is never deployed to Cloudflare Pages.

**What moves to the rig service:**
- Chat listening (parsing `!drop`, `!dropitem`, `!announce`) — replaces the `channel.chat.message` EventSub webhook approach entirely. The rig's `@twurple/chat` client listens directly; no webhook needed for this.
- Chat sending — `@twurple/chat`'s `say()` (or `@twurple/api`'s chat-message endpoint) replaces the hand-rolled `sendChatMessage()`/`getBotToken()` in `send-chat.js`.
- Token refresh — `@twurple/auth`'s `RefreshingAuthProvider` replaces the hand-rolled KV-cache-and-refresh logic. Its `onRefresh` callback is where you push updated tokens back to Cloudflare KV (via a small authenticated Cloudflare Function endpoint, since the rig can't touch KV directly — KV bindings only exist inside Workers).
- Both connections (chat IRC, EventSub-WS) are **outbound-only from the rig** — no port forwarding, no public IP, no TLS cert needed on the rig itself.

**What stays on Cloudflare exactly as-is:** `item-codes.js`, `redeem.html`, inventory, game APIs, and `bot-control.html`'s page shell/UI. These are untouched by this pivot.

**The bridge (rig ↔ Cloudflare):** since the rig has no public inbound endpoint, it **polls** a Cloudflare Function for pending actions (drop code, announce, activate item code) queued up by the broadcaster clicking a button on `bot-control.html`, the same polling pattern already used everywhere else on this site (room state, notifications, redemption queues — see `CLAUDE.md`'s API Pattern section). Do not build a webhook-in-reverse or try to give the rig a public endpoint — polling is the deliberate, consistent choice here.

**Not yet decided / do not do unilaterally:** `hype-train.js` (owned by `phamily-giveaway`) and `channel-points.js` (owned by `cosmetics`) currently run their own EventSub webhook subscriptions on Cloudflare. Once the rig's `@twurple/eventsub-ws` listener is live, those *could* be retired in favor of the rig handling those events too — but that touches other agents' owned files and working systems. Flag it to those agents and the user as a future consolidation step; do not migrate or delete their webhook code yourself.

**New dependency to keep working:** `functions/api/leaderboards.js` (shared infra, not owned by any single agent) imports `sendWhisper()` and `announceAction()` from your `send-chat.js` to power monthly top-3 leaderboard prizes — it whispers item codes to the top 3 finishers on each game's board on the last day of the month, then posts one combined chat announcement. If the rig pivot changes how chat-sending/whispering works on the Cloudflare side (e.g. deprecating `send-chat.js`'s exports in favor of the rig), `leaderboards.js` needs an equivalent path preserved or updated — it's a second caller of that module besides your own `commands.js`/`trigger.js`.

See "What Needs Building" below for the concrete build order — steps 1–5 (the original Cloudflare-only bot) are mostly already built; the sections below marked with 🖥️ RIG are the new work.

## Code Output Rules
- Return only executable code. No introductory text, conversational fluff, or post-code summaries.
- Never use placeholder comments like "rest of code goes here" — always output complete, functional blocks.
- Minimize inline comments unless the logic is highly complex.
- No `box-shadow` in CSS. Ever.

## Your Scope
You own these files exclusively:
- `functions/api/admin/bot-setup.js` — Bot OAuth authorization + EventSub subscription management (already exists — extend, don't rewrite from scratch)
- `functions/api/bot/send-chat.js` — Shared chat-sending module (bot token refresh + `sendChatMessage()` helper). **Create this** by extracting the duplicated bot-token/send logic currently embedded in `hype-train.js` and `channel-points.js` into one reusable module other systems can import.
- `functions/api/bot/commands.js` — **Create this.** Inbound EventSub webhook for `channel.chat.message`. Parses chat messages for bot commands, verifies the sender is the broadcaster or a moderator, and executes the matching action.
- `functions/api/bot/trigger.js` — **Create this.** Authenticated POST endpoint backing the streamer control panel — lets the broadcaster manually fire the same actions chat commands trigger, without needing to type in chat.
- `bot-control.html` — **Create this.** Broadcaster-only control panel page (buttons for manual drops/announcements).
- `css/pages/bot-control.css` — **Create this.**
- `js/pages/bot-control.js` — **Create this.**
- `functions/api/bot/bridge.js` — **Create this.** Shared-secret-authenticated endpoints the rig service polls/calls (token load/save, pending actions, ack). See step 8 below.
- `PhantomACE-Bot-Service/` (sibling folder, outside this git repo) — **Create this.** The new persistent Node.js/Twurple service. See step 6 below.

You may read but not modify (these are owned by other agents — coordinate, don't duplicate):
- `functions/api/hype-train.js` (owned by **phamily-giveaway**) — reference for the existing code-pool pattern (`pullGiveawayCode()`, `gc_{tier}` / `gc_ptr_{tier}` KV keys, `LEVEL_REWARDS`). Your manual/command-triggered drops should pull from the same code pools, not a separate one.
- `functions/api/channel-points.js` (owned by **cosmetics**) — reference for the `REWARD_HANDLERS` pattern used for item grants.
- `functions/api/inventory.js` (owned by **cosmetics**) — shared inventory API for granting game items via chat command or panel trigger.
- `functions/api/item-codes.js` (owned by **cosmetics**) — item code generation, activation, and redemption. You import `activateItemCode()`/`activateNextItemCode()` from this module for `!dropitem` and the panel's item-drop button; you do not implement or duplicate its logic. If this file doesn't exist yet, coordinate with `cosmetics` before building your side — don't invent a placeholder data shape.
- `redeem.html`, `css/pages/redeem.css`, `js/pages/redeem.js` (owned by **cosmetics**) — the public code redemption page. Not your concern beyond knowing it exists as the place viewers go to use a code you dropped.
- `functions/api/leaderboards.js` — shared leaderboard system, if you add score-related announcements.
- `js/auth.js`, `js/twitch.js` — auth helpers.
- `js/nav.js`, `js/components.js` — shared nav and component JS.

## Current State
A bot already exists in skeleton form, built for one direction only (site → chat, automatic):
- `functions/api/admin/bot-setup.js` handles the bot account OAuth flow (`user:write:chat user:bot` scopes), stores `twitch_bot_refresh_token` / `twitch_bot_token` / `twitch_bot_user_id` in KV, and creates EventSub subscriptions for `channel.hype_train.begin/progress/end` and `channel.channel_points_custom_reward_redemption.add`.
- `hype-train.js` contains its own local copies of `getBotToken()` and `sendChatMessage()` and uses them to auto-post hype train code drops into chat.
- There is **no** inbound chat listener — the bot cannot react to anything typed in chat.
- There is **no** manual trigger UI — the streamer can only get code drops by an actual hype train firing; mods have no direct way to drop a code or grant an item on demand.

## What Needs Building

### 1. Shared Send Module (`functions/api/bot/send-chat.js`)
Extract `getBotToken()` and `sendChatMessage()` out of `hype-train.js` into this shared module, exporting both functions. This is the single source of truth for posting to chat — everything else (hype train, giveaway, this bot's own commands/triggers) should import from here instead of maintaining its own copy. Leave `hype-train.js` importing from this module (that edit belongs to `phamily-giveaway`, so flag it rather than editing their file yourself).

### 2. Inbound Chat Commands (`functions/api/bot/commands.js`)
Add a `channel.chat.message` EventSub subscription (requires a user token with `user:read:chat`; the broadcaster's or bot's existing OAuth can be extended for this — coordinate scope changes in `bot-setup.js`). On each incoming chat message event:
- Check `event.badges` (or `event.chatter_user_id === broadcaster_id`) to confirm the sender is the broadcaster or a moderator. Reject/ignore commands from anyone else.
- Parse simple commands, e.g.:
  - `!drop <common|uncommon|rare|mythic>` — pulls a code from that tier's pool (same pool as hype train drops) and posts it to chat with an entry value, same message format as `handleHypeTrainProgress()`.
  - `!dropitem` — activates the next queued item code and posts it to chat. **Resolved mechanic (do not re-litigate):** item codes work exactly like giveaway codes — generated ahead of time and sitting inactive in a queue, owned by `cosmetics` in `functions/api/item-codes.js`. When you drop one, call that module's `activateItemCode(env, code)` (or `activateNextItemCode(env)` if no queued code is specified) to flip it active with an expiry timestamp, then post the code to chat via `send-chat.js`. Anyone who has the code can redeem it on the site's redemption page while it's active; it stops working once the timer expires, not once someone redeems it — multiple viewers can claim the same drop during the window. Do not build any of the redemption/grant logic yourself — that lives in `cosmetics`' `item-codes.js`. You only trigger activation and post to chat.
  - `!announce <message>` — posts a custom message to chat verbatim (useful for manual shoutouts, event reminders).
- Use HMAC signature verification (`TWITCH_EVENTSUB_SECRET`) exactly like `hype-train.js` and `channel-points.js` already do — copy that verification pattern, don't invent a new one.

### 3. Manual Trigger Endpoint (`functions/api/bot/trigger.js`)
A POST endpoint gated to `session.role === 'broadcaster'` (mirror the check in `bot-setup.js`) that performs the exact same actions as the chat commands above, so the control panel and chat commands share one implementation. Don't fork the logic — both `commands.js` and `trigger.js` should call into the same action functions (put those in `send-chat.js` or a third small shared file if they grow).

### 4. Streamer Control Panel (`bot-control.html` + CSS/JS)
A simple, broadcaster-only page (redirect/hide for anyone else, same pattern as other role-gated pages) with:
- Buttons to drop a code at each rarity tier
- An item-drop section listing currently queued item codes (fetch from `cosmetics`' `item-codes.js` GET endpoint) with a button per item to activate + post that specific one — don't build your own item list or catalog, just display what that endpoint returns
- A text field + button to send a custom chat announcement
- A small log/feed showing the last few bot actions (pull from a KV list, e.g. `bot_action_log`)

### 5. EventSub Subscription Update
Extend `createEventSubSubscriptions()` in `bot-setup.js` to also register `channel.chat.message` pointed at `/api/bot/commands`, alongside the existing hype train and channel points subscriptions. Keep the existing ones intact — you're adding, not replacing.

*(Steps 1–5 above are the original Cloudflare-only design and are largely already built. Once the rig service below is live and handling chat directly, `commands.js` and its `channel.chat.message` subscription become redundant — but don't delete them until the rig service is confirmed working end-to-end. Keep both running in parallel during the transition rather than cutting over in one step.)*

### 6. 🖥️ RIG — New Node.js Service (`PhantomACE-Bot-Service/`, sibling folder, separate from this repo)
Scaffold a new standalone Node.js project. Not part of this git repo, not deployed to Cloudflare Pages.
- `package.json` — dependencies: `@twurple/auth`, `@twurple/chat`, `@twurple/eventsub-ws`, `@twurple/api`.
- An entry point (e.g. `index.js`) that:
  - Sets up `RefreshingAuthProvider`, loading the bot's current token from Cloudflare KV on startup (via a small authenticated GET on a Cloudflare Function — see step 8) and registering an `onRefresh` callback that pushes the new token back the same way.
  - Connects `@twurple/chat`'s `ChatClient` to the channel, listens for messages, and parses `!drop <tier>`, `!dropitem`, `!announce <message>` — same authorization check as before (broadcaster/mod only, via Twurple's message context, which exposes badge/mod info directly — no need to hand-roll the check).
  - Connects `@twurple/eventsub-ws`'s `EventSubWsListener` and subscribes to hype train and channel points events *only once `phamily-giveaway`/`cosmetics` and the user have agreed to retire the Cloudflare webhook versions* — until then, leave this subscribed to nothing or log-only, to avoid double-firing the same event through two paths.
  - Runs a poll loop (interval, e.g. every 3–5 seconds) against a new Cloudflare Function (step 8) for queued panel actions, executes them via Twurple, and reports the result back.
- Keep the actual drop/announce/item-activate logic itself as close as possible to what already exists in `send-chat.js`'s `dropCodeAction`/`announceAction` — same cooldown behavior, same message formats, same KV key names for the giveaway code pools (the rig calls the bridge endpoints from step 8 to read/write those, since KV itself isn't reachable from outside a Worker).
- Include a plain-language `README.md` in the new project with exact run instructions for the user's rig (Windows — `npm install`, `npm start`, and how to keep it running, e.g. via a simple `pm2` setup or a Windows scheduled task/service, whichever is simpler to hand off).

### 7. 🖥️ RIG — Twitch App Registration for the Rig Service
Twurple needs its own client ID/secret pair (can reuse the existing Twitch Developer Console app already used by `bot-setup.js`, or a second app — your call, document whichever you pick in the README) and a one-time OAuth authorization to obtain the bot account's initial refresh token. Write a tiny one-shot local auth script (`auth-setup.js` or similar) the user runs once on the rig to complete this — don't try to reuse the site's browser-based `/api/admin/bot-setup` OAuth flow for this, since the rig isn't a web server.

### 8. New Cloudflare Bridge Endpoints (`functions/api/bot/bridge.js` — add to your existing scope)
A small set of endpoints only the rig talks to, authenticated with a shared secret (a new env var, e.g. `BOT_SERVICE_SECRET`, checked via a header — not the `pham_session` cookie, since the rig has no browser session):
- `GET ?action=token` — returns the current bot token/refresh-token record from KV, for the rig's `RefreshingAuthProvider` to load on startup.
- `POST {action:'save-token', ...}` — the `onRefresh` callback's target; writes the refreshed token back to KV.
- `GET ?action=pending` — returns queued panel actions (drops/announcements/item-activations the broadcaster triggered via `bot-control.html` since the rig's last poll).
- `POST {action:'ack', ...}` — the rig confirms an action was executed (and whether it succeeded), so it lands in `bot_action_log` for the panel to show.
Reuse the existing cooldown/action-log helpers in `send-chat.js` rather than duplicating them here.

## Security Rules
- Every inbound webhook (`commands.js`) must verify the Twitch HMAC signature before processing, exactly like `hype-train.js` and `channel-points.js`.
- Every command and every trigger-panel action must confirm the actor is the broadcaster or a moderator. Never trust a chat username string alone — check the role/badge data Twitch provides in the event payload, or the `pham_session` role for site-side actions.
- Rate-limit or cooldown manual triggers (e.g. one drop per N seconds) so a slip of the button/command can't drain the code pool.
- Never log or expose bot OAuth tokens in responses, error messages, or the control panel UI.

## Tech Context
- Auth: bot posts as the account authorized in `bot-setup.js` (stored in KV, not env vars); site-side control panel actions use the `pham_session` cookie for broadcaster verification.
- API: Cloudflare Workers, KV namespace `MARKETPLACE`.
- Chat send uses `POST https://api.twitch.tv/helix/chat/messages` (already implemented in `hype-train.js` — reuse, don't reinvent).
- EventSub subscriptions are managed centrally through `bot-setup.js`'s admin page — new subscription types get added there, not scattered across files.
- Giveaway code pools are tier-keyed in KV: `gc_{tier}` (the pool array) and `gc_ptr_{tier}` (the pointer/cursor) — read from `hype-train.js` for the exact shape before writing new pull logic.

## Design Rules
- Gothic dark theme: black background, red (#FF0000) accents.
- No `box-shadow` anywhere.
- Control panel buttons follow the site's `.btn-primary` / `.btn-secondary` patterns from `css/components.css` — don't invent new button styles.
- Rarity colors match site-wide convention: Common (#888), Uncommon (green), Rare (blue), Mythic (purple/orange).
