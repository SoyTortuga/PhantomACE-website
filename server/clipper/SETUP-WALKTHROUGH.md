# Clipper — step-by-step setup

Follow top to bottom. Phases 1–3 are yours alone. Phase 4 is the one session
that needs the broadcaster. Phase 5 goes live. Phase 6 is TikTok's audit, which
runs in parallel and blocks nothing.

Commands are run from the repo root on the rig unless stated.

---

## Phase 0 — Get the code onto the rig

- [ ] Merge the branch `claude/nifty-darwin-pzbkwr` into the default branch
      (open a PR, or merge locally), then on the rig:

```
git pull
nssm restart phantomace-web
```

The restart is because `server/lib/registry.js` changed (it gained the
`clipper_posted` key). Nothing else about the site changes.

---

## Phase 1 — ffmpeg (10 min, solo)

- [ ] Install ffmpeg on the rig. Easiest:

```
winget install Gyan.FFmpeg
```

- [ ] Open a NEW terminal (so PATH refreshes) and confirm:

```
ffmpeg -version
```

If you'd rather not put it on PATH, note the full path to `ffmpeg.exe` and set
`FFMPEG_PATH=` in `server/.env` later.

- [ ] Checkpoint:

```
node server/clipper/scripts/doctor.js
```

Runtime and Branding assets should both be green. Everything else will still be
red — that's expected this early.

---

## Phase 2 — Decide the routing (20 min, solo + one question for the broadcaster)

- [ ] See what the channel actually has clips of:

```
node server/clipper/scripts/list-games.js
```

This prints every game in the last 12 months with its **game id**, clip count
and top clip. It needs only the Twitch credentials the site already has.

- [ ] Ask the broadcaster the one question that decides the shape of the config:
      **one account for everything, or a separate channel per game?**

- [ ] Generate a starting config:

```
node server/clipper/scripts/list-games.js --emit-config > server/clipper/config.json
```

- [ ] Edit `server/clipper/config.json`:
  - **Delete** routes for games that shouldn't be posted.
  - **Merge** games that share an account into ONE route — put all their ids in
    that route's `match.gameIds`. This matters: the "2 per account per run" cap
    is per route, so two games left as separate routes pointing at the same
    channel would post 4/day to it, not 2.
  - Keep `tiktok.privacy` as `"SELF_ONLY"` for now (see Phase 6).
  - Note each route's `credsEnv` names (e.g. `YT_MTG`, `TT_MTG`) — you'll need
    them in Phase 3 and 4.

- [ ] Checkpoint — config should load and list your routes:

```
node server/clipper/scripts/doctor.js
```

---

## Phase 3 — Create the API apps (45 min, solo)

Do this **before** booking the broadcaster's time, so their session is only
clicking "Allow".

### 3a. Google Cloud (for YouTube)

- [ ] Go to <https://console.cloud.google.com/> — signed in to an account the
      **broadcaster owns or controls** (see SETUP-ROLES.md on custody).
- [ ] Create a project, e.g. `PhantomACE Clipper`.
- [ ] **APIs & Services → Library** → search `YouTube Data API v3` → **Enable**.
- [ ] **APIs & Services → OAuth consent screen**:
  - User type: **External**
  - App name, support email, developer contact email — fill in.
  - Add scope: `https://www.googleapis.com/auth/youtube.upload`
  - **⚠ PUBLISH THE APP.** On the consent screen summary, click
    **Publish app** so the status reads **In production**, not *Testing*.
    **Why this matters:** an app left in *Testing* issues refresh tokens that
    **expire after 7 days**, so the bot would stop posting every week with a
    confusing auth error. Published apps issue non-expiring refresh tokens.
  - You will see "Google hasn't verified this app" during consent. That is
    expected and fine for a private tool — click through via
    *Advanced → Go to … (unsafe)*. Verification is only needed to remove that
    warning or to serve many users.
- [ ] **APIs & Services → Credentials → Create credentials → OAuth client ID**:
  - Application type: **Web application**
  - Name: anything
  - **Authorized redirect URIs → ADD:** `http://127.0.0.1:8790/callback`
    (exactly this — it must match what the script listens on)
- [ ] Copy the **Client ID** and **Client secret**.
- [ ] Put them in `server/.env`, once per destination channel's credsEnv. The
      same client id/secret can serve every channel; only the refresh token
      differs per channel:

```
YT_MTG_CLIENT_ID=<client id>
YT_MTG_CLIENT_SECRET=<client secret>
# YT_MTG_REFRESH_TOKEN comes in Phase 4
```

> **Quota note:** each upload costs ~1600 of the default 10,000 units/day, so
> roughly 6 uploads/day per project. If you route many accounts through one
> project and hit the ceiling, either request more quota or make a second
> project for the other channels.

### 3b. TikTok

- [ ] Go to <https://developers.tiktok.com/> → **Manage apps** → **Create app**,
      signed in as the **broadcaster's** TikTok account.
