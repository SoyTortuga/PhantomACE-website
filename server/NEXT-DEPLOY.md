# Pending deploy — prepared 2026-09-13

Production is running **866b407**. Three commits are waiting, and two of them
will stop the server booting if the steps are done out of order.

Delete this file once it has been carried out.

| Commit | What | Extra requirement |
|---|---|---|
| `ddbcd43` | `channel:read:hype_train` scope | restart only |
| `615f3b2` | Native giveaway entry ledger | **schema apply, both databases** |
| `998ceb7` | Signed session cookie | **`SESSION_SECRET` in `server/.env`** |

## The dependency that decides the order

**The broadcaster cannot finish their setup until this is deployed.** Their one
remaining item is the hype train EventSub subscription, and Twitch rejects it
until the new scope is live. Everything else on their checklist is already
done — chat bot authorized, channel points authorized, reward created, three
of six subscriptions enabled.

So: deploy, then broadcaster. Not the other way round.

## Steps

### 1. `SESSION_SECRET` into `server/.env` — before anything restarts
```
SESSION_SECRET=<64 hex chars>
```
Generate with:
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

The server refuses to boot without it, deliberately: with no secret nothing
could verify a session and every request, the broadcaster's included, would
arrive looking logged out with no visible cause.

One entry covers both services — they share `.env`.

### 2. Pull
```
cd "C:\Users\EZiRLS8\Documents\PhantomACE Website"; git pull
```

### 3. Schema, on BOTH databases
`001_schema.sql` is idempotent, so re-running the whole file IS the migration.
Adds `giveaway_entries` and `giveaway_drop_codes`.
```
psql "<...phantomace-tv-dev>" -f server\sql\001_schema.sql
psql "<...phantomace-tv>"     -f server\sql\001_schema.sql
```

### 4. Restart — needs elevation
```
Restart-Service phantomace-web; Restart-Service phantomace-web-dev
```

### 5. Confirm the boot
```
curl.exe -s http://127.0.0.1:8790/api/health
Get-Content ...\server\logs\server.out.log -Tail 8
```
Wants `ok:true` and `postgres ready: phantomace-tv` with no `-dev` suffix.

### 6. Log in again — the highest-risk check
**This deploy logs everyone out.** Legacy unsigned cookies are rejected rather
than grandfathered, because accepting them would leave the forgery open for as
long as the transition lasted.

Sign in at phantomace.tv and confirm the header shows your name and avatar. If
login fails, **stop and report** — that is the one step here that could take
the site down for real users rather than just failing quietly.

### 7. Giveaway page
`phantomace.tv/giveaway` should show four figures and, once signed in, a claim
box instead of the login prompt.

### 7b. Fill the giveaway code pools
```
node server\scripts\seed-giveaway-pools.js                 # dry run, shows current levels
node server\scripts\seed-giveaway-pools.js --confirm
```
Run it against **production**. It prints a before/after table; expect
100 / 50 / 20 / 5 available across common / uncommon / rare / mythic.

This does not strictly require the restart — the script builds its own
connection — but the AUTOMATIC top-up does, since that lives in the running
server.

Why it matters more than it looks: `hype-train.js` pulls codes and returns
early if it gets none, without posting to chat, without a drop record and
without a log line. An empty pool made a hype train do **nothing at all**,
with no error anywhere. The pools have been empty since the migration.

Do NOT seed from `_private/giveaway-codes/*.txt`. Those were publicly
downloadable from the site until 2026-09-13 and must be considered burned.
The script mints fresh codes and never prints them; a code is revealed only
when it is dropped into chat.

### 8. Hand back to the broadcaster
At `phantomace.tv/api/admin/bot-setup`, in order:
1. **Authorize Channel Points Management** — Twitch prompts for the new hype
   train permission. Adding a scope does not upgrade an existing token, so
   this step is unavoidable.
2. **Create EventSub Subscriptions** — once.

Then verify against Helix, not against our own bookkeeping — our code used to
treat a 409 as success and can record a subscription that was never created:
```
GET https://api.twitch.tv/helix/eventsub/subscriptions
```
Want **six**, all `enabled`, all callbacks on `https://phantomace.tv`.

## Still outstanding after this

- **Moderator dashboard** — broadcaster-managed allowlist, now that a signed
  cookie makes an access check mean something.
- Dev and production share `SESSION_SECRET` because they share `.env`. Fine
  today, since a dev login yields the same session a production login would.
  Worth splitting if dev ever gains a test-login shortcut.

## Cost of waiting

Not urgent, but not free either: the session cookie is still forgeable in
production until this lands, so anyone can still grant themselves broadcaster
access. And `giveaway.html` still shows the placeholder Gleam embed while drop
messages point viewers at it.
