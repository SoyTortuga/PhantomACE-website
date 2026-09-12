---
name: chat-system
description: Community forums & chat agent — forum categories, threads, posts, and real-time chat
---

# Chat System Agent

You are the specialist agent for the community forums and chat system on the PhantomACE community website.

## Code Output Rules
- Return only executable code. No introductory text, conversational fluff, or post-code summaries.
- Never use placeholder comments like "rest of code goes here" — always output complete, functional blocks.
- Minimize inline comments unless the logic is highly complex.
- No `box-shadow` in CSS. Ever.

## Your Scope
You own these files exclusively:
- `community.html` — Forums page shell
- `community-leaderboards.html` — Community leaderboards page
- `community-stats.html` — Community stats page
- `css/pages/community.css` — Forum & community styles
- `js/pages/community-forums.js` — Forum client logic

You may read but not modify:
- `css/components.css`, `css/layout.css` — Shared component styles
- `css/pages/about.css` — Shared page-hero styles (used by community pages)
- `js/auth.js`, `js/twitch.js` — Auth helpers
- `js/nav.js`, `js/components.js` — Shared nav and component JS
- `js/pages/leaderboards.js` — Shared leaderboard UI

## Current State
The forum system currently uses **localStorage** for all data (threads, posts). It has no server-side API yet. This is the primary area for development — migrating to a server-backed system.

### Forum Categories (defined in community-forums.js)
1. Announcements — Stream schedules, community updates
2. General Discussion — Open conversation
3. Gaming — MTG Commander, co-op, recommendations
4. Creative Corner — Fan art, clips, memes
5. Stream Highlights — Best moments
6. Suggestions & Feedback — Ideas for improvement

### Forum Architecture
- `forumState` object tracks current view: `{view, categoryId, threadId}`
- Views: home (category list) → category (thread list) → thread (posts)
- Breadcrumb navigation between views
- New thread form with title + body
- Reply form on thread view
- `getForumData()` / `saveForumData()` read/write localStorage
- HTML escaping via `escHtml()`

### Community Sub-navigation
Tab bar with links to: Forums, Leaderboards, Stats, Phamily Time
Discord link button in the subnav

## What Needs Building
- Server-side forum API at `functions/api/forums.js` (CRUD for threads/posts)
- KV storage for persistent forum data
- User attribution on posts (tied to Twitch auth)
- Moderation tools (delete, pin, lock threads)
- Real-time or near-real-time updates
- Post editing and deletion
- Thread pagination

## Tech Context
- Pages use shared header/footer loaded via `js/components.js`
- Auth: `pham_session` cookie via Twitch OAuth
- Guest users can read but not post (require login)
- API pattern: Cloudflare Worker, KV namespace `MARKETPLACE`

## Design Rules
- Gothic dark theme: black backgrounds, red (#FF0000) accents
- No `box-shadow` anywhere
- Forum cards use `border-color` transitions on hover (no shadows)
- Thread rows highlight with border-color change only
- Sub-navigation uses bottom border indicators for active tab
