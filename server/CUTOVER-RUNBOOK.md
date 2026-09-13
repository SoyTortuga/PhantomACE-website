# Cutover runbook — Cloudflare Pages → self-hosted

> ## ✅ EXECUTED 2026-09-13. `phantomace.tv` is served by the rig.
>
> Kept as the record of what was done, and because the rollback section is
> still live for ~30 days. Steps carry their outcomes inline.
>
> **What went wrong, all caught before it mattered:**
> - The installer wrote its settings to the *wrong service*, leaving production
>   configured for the dev port and database. Its readback assertion missed it
>   because it verified through `nssm get` on the service it believed it had
>   configured — the same name resolution that was failing. Repaired by writing
>   the registry directly; installer fixed in `1d49f95` to verify against the
>   registry and to snapshot sibling services before and after.
> - `/games` 404'd because the static allowlist tested the directory rule before
>   the page rule, and `games` is both `games.html` and `games/`. `/about` only
>   escaped the identical bug because no `about/` directory exists. Fixed in
>   `a5e6aad`.
> - The tunnel briefly pointed at **8789**, the dev port. This produced a
>   visible 502 only because dev was stopped; had dev been running, production
>   would have quietly served the **dev database** to the public. Stopping dev
>   before the switch turned a silent data incident into an obvious error —
>   keep doing that.
> - Step 8's original caching advice would have frozen HTML/CSS/JS at the edge.
>   See that step.
>
> **Proven after cutover:** production survives an unattended reboot. Boot at
> 07:30:55 UTC, both services back at ~07:31:04 with identical uptimes, no
> manual intervention, no `[db] not ready` lines — `DependOnService` sufficed.
>
> **Still outstanding:** see the "After cutover" section at the end.

Executable checklist for moving `phantomace.tv` from Cloudflare Pages to the
rig. Supersedes the cutover section of `MIGRATION-PLAN.md`, which was written
before several findings that simplify it.

**Run this off-stream.** Announce it. Total expected window: under 15 minutes.

---

## What changed since the plan was written

| Plan assumed | Actually true | Effect |
|---|---|---|
| EventSub subscriptions must be baselined and re-verified, with a 409 trap to avoid | **Zero subscriptions exist** (verified via Helix) | Steps 1 and 9 of the old plan are deleted. No EventSub work at all |
| Tunnel might be locally configured | **Dashboard-managed** (no `config.yml`) | No file edit, no `cloudflared` restart. Zero Trust UI only |
| Data migration is the risky part | **~47 keys, ~100 KB** | Dump+load+verify takes seconds, and has been rehearsed successfully |
| Login was unproven | **Proven end-to-end on dev**, incl. `Secure` cookie and `return_to` | Not a cutover unknown |
| No process supervision | NSSM service + reboot survival proven on dev first | Production service is a repeat of a known-good procedure |

---

## Pre-flight — the day before, changes nothing public

1. **Phase 7 lands now, if it's happening.** It was deferred specifically to
   keep Pages deployable; once it merges, **stop deploying to Pages** — those
   rewrites use `mutate()`, `listValues()` and raw SQL, none of which exist on
   a real KV binding, so a Pages deploy after that point breaks production.
2. Apply the schema to **production**:
   ```
   psql "postgres://postgres:PASSWORD@localhost:5432/phantomace-tv" -f server\sql\001_schema.sql
   ```
3. **Full dry run** — dump, load into `phantomace-tv`, verify. Do **not** flip.
   This proves the scripts against production volume and gives real timings.
   The loader is idempotent, so the real run simply overwrites.
4. Confirm `games/dino-park/assets/dino-assets/` still has **829 files** on the
   rig. It is gitignored-but-required; a fresh clone silently loses every sprite.
5. Decide who is watching, and **write down the abort time** (see §Rollback).

---

## The window

### 1. Fresh dump — do not reuse yesterday's
```
node server\scripts\dump-kv.js 2457282c1b4146449d1497124055f8ef <outside-repo>\cutover.ndjson
```
Production data grows: 35 keys one morning, 47 by that afternoon once Dino Park
cloud saves went live. Must report `distinct keys written: N of N`.
**Write it outside the repo** — it contains live tokens and unclaimed giveaway codes.

### 2. Load into production
```
node server\scripts\load-kv.js <outside-repo>\cutover.ndjson --database-url=postgres://postgres:PASSWORD@localhost:5432/phantomace-tv
```
Expect `0 unmapped` and one key discarded by design (`market_index`).
Anything in `unmapped_kv` **aborts** — it means a key family has no mapping.

### 3. Verify — the hard gate
```
node server\scripts\verify-migration.js <outside-repo>\cutover.ndjson --database-url=...phantomace-tv
```
Must exit 0. **Everything up to here is fully reversible; nothing public has changed.**

