# Cutover runbook — Cloudflare Pages → self-hosted

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
```
.\server\scripts\install-services.ps1 -PostgresPassword '...' -Database 'phantomace-tv' -PublicOrigin 'https://phantomace.tv' -Port 8790 -ServiceName 'phantomace-web'
Start-Service phantomace-web
```
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
**That last one MUST be 404, every single time.** Cloudflare's built-in
"don't serve underscore paths" rule protected it before and does not apply now;
the static allowlist is the only thing standing between real giveaway codes and
the internet. Verify it explicitly rather than trusting it.

Then **log in through a browser** and confirm you land back on the page you
started from. If anything goes wrong, the URL now carries `?login_error=<reason>` —
read it rather than guessing.

### 8. Restore edge caching
Zone → Rules → Cache Rules:
- **Cache** `/assets/*`, `/css/*`, `/js/*`, `/games/*` with a long edge TTL
- **Bypass** `/api/*` and `/cdn/*`

Not optional polish: 72 MB of Dino Park sprites just moved onto a residential
upstream. This restores the offload Pages gave for free. Confirm with
`cf-cache-status: HIT` on a repeat asset request.

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
