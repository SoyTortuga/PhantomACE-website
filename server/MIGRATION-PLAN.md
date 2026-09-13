# Migrate PhantomACE off Cloudflare Pages to self-hosted Node + Postgres

## CURRENT STATUS

| Phase | State |
|---|---|
| 0 — prevent irreversible loss | **Done.** See "Phase 0 results" below |
| 1 — scaffold `server/` | **Done.** Own ESM package, deps installed |
| 2 — leaf libraries | **Code written, untested against a live database.** `lib/{db,kv,registry,value,eventsub}.js`. eventsub has 8 passing tests; registry verified against a real 47-key production dump |
| 3 — adapter, router, static | **Done and verified.** 18/18 URL behaviours identical to production Cloudflare, 0 mismatches, plus 3 deliberate blocks. 31 routes mounted. Full static site serves |
| 4 — schema | **SQL written** (`sql/001_schema.sql`), not yet applied anywhere |
| 5 — migration rehearsal | **Scripts written** (`scripts/{dump-kv,load-kv,verify-migration}.js`). dump-kv has been run successfully against production |
| 6 — validate on dev.phantomace.tv | Not started |
| 7 — Postgres-native rewrites | Not started |
| 8 / 9 — cutover, follow-ups | Not started |

**Next task, and it belongs to the rig** (the dev machine has no Postgres):

1. `psql ... -d phantomace-tv-dev -f server/sql/001_schema.sql`
2. Exercise `lib/kv.js` against it with fixtures. **Test the string-vs-json
   `get()` distinction first** — `get(key)` must return a JSON *string* and
   `get(key,'json')` an object. All five bingo files, the `gc_ptr_*` cursor
   reads and `twitch_bot_user_id` depend on it, so a mistake there breaks
   several things simultaneously and confusingly.
3. Then a dump/load/verify rehearsal into `phantomace-tv-dev`.

**Note on production data:** it is growing. A dump on 2026-09-12 found 35
keys; a few hours later, 47 — including 8 `dino_park_*` saves that did not
exist before, because the Dino Park cloud-save feature went live. Re-dump at
cutover; do not reuse an old dump.

**CONFIRMED against the Helix API: there are ZERO EventSub subscriptions.**
(`GET /helix/eventsub/subscriptions` → `total: 0`.) This was previously only
inferred from the absence of an `eventsub_subscriptions` key. Two consequences:

1. **The cutover's EventSub risk is gone.** The 409 trap, the re-registration
   worry, the "record a baseline and re-verify after the flip" step, and the
   need for a delete path during the window are all moot — nothing is
   registered to break or re-point. Cutover step 1 and step 9 can be skipped.
2. **The bot / hype train / channel points subsystem is built but has never
   been switched on in production.** No subscriptions and no bot OAuth tokens
   means hype train drops, channel-point redemptions, chat commands
   (`!drop`, `!announce`) and channel-point giveaway entries have never fired.
   This is unrelated to the migration and worth fixing separately, by
   completing the steps in `_private/BROADCASTER-SETUP-STEPS.txt` — which is
   now safe to do, since the 1101 crash that blocked it was fixed and the
   panel has `list-eventsub` / `delete-eventsub` recovery actions.

## Context