### 4. Start the production service
From an **elevated** PowerShell (it installs a service):
```
.\server\scripts\install-services.ps1 -Database 'phantomace-tv' -PublicOrigin 'https://phantomace.tv' -Port 8790 -ServiceName 'phantomace-web'
Start-Service phantomace-web
```
No password is passed. The script reads `DATABASE_URL` from `server\.env` and
swaps only the database name, so credentials never reach the command line —
where they would persist in PowerShell history and process listings.

**Wait for the `[setup] verified:` line.** The script reads its configuration
back out of NSSM and refuses to leave a broken service installed. This is not
ceremony: the dev install reported success at every step while producing a
service that could not start at all, and the failure only surfaced later at
`Start-Service`, looking like a different problem.

If it does crash-loop, `Get-Service` reports **`Paused`**, not `Stopped`, and
the reason is only ever in `server\logs\server.out.log`. `Stop-Service` quiets
it. This exact procedure has now been run and proven on dev, including an
unattended reboot — production is a repeat of a known-good sequence, not a
first attempt.
Leave the dev service on 8789 running — `dev.phantomace.tv` keeps working.

Smoke over localhost before any public change:
```
curl.exe -s http://127.0.0.1:8790/api/health          # ok:true
curl.exe -s http://127.0.0.1:8790/api/marketplace     # real listings
curl.exe -s -o NUL -w "%{http_code}`n" http://127.0.0.1:8790/membership   # 200
```

### 5. Release the hostname from Pages
Cloudflare will not let a Pages custom domain and a tunnel hostname own the same
name, so this must come first: **Pages project → Custom domains → remove
`phantomace.tv` and `www.phantomace.tv`.**

**Do not delete the Pages project or its deployments** — that is the rollback path.

### 6. Point the tunnel at production
Zero Trust → Networks → Tunnels → the tunnel → Public Hostnames. Add:

| Hostname | Service |
|---|---|
| `phantomace.tv` | `http://localhost:8790` |
| `www.phantomace.tv` | `http://localhost:8790` |

Leave `dev.phantomace.tv → http://localhost:8789` alone. Dashboard-managed, so
no `cloudflared` restart is needed.