- [ ] Add products: **Login Kit** and **Content Posting API**.
- [ ] Request scopes: `user.info.basic`, `video.upload`, `video.publish`.
- [ ] **Redirect URI:** TikTok generally refuses `localhost`/`127.0.0.1` and
      wants an `https://` URI. Register one you control, e.g.
      `https://phantomace.tv/tiktok/callback`. **It does not need to serve
      anything** — a 404 is fine, because you only copy the address bar back.
      You'll use `--manual` mode in Phase 4 for this.
- [ ] Copy the **Client key** and **Client secret** into `server/.env`:

```
TT_MTG_CLIENT_KEY=<client key>
TT_MTG_CLIENT_SECRET=<client secret>
# TT_MTG_REFRESH_TOKEN comes in Phase 4
```

- [ ] Checkpoint — routes should now show the client halves present but still
      be waiting on refresh tokens:

```
node server/clipper/scripts/doctor.js
```

---

## Phase 4 — The broadcaster session (~30–45 min, together)

Give them `BROADCASTER-SETUP.pdf` beforehand. Screen-share; they sign in, you
drive. Repeat 4a/4b **once per account**.

### 4a. Each YouTube channel

```
node server/clipper/scripts/oauth-youtube.js --name YT_MTG
```

- [ ] A browser opens. The broadcaster signs in **to the Google account that
      owns the channel these clips should go to**.
- [ ] They click through the unverified-app warning, then **Allow**.
- [ ] The script prints **AUTHORIZED CHANNEL**. ⚠ **Read it back to them and
      confirm it's the right channel before continuing** — a token for the wrong
      channel is perfectly valid and would silently post to the wrong place.
- [ ] Copy the printed `YT_..._REFRESH_TOKEN=` line into `server/.env`.

If the browser was already signed into the wrong Google account, sign out (or
use a private window) and re-run.

### 4b. Each TikTok account

```
node server/clipper/scripts/oauth-tiktok.js --name TT_MTG --manual --redirect https://phantomace.tv/tiktok/callback
```

- [ ] The broadcaster signs in to TikTok and approves.
- [ ] The browser lands on your redirect URI (probably a 404 — fine). **Copy the
      whole address from the address bar** and paste it into the terminal.
- [ ] The script prints the account name and its **allowed privacy levels**.
      If that's only `SELF_ONLY`, the app isn't audited yet — expected, carry on.
- [ ] Copy the printed `TT_..._REFRESH_TOKEN=` line into `server/.env`.

### 4c. Confirm

```
node server/clipper/scripts/doctor.js
```

- [ ] Every account you connected should now read **✓**. You can release the
      broadcaster here — nothing below needs them.

---

## Phase 5 — Go live (30 min, solo)

- [ ] Produce a real render and **watch it** before anything is published:

```
node server/clipper/run.js --dry-run --render
```

It prints where each `short.mp4` was written. Open one. Check the framing,
the title text, and that the audio is right.

- [ ] First real post, deliberately small:

```
node server/clipper/run.js --limit 1
```

Check the video on the destination channel. On TikTok pre-audit, look in the
app's **drafts**, not the profile.

- [ ] Install the daily task, in dry-run mode first:

```
powershell -NoProfile -ExecutionPolicy Bypass -File .\server\scripts\install-clipper-task.ps1 -DryRun
Start-ScheduledTask -TaskName 'PhantomACE Clipper'
```

- [ ] Read `server/clipper/logs/clipper.log` and confirm the selection looks sane.
- [ ] Re-run the installer **without** `-DryRun` to go live:

```
powershell -NoProfile -ExecutionPolicy Bypass -File .\server\scripts\install-clipper-task.ps1
```

- [ ] Next morning: check the log and the channels.

---

## Phase 6 — TikTok audit (parallel; blocks nothing)

- [ ] Work through `TIKTOK-AUDIT.md`, which has the submission text, the scope
      justification and the demo-video script already drafted.
- [ ] Broadcaster reviews and submits it.
- [ ] **After approval:**

```
node server/clipper/scripts/oauth-tiktok.js --name TT_MTG --manual --redirect https://phantomace.tv/tiktok/callback
```

Confirm it now reports privacy levels beyond `SELF_ONLY`, then in
`config.json` set that route's `tiktok.privacy` to `"PUBLIC_TO_EVERYONE"`.
No code change, no redeploy.

---

## If something breaks

| Symptom | Cause |
|---|---|
| Auth fails ~a week after setup | The Google consent screen is still in *Testing*. Publish it (Phase 3a) and re-mint the token. |
| `redirect_uri_mismatch` | The URI in Google Credentials isn't exactly `http://127.0.0.1:8790/callback`. |
| Google returns no refresh token | Already consented once. Revoke the app under the channel's Google account → third-party access, then re-run. |
| Clips post to the wrong channel | A refresh token was pasted under the wrong `credsEnv`. Re-run 4a and read the AUTHORIZED CHANNEL line. |
| TikTok posts never appear public | Audit not approved yet — they're in drafts. Expected until Phase 6. |
| `Could not derive a video URL from thumbnail` | Twitch changed its thumbnail scheme; `twitch.js` needs updating. |
| An account is skipped silently | Its three env vars aren't all set. `doctor.js` names the missing one. |

Anything else: `node server/clipper/scripts/doctor.js --live` names the exact
missing file or variable.