The site's entire backend runs as Cloudflare Pages Functions with Cloudflare KV as the only
data store. We hit the free tier's daily KV write limit during normal testing, which surfaced
a bigger question: the site owner wants to match the architecture of OnlySands.tv (a proven
reference built by the owner's mentor) — **one Node.js process on the rig serving both the
static site and the API, backed by Postgres.**

The rig is already most of the way there: Postgres 18 is installed with two empty databases
(`phantomace-tv`, `phantomace-tv-dev`), `cloudflared` runs as a Windows service already
tunneling `dev.phantomace.tv` → `localhost:8789`, and Node/npm/git/wrangler are installed.

**The domain does not change.** `phantomace.tv` stays on Cloudflare for DNS, TLS, and CDN;
only its routing target moves from Pages to the tunnel. This is why EventSub subscriptions
need no re-registration.

### Decisions already made by the owner
1. **Full match of the reference architecture** — one Node process serves static + API. No Pages.
2. **Data modeling: mirror KV shapes in JSONB columns**, not a normalized redesign.
3. **Cutover: build in parallel, validate on `dev.phantomace.tv`, then one single cutover.**

### Scale
31 route files under `functions/`, 183 `env.MARKETPLACE.*` call sites, ~40 distinct KV key
patterns. Frontend needs **zero** changes — every API call is already a relative same-origin path.

---

## Three findings that shape the design

**1. Node 24 already has every Web API these handlers use.** `Request`, `Response`, `Headers`,
`FormData`, `URL`, `fetch`, `crypto.subtle`, `crypto.randomUUID` are all real globals. We need
a ~120-line **adapter** (`IncomingMessage → Request`, `Response → ServerResponse`), not a
compatibility shim. The 31 handlers keep their `(context) => Response` signature unchanged.

**2. One env var closes five hazards with zero handler edits.** Only two files read
`url.origin` (`functions/api/auth/twitch.js`, `functions/api/admin/bot-setup.js`, 10 sites).
If the adapter builds `new Request(PUBLIC_ORIGIN + req.url, …)`, then OAuth `redirect_uri`,
all 6 EventSub callback registrations, post-login redirects, the 3 `Response.redirect` calls,
and the protocol-conditional cookie `Secure` flag all become correct with no code changes.

**3. Using no framework makes the EventSub raw-body hazard disappear by construction.** The
four webhook routes HMAC the raw request body; any global JSON body-parser would consume the
stream and silently 403 every Twitch webhook. With `node:http` + adapter, the body is a lazy
stream nothing touches until a handler calls `.text()`. There is no parser to exclude routes from.

---

## Server architecture

**No framework.** `node:http` + adapter + `send` (static) + `pg`. Also `dotenv`, matching the
`PhantomACE-Bot-Service` precedent. Not Express/Fastify/TypeScript/ORM/bundler/Redis.

Rationale: the KV→Postgres swap is the irreducible change. Adding a request/response rewrite
across 31 files with no test suite doubles the blast radius for no functional gain. And
`(Request) => Response` is the modern portable interface (Deno/Bun/Hono/Vercel all use it),
so this isn't technical debt — `@hono/node-server` can replace the adapter later if wanted.

### Layout
New `server/` directory with **its own `package.json`** containing `"type": "module"` — this
cleanly solves the ESM/CJS conflict (root `package.json` stays CJS-default so the existing
CommonJS `demo-server.js` keeps working; the handlers are already valid ESM).

```
server/
  package.json          { "type": "module" }, deps: pg send dotenv
  .env                  (gitignored) 8 secrets + DATABASE_URL + PUBLIC_ORIGIN
  index.js              boot, env validation, pool, route table, reaper
  adapter.js            toWebRequest() / writeWebResponse()
  router.js             route table built from functions/**
  static.js             allowlist, clean-URL 308s, 404.html, security headers
  lib/db.js             pool + boot retry
  lib/kv.js             kv_get/put/delete/list + prefix→table registry + kv_mutate
  lib/eventsub.js       verifyEventSub() — replaces 4 duplicated copies
  sql/001_schema.sql, sql/002_seed.sql
  scripts/              dump-kv.js load-kv.js verify-migration.js probe-pages-urls.js
```

**Handlers stay in `functions/`** — moving them destroys git blame and makes the diff unreadable.

### Routing
Route table built at boot by walking `functions/**/*.js`; path = file path minus `functions`
and `.js`; register `onRequestGet`/`onRequestPost`.

- **`functions/api/bot/send-chat.js` must be excluded by explicit name**, not by "has no
  handler export." It's a library with 11 exports and 7 importers. Use an explicit
  `NON_ROUTE_MODULES` set, and assert at boot that every discovered module either exports a
  handler or is in that set — so a future library file under `functions/` fails the boot loudly
  instead of silently publishing bot tokens.
- One dynamic route, hardcoded: `/cdn/media/` prefix-match → `params = { path: rest.split('/') }`
  (`functions/cdn/media/[[path]].js` is the only Cloudflare catch-all in the project).
- No CORS/OPTIONS — all frontend fetches are same-origin relative.
- `Cache-Control: no-store` on all `/api/*` responses.

### Static serving — allowlist, with a boot assertion
**This is the highest-severity item.** `wrangler.toml` sets `pages_build_output_dir = "."`, so
the repo root is the web root today, and `.assetsignore` is the *only* thing keeping
`_private/giveaway-codes/*.txt` (real redeemable codes), broadcaster setup docs, and `.dev.vars`
off the internet. `.assetsignore` is a Cloudflare-only mechanism and becomes inert in Node.

Allowlist only — never a denylist:
```
STATIC_DIRS = ['assets', 'css', 'js', 'games']     # recursive
ROOT_FILES  = every *.html at repo root, enumerated at boot
```
Resolver: strip query → `decodeURIComponent` in try/catch (Dino Park tile filenames contain
spaces) → reject `\0`, `..`, backslash, and any path segment starting with `.` or `_` (the `_`
rule covers `.assetsignore`'s `/games/dino-park/_*` entries with one broader rule) → verify
containment via `path.relative` → match allowlist. **A folder added tomorrow is private by default.**

**Boot assertion** (~8 lines, do not skip): run the resolver against paths that must be
unreachable and `process.exit(1)` if any resolves — `/_private/giveaway-codes/common_bonus_codes.txt`,
`/_private/BROADCASTER-SETUP-STEPS.txt`, `/.dev.vars`, `/functions/api/bot/send-chat.js`,
`/server/.env`, `/package.json`, `/games/dino-park/_build-atlas.js`.

### Clean-URL parity — measure, don't reconstruct
Pages 308-redirects `/foo.html` → `/foo` and serves extensionless. Every internal link uses
the `.html` form, and `js/auth.js:28` captures `location.pathname` (the post-redirect
extensionless form) into a `return_to` param that becomes the post-login `Location`. **If Node
serves `.html` but 404s extensionless, every login lands on a 404.** Also `js/nav.js:20`
compares `href === '/' + page + '.html'`, so hrefs must stay `.html` — they cannot be modernized.

`scripts/probe-pages-urls.js` captures live production behavior in Phase 0 (extensionless vs
`.html`, query preservation, directory trailing slashes, `404.html` body, `_private` 404s) and
the Node handler reproduces that table exactly. Baseline expectation: extensionless canonical,
308 from `.html` preserving query. **`demo-server.js` does the opposite and is not a reference.**

### Headers and EventSub
Port `_headers`' `/*` security block and `/games/*` CSP `frame-ancestors 'self'`. **Do not port
the `/api/*` block** (`Cache-Control: public, max-age=60`) — it's almost certainly a no-op today
(Pages `_headers` applies to static assets, not Function responses), and implementing it
faithfully would newly break 2-second multiplayer polling and cache per-user authenticated
responses. Confirm with `curl -sI https://phantomace.tv/api/twitch-status` in Phase 0.

Extract `lib/eventsub.js` to replace the 4 byte-identical `verifySignature` copies
(`hype-train.js` is the canonical version), with three changes: **fail closed** (missing secret
→ 500, never skip — today `if (secret)` means a missing `TWITCH_EVENTSUB_SECRET` makes four
endpoints accept unsigned POSTs), `crypto.timingSafeEqual`, and a 10-minute replay window.
Validate all 8 secrets at boot and refuse to start if any is missing.

---

## Postgres schema

### Uniform shape, one table per key-prefix family (~25 tables)
```sql
CREATE TABLE <family> (
  key        text PRIMARY KEY,   -- FULL original KV key, verbatim
  value      jsonb NOT NULL,
  expires_at timestamptz,        -- NULL = never
  updated_at timestamptz NOT NULL DEFAULT now()
);
```
The verbatim key as PK is what makes the data-access layer a drop-in and lets all 183 call
sites keep their key templates. Per-family tables (rather than one giant `kv` table) turn
prefix `list()` into a cheap whole-table scan, fix the 1000-key `list()` cap at all 5 sites,
and incidentally fix the `item_code_queue`-inside-`item_code_`-prefix hack that
`functions/api/item-codes.js` currently needs a hardcoded skip for.

Families: `inventories`, `phamily_months`, `phamily_alltime`, `dino_parks`, `earnings`,
`cp_queues`, `cp_skull_boosts`, `listings`, `item_codes`, `bingo_rooms`, `mc_rooms`, `ps_rooms`,
`monthly_awards`, `giveaway_codes`, `singletons` (~28 single-keyed docs), and **`oauth_tokens`
split out deliberately** — it holds live Twitch access/refresh tokens, so backups can exclude
it (`pg_dump --exclude-table=oauth_tokens`) and the sensitivity is visible in the schema.

Written as explicit DDL in `sql/001_schema.sql`, not loop-generated — this is a file you read
under pressure. Numbered `.sql` files applied via `psql`; no migration framework.

### Two expiry semantics, handled differently
**(a) TTL is the business rule, the row must disappear** — `cp_queues`, `listings`,
`bingo_rooms`, `mc_rooms`, `ps_rooms`, and the `giveaway_*`/`hype_train_*` singleton rows.
Correctness comes from a **read-time filter** (`kv_get`/`kv_list` always append
`AND (expires_at IS NULL OR expires_at > now())`) so it never depends on a background job.
A 60-second in-process reaper `DELETE`s expired rows for disk hygiene only.

**(b) TTL was hygiene; an in-value timestamp is the real rule** — `cp_skull_boosts.expiresAt`,
`bot_cooldown_*.at`, `twitch_live_cache.checkedAt`, `item_codes.expiresAt`, all
`oauth_tokens.expiresAt`. `expires_at` stays NULL, handler logic unchanged, no mechanism needed.
(`item_codes` rows must persist so the UI can say "already redeemed" rather than "invalid".)

**Two deliberate improvements:** drop the 60-day TTL on `pt_{userId}_{YYYY-MM}` (the
grace-period logic *requires* the prior month's row to exist — a correctness requirement should
not rest on a hygiene TTL) and the 30-day TTL on `earnings_{userId}` (its only current effect is
that a seller who doesn't log in for 30 days silently loses their coins).

### Four families that get redesigned rather than mirrored
- **`market_index` → deleted.** `functions/api/marketplace.js` contains ~100 lines
  (`MarketError`, `readIndex`, `mutateIndex` with UUID-token pseudo-CAS and randomized backoff,
  `waitUntil` stale sweeps) existing solely to work around KV's missing transactions and
  eventually-consistent `list()`. All of it deletes. `listings` gets generated columns
  (`seller_user_id`, `listed_at`) with indexes; browse becomes one `ORDER BY listed_at DESC`
  query; **buy becomes `DELETE FROM listings WHERE key=$1 RETURNING value`** — that single
  statement is the atomic claim that kills the double-sell race; the 10-listing cap uses
  `pg_advisory_xact_lock`.
- **`gc_{tier}` + `gc_ptr_{tier}` → normalized `giveaway_codes` table.** The array-plus-cursor
  design races and can hand the same redeemable code to two users. Claiming becomes
  `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED) RETURNING code`, making double-issuance
  structurally impossible. Blast radius is small: `pullGiveawayCode` in
  `functions/api/bot/send-chat.js` (11 lines), its verbatim duplicate in
  `functions/api/phamily-time.js`, and `_private/seed-giveaway-codes.js`.
- **`monthly_awards_done_{YYYY-MM}` → `monthly_awards`** with
  `INSERT … ON CONFLICT DO NOTHING RETURNING` — closes a real bug where two concurrent requests
  can both pass the flag check and double-run monthly awards (duplicate prize codes whispered).
- **`item_code_*.redeemedBy` → `kv_mutate`** — the race grants duplicate items.

### The data-access layer (why 183 call sites don't change)
`lib/kv.js` exports an object with the **same four methods and signatures** as the KV binding;
`index.js` injects it as `env.MARKETPLACE`. Details that must be right:
- **`get(key)` with no type arg must return a JSON *string***, `get(key, 'json')` an object.
  All 5 bingo files do raw `get` + manual `JSON.parse`; `gc_ptr_*` does `parseInt`;
  `twitch_bot_user_id` is a raw-string read. Getting this wrong breaks all 5 bingo files at once
  — test it in isolation first.
- **`list()` must return `{ keys: [{name}], list_complete: true }`** — all 5 sites read `key.name`.
- **Per-family expiry policy lives in the registry, not the call sites** — the DAL ignores a
  passed `expirationTtl` for group-(b) families, so none of the 72 `put` sites need editing.
- **The prefix→table registry is shared with the migration loader** — one source of truth.
- **`kv_mutate(key, fn)`** = transaction + `pg_advisory_xact_lock(hashtext(key))` (not
  `FOR UPDATE`, which locks nothing when the row doesn't exist yet and most of these are upserts).
- **`kv_list_values({prefix})`** — new, non-KV method to collapse the list-then-N-gets in
  `functions/api/game-activity.js` (runs on every poll from every open game page),
  `mana-clash.js`, and `pham-shock.js` into one query each.
- jsonb normalizes numbers and key order, so round-tripped values aren't byte-identical. Safe
  here (nothing signs a stored value), but worth knowing. jsonb also rejects `\u0000` — the
  loader should log such keys rather than abort.

`pg.Pool({ max: 10 })`, with the initial connect retried on backoff rather than exiting (matters
for reboot ordering).

---

## Phase 0 results (recorded as completed)

- **Secrets:** owner confirmed possession of `TWITCH_EVENTSUB_SECRET` and `BOT_SERVICE_SECRET`
  (the two unrecoverable ones). Remaining are recoverable: client ID/secret from the Twitch
  console, broadcaster ID via API, bot tokens from KV.
- **Baseline dump: DONE.** Production namespace `2457282c…` holds **35 keys** total:
  14 `listing_*`, 9 `pt_*`, 9 `pt_alltime_*`, 2 `inv_*`, 1 `sc_leaderboard` (23 have expirations).
  Archived as NDJSON with expirations in the session scratchpad, outside the repo.
  **Data migration is far smaller than assumed** — but 9 real users' watch-time history and
  14 real marketplace listings are genuine value, so verification still matters.
- **Absent from production KV, which matters:** no bot/broadcaster OAuth tokens
  (`twitch_bot_token`, `twitch_bot_refresh_token`, `twitch_broadcaster_*`), no
  `eventsub_subscriptions`, no `gc_*` code pools, no `item_code_*`. So the bot OAuth setup was
  never completed and **there are likely no EventSub subscriptions registered at all** — if
  confirmed via Helix, the 409 trap and re-registration risk are moot for this cutover.
- **`wrangler kv` gotcha:** omitting `--remote` silently reads a *local* simulated store and
  returns misleading results. Always pass `--remote`, and prefer `--namespace-id` over
  `--binding` (the latter plus `--preview false` produced auth errors).
- **URL matrix: CAPTURED** via `server/scripts/probe-urls.cjs` (re-run it against the Node
  server in Phase 3 and diff). Confirmed Pages behavior:
  `/foo.html` → 308 `/foo`; **query strings preserved** (`/foo.html?x=1` → `/foo?x=1`);
  `/index.html` and `/index` → 308 `/`; directories get a slash **added**
  (`/games/dino-park` → 308 `/games/dino-park/`, and `/games/dino-park/index.html` → same);
  all 404s — including `/api/*` ones — serve the custom `404.html` body.
- **`_headers` `/api/*` block is confirmed inert** for Function responses (neither
  `Cache-Control` nor the CORS headers appear). Do not port it. Note that
  `functions/api/twitch-status.js` and `twitch-schedule.js` set their own deliberate
  `Cache-Control` in code (60s / 300s) — preserve that behavior.
- **`.assetsignore` is also inert on Pages** (it's a Workers-assets feature). Everything
  currently protected is protected only by Cloudflare's built-in "root-level `_`/`.` paths
  aren't served" rule. Consequently `/wrangler.toml`, `/package.json`, `/demo-server.js`,
  `/start-demo.bat`, and all `/games/dino-park/_*` scripts are **publicly served today**.
  Low severity (no credentials), and the Phase 3 allowlist fixes it by design — but it means
  `.assetsignore` cannot be used to fix anything in the meantime.
- **Twitch dev redirect URIs: VERIFIED registered** on the site's app for both
  `https://dev.phantomace.tv/api/auth/twitch` and `…/api/admin/bot-setup`.
- **dino-assets on rig: VERIFIED** (829 files).
- **Tunnel is DASHBOARD-MANAGED** (no local `config.yml`). Cutover step 7 therefore edits
  public hostnames in the Zero Trust dashboard — no file edit, no `cloudflared` restart.
- **Rig services:** `cloudflared` (Running/Automatic) and **`postgresql-x64-18`**
  (Running/Automatic) — the latter confirms the exact `DependOnService` value to use.
  **No pm2 service and no phantomace service exist**, confirming the bot service has no
  reboot-survival mechanism today. Proceed with NSSM for both processes as planned.

**Phase 0 is COMPLETE.** All eight items closed.

## Phases

**Phase 0 — prevent irreversible loss. Blocks everything. All read-only.**
1. **Export the 6 dashboard-only secrets** (`TWITCH_EVENTSUB_SECRET`, `TWITCH_BROADCASTER_ID`,
   `BOT_SERVICE_SECRET`, `TWITCH_BOT_USER_ID`, `TWITCH_BOT_REFRESH_TOKEN`; `.dev.vars` has only
   the 2 client credentials). **Cloudflare secrets are write-only and cannot be read back** — if
   any are unrecoverable they must be regenerated, which means re-running OAuth flows. Establish
   this on day one, not on cutover day.
2. Baseline KV dump, archived regardless of outcome.
3. Capture the Pages URL matrix (`probe-pages-urls.js`).
4. **Verify `games/dino-park/assets/dino-assets/` on the rig** (72 MB, 829 files,
   gitignored-but-shipped) — compare file count and byte total against the dev machine. Add a
   boot warning if missing or undersized.
5. Confirm the `_headers` `/api/*` no-op via `curl -sI`.
6. **Determine whether the tunnel is locally-configured (`config.yml`) or dashboard-managed** —
   the cutover steps differ; don't discover which mid-window.
7. **Owner-only: add dev OAuth redirect URIs in the Twitch console** —
   `https://dev.phantomace.tv/api/auth/twitch` and `…/api/admin/bot-setup`. Phase 6 login
   testing is blocked without these.
8. **Verify whether the bot service actually survives reboot today** — `pm2 startup` does not
   support Windows, so the documented instructions are likely already broken.

**Phase 1 — scaffold.** `server/` + own `package.json`, `npm i pg send dotenv`, `.env` from
Phase 0, gitignore `server/.env`. Root `package.json` untouched.

**Phase 2 — leaf libraries.** `lib/db.js`, `lib/kv.js`, `lib/eventsub.js`. Exercise `kv.js`
against `phantomace-tv-dev` with fixtures **before** any handler uses it.

**Phase 3 — adapter, router, static.** Validate against the Phase 0 URL matrix. Deliberately
break the allowlist to confirm the boot assertion actually fails. *Milestone: the full static
site serves correctly with all API routes erroring — static parity proven before data logic exists.*

**Phase 4 — schema.** Apply `001_schema.sql` + `002_seed.sql` to `phantomace-tv-dev`.

**Phase 5 — migration rehearsal.** Dump/load into `phantomace-tv-dev`. Rehearses the cutover
script and gives Phase 6 production-shaped data.

**Phase 6 — validate on `dev.phantomace.tv`.** The tunnel already points it at `localhost:8789`,
so run Node on 8789 and stop `wrangler pages dev` — no tunnel changes needed. Walk the 31-route
contract by blast radius: static/clean-URLs/`_private` 404s → **login end-to-end** (cookie set
*with* `Secure`, `return_to` landing on a real page) → inventory/dino-park/leaderboards/item-codes
→ marketplace (including **two parallel curls buying the same listing — exactly one must win**)
→ room games + expiry + lazy round-advance → `/api/bot/bridge` byte-compatibility with a scratch
bot service → EventSub webhooks → `/api/admin/bot-setup` render check.

> **The 409 trap — the single most important testing constraint.**
> `functions/api/admin/bot-setup.js` creates EventSub subscriptions, never deletes any, and
> treats HTTP 409 as success. Twitch's uniqueness is on *type + version + condition*, **not**
> callback URL. So pressing "create EventSub" on dev will 409 against the live production
> subscriptions, report success, and subscribe nothing. Deleting the prod subs to make room
> breaks hype train, channel points, chat commands, and giveaway entry **with no way to recreate
> them from the admin panel.** **Do not press that button during testing.**
> Use the Twitch CLI instead — it sends properly signed payloads to an arbitrary URL without
> touching any subscription:
> `twitch event trigger channel.hype_train.progress --forward-url https://dev.phantomace.tv/api/hype-train --secret <secret>`
> Repeat for `channel.channel_points_custom_reward_redemption.add` (→ `/api/channel-points` and
> `/api/bot/giveaway-entry`) and `channel.chat.message` (→ `/api/bot/commands`). Also send one
> with a wrong secret (expect 403) and one with a stale timestamp (expect the new replay rejection).

**Phase 7 — Postgres-native rewrites.** `marketplace.js`, `pullGiveawayCode` + its duplicate,
the monthly-awards claim, `redeemedBy` via `kv_mutate`, `kv_list_values` at the 3 hot N+1 sites.
**Plus add a `delete-eventsub` action to `bot-setup.js`** — without it there is no recovery path
for a revoked subscription.

**Phase 8 — cutover.** **Phase 9 — post-cutover** (see Non-goals for the deferred list).

---

## Data migration

Namespace `2457282c1b4146449d1497124055f8ef` — the only copy of production data.

**Dump** (`scripts/dump-kv.js`): use the Cloudflare REST API, not per-key `wrangler` calls (one
process spawn each would eat the cutover window). List keys with `?limit=1000&cursor=…`,
**following the cursor to completion** — the list response also carries `expiration` as absolute
Unix seconds, which is how real TTLs get preserved rather than guessed. Fetch values via the bulk
endpoint where available, else concurrency ~10. Write `{name, expiration, value}` NDJSON **to the
scratch directory, not the repo** — the dump contains live Twitch refresh tokens and every
redeemable giveaway code. A 404 on a value fetch is expected for short-TTL keys; skip and log.

**Load** (`scripts/load-kv.js`, sharing the registry with `lib/kv.js`): route by longest-matching
prefix; `INSERT … ON CONFLICT (key) DO UPDATE` so the loader is **idempotent and re-runnable**
(this is what makes a dry-run cutover possible). `expires_at` from the dump for group (a),
**NULL for group (b) regardless of what the dump says.** Transforms: `gc_{tier}` array → N
`giveaway_codes` rows with `claimed_at` set below the `gc_ptr_{tier}` cursor;
`monthly_awards_done_*` → `monthly_awards`; **`market_index` discarded** (the `listings` rows are
the truth). **Unmapped keys are never silently dropped** — insert into an `unmapped_kv` table and
print a loud count; non-zero is a blocker.

**Verify** (`scripts/verify-migration.js`, run after every load): row count per table vs. key
count per prefix (mismatch = hard fail); deep-equal parsed JSON for ~10 sampled keys per family;
**per-tier giveaway code count and cursor position** (a cursor migrated too low re-issues codes
already given out, too high silently burns them — assert `count(claimed) == old_cursor`); all
`oauth_tokens` present with non-empty refresh tokens; array lengths for `media_index`, the 6
leaderboards, `item_code_queue`, `giveaway_entrants`, `bot_action_log`; spot-check 3 real
inventories against what the live site shows.

---

## Cutover and rollback

**EventSub needs no re-registration** — callbacks are `https://phantomace.tv/...` and the
hostname doesn't change. Record a Helix `GET /eventsub/subscriptions` baseline before, confirm
all still `enabled` after, keep the window short and off-stream (Twitch disables subscriptions
after repeated consecutive failures), and have the `curl -X DELETE` recovery command written down.

**Pre-flight (day before):** Phase 6 green; `001_schema.sql` applied to `phantomace-tv`; **full
dry-run — dump → load into the production DB → verify → do not flip.** Gives real timings and
proves the script at production volume.

**The window (target under 15 min, off-stream, announced):**
1. Record EventSub baseline.
2. `dump-kv.js` — full production dump.
3. `load-kv.js` → `phantomace-tv`.
4. `verify-migration.js` — **hard gate; any failure aborts.** Everything to here is reversible.
5. Start Node against `phantomace-tv`, `PUBLIC_ORIGIN=https://phantomace.tv`, bound to
   `127.0.0.1:8790` (so dev on 8789 keeps working). Smoke over localhost.
6. **Remove `phantomace.tv` + `www` from the Pages project's Custom Domains** (Cloudflare won't
   let a Pages custom domain and a tunnel CNAME own the same hostname). **Do not delete the
   Pages project or its deployments.**
7. `cloudflared tunnel route dns <tunnel> phantomace.tv` (and `www`), ingress → `localhost:8790`,
   keeping `dev` → 8789. Locally-configured tunnel → edit `config.yml` +
   `Restart-Service cloudflared`; dashboard-managed → edit public hostnames, no restart.
8. Public smoke: homepage, one clean URL, one `.html` 308, a CSS file, **`/_private/giveaway-codes/common_bonus_codes.txt`
   → 404 (verify explicitly, every time)**, login end-to-end, `/api/inventory`, `/api/game-activity`,
   marketplace browse.
9. Re-read EventSub subscriptions.
10. Zone settings: Always Use HTTPS on. **Add Cache Rules** — cache `/assets/*`, `/css/*`,
    `/js/*`, `/games/*` at the edge, **bypass `/api/*` and `/cdn/*`**. Not polish: 72 MB of Dino
    Park sprites just moved onto a residential upstream, and this restores the offload Pages gave free.
11. **Only once green:** point `PhantomACE-Bot-Service` at `http://localhost:8790` (same bridge
    contract, same secret header, only the base URL changes).

**Rollback:** re-add `phantomace.tv` as a Pages custom domain. Pages project, latest deployment,
and the KV namespace are all intact as of step 2.

**The asymmetry, stated honestly:** rollback is nearly free in the first minutes and gets
progressively lossier — every write the rig accepts after step 7 exists only in Postgres.
**Set a hard decision point: if smoke tests aren't green in 30 minutes, roll back rather than
debug forward.** Write that number down before starting.

**Accepted risk:** writes between steps 2 and 7 are lost. Off-stream with no viewers that's
realistically zero. Engineering around it would need an invasive deploy to routes we're about to
delete. **Keep 30+ days:** the Pages project, all deployments, the KV namespace, both dumps.

---

## Process supervision (Windows)

**NSSM (or `winsw`), one Windows service per process — not bare `pm2`.** `pm2` is the documented
precedent in the bot service, but **`pm2 startup` does not support Windows**, so those
instructions likely don't survive a reboot today (Phase 0 item 8 verifies this). NSSM matches
what's already on the box — `cloudflared` is a Windows service.

- `phantomace-web` → `node …\server\index.js`; `phantomace-bot` → the bot service
- Both: stdout/stderr to rotating files, `AppExit Default Restart`, `AppThrottle 5000`
- **`DependOnService = postgresql-x64-18`** on `phantomace-web`, *plus* connect-retry backoff in
  `lib/db.js` — both, not either, or the server crash-loops on every boot until Postgres is up
- Services start before login and survive reboots (Windows Update will bounce this box)

**Single instance is a design requirement, not a simplification** — Mana Clash and PhamShock
advance round timers lazily inside the poll handler, so two processes would double-advance rounds.
Note this at the top of `index.js`. No cluster mode.

**Also:**
- **`/api/health`** (new trivial route: `SELECT 1`, uptime, git SHA) wired to an external uptime
  monitor with alerting. Highest-value operational addition — a home Windows box is now a single
  point of failure with no failover, and you want a page, not a Discord message from a viewer.
- **`deploy.ps1`:** `git pull; npm --prefix server ci; nssm restart phantomace-web`. Static
  changes need no restart (read from disk per request); only `server/**` and `functions/**` do.
- **Tighten exposure:** restrict Postgres `listen_addresses` to localhost (currently `0.0.0.0`),
  stop/disable the unused Apache on `:8080`, bind Node to `127.0.0.1` so the tunnel is sole ingress.
- **Never put the repo or `dino-assets` in a OneDrive-synced folder on the rig** — the rig's clone
  is at `C:\Users\EZiRLS8\Documents\...` (not OneDrive); keep it that way.

---

## Non-goals (explicitly out of scope)

**Data model:** no normalization beyond the four redesigned families. No ORM, query builder, or
migration framework. No Redis.

**Code hygiene — deliberately deferred:**
- **Do not consolidate `json()` (26 files) or `getSession()` (19 files).** Byte-identical and
  harmless; a 45-file diff with no tests, landing alongside a storage swap and a hosting
  migration, is the wrong trade. `verifySignature` is the *only* helper consolidated, because
  it's security-relevant and needs a behavior change anyway.
- **Do not unify the 3 `getPlayer()` return shapes** or the `guest_` vs `u_`/`g_` prefixes —
  consumed differently, and the prefixes are baked into stored leaderboard data
  (`maybeRunMonthlyAwards` filters on `startsWith('guest_')`, so changing them changes who wins prizes).
- **Do not unify the two divergent `getAppAccessToken`** / the incompatible `twitch_app_token`
  shapes. Wasteful, not broken. Migrate as-is.
- **Do not sign or encrypt `pham_session` in this migration.** It's unsigned, carries `role`,
  trivially forgeable, and 19 files trust it for authorization — the most serious defect in the
  codebase and **post-cutover item #1**. But it was equally forgeable on Pages, so the migration
  doesn't worsen it, and fixing it properly needs a design decision (the frontend deliberately
  reads the cookie for display name/avatar, so it can't just become an opaque blob).
  Half-fixing it during a cutover is worse than not touching it.
- **Do not fix every read-modify-write race** — only the four where the race causes material
  loss. `inv_*`, the 6 leaderboards, `giveaway_entrants`, `bot_action_log`, `cp_queue_*`,
  `media_index`, `dino_park_*`, and room docs go to Phase 9, where `kv_mutate` already exists
  and each becomes a deliberate two-line change.

**Scope:** no real scheduler for room timers (lazy advance works, and real timers would couple
game state to process lifetime). Don't replace 2-second polling with WebSockets. **Don't restore
media upload / `/cdn/media` at cutover** — already broken in production since R2 was removed, no
frontend references `/cdn/media`, and it's the only multipart/`formData()` site in the codebase,
so deferring it removes that concern from the cutover entirely (migrate `media_index`, return a
clean 503, implement disk-backed media in Phase 9). Don't port `_headers`' `/api/*` block. Don't
modernize `.html` hrefs. Don't set `"type":"module"` in the root `package.json`. No Express,
TypeScript, bundler, or build step. No IIS/nginx in front — the tunnel terminates TLS. **Don't
merge the bot service into the web process or change the bridge contract** (it's what
`RefreshingAuthProvider` boots against; change only the base URL). Don't delete the Pages project
or KV namespace for 30 days.

---

## Verification

**Per-phase gates** (each must pass before the next):
- **Phase 2:** `lib/kv.js` fixture tests against `phantomace-tv-dev` — especially
  `get(key)` → string vs `get(key,'json')` → object, `list()` shape, and TTL read-filtering.
- **Phase 3:** the Node server reproduces the Phase 0 Pages URL matrix exactly; the boot
  allowlist assertion fails the boot when deliberately broken; full static site renders.
- **Phase 5:** `verify-migration.js` green against `phantomace-tv-dev`.
- **Phase 6:** the 31-route walkthrough on `dev.phantomace.tv` in the order given above,
  including the two-parallel-curl marketplace race test and all four EventSub routes driven by
  the **Twitch CLI** (never the admin panel's create-EventSub button).

**End-to-end before cutover:** on `dev.phantomace.tv` — log in with Twitch, land back on the
correct page, open Dino Park and confirm sprites load and a save round-trips, list and buy a
marketplace dino from two accounts, join a Mana Clash room from two browsers, redeem an item
code, confirm `/_private/giveaway-codes/*` 404s.

**At cutover:** the step-8 public smoke list, then the step-9 EventSub status re-read.

**After cutover:** `/api/health` green on an external monitor; watch for revoked EventSub
subscriptions over the first stream; confirm Cache Rules are serving `/assets/*` from the edge
(check `cf-cache-status: HIT`).