### 7. Public smoke test
```
curl.exe -s -o NUL -w "%{http_code}`n" https://phantomace.tv/
curl.exe -s -o NUL -w "%{http_code}`n" https://phantomace.tv/membership        # 200 (extensionless canonical)
curl.exe -sI https://phantomace.tv/membership.html                             # 308 -> /membership
curl.exe -s https://phantomace.tv/api/health                                   # ok:true
curl.exe -s https://phantomace.tv/api/marketplace                              # real listings
curl.exe -s -o NUL -w "%{http_code}`n" https://phantomace.tv/_private/giveaway-codes/common_bonus_codes.txt
```
**That last one MUST be 404, every single time.**

**Correction, verified against production on 2026-09-13: it is NOT 404 on
Cloudflare Pages today — it returns 200 and serves the real file.** The earlier
claim that Cloudflare's built-in "root-level `_` paths aren't served" rule
protected `_private/` was wrong. So was the hope that `.assetsignore` did: that
file lists `/_private/` explicitly and the directory is served anyway,
confirming for the second time that `.assetsignore` is inert on Pages.

What actually determines exposure on Pages is simply whether the file exists in
the uploaded directory. `_private/SETUP-GUIDE.txt` 404s only because it no
longer exists locally; `server/.env` 404s only because it lives on the rig.
Nothing is protecting the rest.

Currently public on production: `/_private/giveaway-codes/*.txt` (171 codes),
`/_private/BROADCASTER-SETUP-STEPS.txt`, `/.dev.vars` (empty values),
`/wrangler.toml`, `/package.json`.

**This is an argument for the migration rather than a cutover risk.** The Node
server's allowlist inverts the default — a path is private unless explicitly
served — and `assertPrivatePathsUnreachable()` fails the boot if any of these
resolve. So this check flips from "hope it still 404s" to "the server refuses to
start otherwise." Keep verifying it anyway.

Then **log in through a browser** and confirm you land back on the page you
started from. If anything goes wrong, the URL now carries `?login_error=<reason>` —
read it rather than guessing.

### 8. Restore edge caching — DONE, and not the way this step originally said

> **The original advice here was wrong and would have broken deploys.** It said
> to cache `/assets/*`, `/css/*`, `/js/*` and `/games/*` with a long edge TTL.
> This project has **no cache-busting whatsoever** — CSS and JS are referenced
> as plain `/css/base.css`, there is no build step and no content hashing — so a
> long edge TTL on those paths means no future deploy reaches users until
> someone manually purges. Worse, `/games/*` includes
> `games/dino-park/index.html`, the game itself, so the `SAVE_EPOCH` progression
> reset and every future hotfix would have been frozen at the edge.

Match on **file extension**, not path prefix, so HTML/CSS/JS are never caught
and any asset folder added later is covered automatically:

**Rule 1 — Cache static media.** Custom expression:
```
ends_with(http.request.uri.path, ".png") or ... (.jpg .jpeg .gif .webp .svg
.ico .woff .woff2 .ttf .otf .mp3 .ogg .wav)
```
- Cache eligibility: *Eligible for cache*
- Edge TTL: **Ignore cache-control header and use this TTL** → `2592000` (30d)
- Browser TTL: override → `86400` (1d)

The Edge TTL override is mandatory, not a preference: `send` serves static
files with `Cache-Control: public, max-age=0`, so "use cache-control if present"
caches essentially nothing.

**Rule 2 — Bypass API**, ordered BELOW rule 1:
```
starts_with(http.request.uri.path, "/api/") or starts_with(http.request.uri.path, "/cdn/")
```
- Cache eligibility: *Bypass cache*

Order matters for exactly one overlap: `/cdn/media/x.png` matches both, and the
later rule wins, so bypass must come second.

**Verified 2026-09-13:** a 15.5 MB Dino Park background returns
`cf-cache-status: HIT` on a repeat request; `/api/health` is `DYNAMIC` with
`no-store`; `/games` HTML is `DYNAMIC` with `max-age=0`, so deploys still land.

**Caveat worth remembering:** a Cloudflare purge does not clear browsers. With
a 1-day browser TTL, *replacing* an existing sprite at the same filename can
show stale for up to a day. Add new files under new names rather than
overwriting.

### 9. Point the bot service at localhost — only once everything above is green
In `PhantomACE-Bot-Service/.env`, change `BRIDGE_URL` to `http://localhost:8790`.
Same bridge contract, same `X-Bot-Service-Secret`; only the base URL changes. It
removes a tunnel round-trip and a dependency on the tunnel being up for the bot
to work.

---

## Rollback

Re-add `phantomace.tv` and `www` as Pages custom domains. The Pages project, its
latest deployment, and the KV namespace are all intact as of step 1's dump.

**The asymmetry, stated honestly:** rollback is nearly free in the first minutes
and gets progressively lossier, because every write the rig accepts after step 6
exists only in Postgres — an inventory change, a dino purchase, a watch-time tick.

**Write down an abort time before starting. If the smoke tests are not green
within 30 minutes, roll back rather than debug forward.** Debug on dev, where
there is no clock. Under pressure the instinct is always "one more fix"; that is
exactly when the rollback stops being cheap.

**Accepted risk:** writes between step 1 and step 6 are lost. Off-stream with no
viewers that is realistically zero, and the dry run establishes the real window.

**Keep for 30+ days:** the Pages project, all its deployments, the KV namespace,
and both dump files.

---

## After cutover

- Point an **external uptime monitor** at `https://phantomace.tv/api/health`. It
  returns 503 when Postgres is unreachable, so it catches the failure mode where
  the process is up but every API route is 500ing. The rig is now a single point
  of failure in a way Pages never was — you want a page, not a viewer telling you.
- Watch `server\logs\server.out.log` through the first stream.
- **Tighten the box:** restrict Postgres `listen_addresses` to localhost (it
  currently listens on `0.0.0.0:5432`), and stop/disable the unused Apache on
  port 8080 (it serves only the EDB installer's health page).
- **Post-cutover item #1 is the session cookie.** `pham_session` is unsigned,
  unencrypted, carries `role`, and 19 files trust it for authorization including
  broadcaster-only admin routes. It is trivially forgeable. It was equally
  forgeable on Pages so the migration does not worsen it, but it is the most
  serious defect in the codebase and deserves a deliberate fix — which needs a
  design decision, because the frontend reads that cookie for display name and
  avatar and so it cannot simply become an opaque signed blob.
- Then Phase 9: the remaining read-modify-write races (`inv_*`, the six
  leaderboards, `giveaway_entrants`, `bot_action_log`, `cp_queue_*`,
  `media_index`, `dino_park_*`, room docs). `kv_mutate` already exists, so each
  is a deliberate two-line change, tested individually.
- **Unrelated but outstanding:** the bot / hype train / channel points subsystem
  has never been switched on in production — no EventSub subscriptions and no bot
  OAuth tokens. Completing `_private/BROADCASTER-SETUP-STEPS.txt` is now safe: the
  1101 crash is fixed and the panel has `list-eventsub` / `delete-eventsub`.
