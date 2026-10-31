# Clipper — Twitch clips → YouTube Shorts & TikTok

A standalone worker that, on a schedule, turns the channel's top Twitch clips
into 1080×1920 vertical Shorts (blurred fill + gothic PhantomACE frame) and
auto-posts them to YouTube and TikTok, **routing each clip to a different
account based on the game it was clipped under**.

It is application code (ships via `git pull`); the OAuth tokens, ffmpeg, and the
scheduled task are rig setup and live only on the rig (the `server` domain).

```
run.js            orchestrator: select → route → render → publish → record
config.js         game → account routing (loads config.json)
twitch.js         find the clip pool (Helix), resolve games, download the MP4
render.js         ffmpeg: 16:9 clip → gothic 9:16 Short
publish/youtube.js  Data API resumable upload (one account per credsEnv)
publish/tiktok.js   Content Posting API (one account per credsEnv)
state.js          the `clipper_posted` ledger — never repost a clip
env-boot.js       loads server/.env (+ --service overlay) for the scripts

scripts/
  doctor.js         preflight: what is ready, what is missing
  list-games.js     what is in the clip pool + emit a config.json scaffold
  oauth-youtube.js  one-time consent → a channel's refresh token
  oauth-tiktok.js   one-time consent → an account's refresh token
```

## Setup order (developer)

**→ For the full click-by-click version, follow `SETUP-WALKTHROUGH.md`.**
The summary below is the shape of it.

Everything except steps 3 and 5 can be done **before the broadcaster is
involved**. See `SETUP-ROLES.md` for the full split and
`BROADCASTER-SETUP.md` for the handout.

```
1.  install ffmpeg on the rig
2.  node server/clipper/scripts/list-games.js            # what games exist
    node server/clipper/scripts/list-games.js --emit-config > server/clipper/config.json
    …then edit config.json: merge games onto shared accounts, drop the rest
3.  (broadcaster) create the destination channels/accounts
4.  create the Google Cloud OAuth client + the TikTok app
5.  (broadcaster at the keyboard, ~30 min)
    node server/clipper/scripts/oauth-youtube.js --name YT_MTG
    node server/clipper/scripts/oauth-tiktok.js  --name TT_MTG
    …paste the printed env lines into server/.env
6.  node server/clipper/scripts/doctor.js                # confirm readiness
7.  node server/clipper/run.js --dry-run --render        # eyeball a render
8.  powershell -File server/scripts/install-clipper-task.ps1 -DryRun
    …then re-run without -DryRun to go live
```

## How selection works

- The pool is every clip from the **last `lookbackDays` days** (default 365),
  highest-view first (Helix paginates in view order).
- Each clip's `game_id` is the Twitch **category at clip time**. `config.json`
  maps it to a route (an account + hashtags). Unmatched games use `fallback`,
  or are skipped if there is no fallback.
- Per run the bot posts the top **`perAccount`** (default 2) not-yet-posted
  clips **for each account**, capped at `maxPerRun` total. A 12-month backlog
  therefore drains ~2 per account per run.
- **Fresh hits jump the queue.** A clip newer than `trending.withinDays` with
  at least `trending.minViews` is scheduled ahead of the backlog — otherwise a
  year-old clip with one more lifetime view outranks a clip that is taking off
  right now.

## Scheduling

The bot runs daily but publishes **a week ahead**: each run uploads that day's
clips with YouTube's `status.publishAt` set to `schedule.daysAhead` days out,
at `schedule.times` in `schedule.timezone`. The schedule stays a week deep and
the broadcaster can see what is queued in YouTube Studio.

**Why not upload a whole week in one go.** `videos.insert` costs ~1600 quota
units against a 10,000/day default — about six uploads a day. A real weekly
batch (2 posts x 7 days x 2 accounts = 28 uploads) is ~44,800 units and would
fail partway through. Uploading daily, dated a week out, gives the same
schedule depth at ~4 uploads/day. **A third account would put you at ~9,600
units/day — effectively the ceiling.**

A scheduled upload goes up **private** and YouTube flips it public at the
instant; the route's `privacy` describes what it becomes, not what it starts
as. YouTube rejects `publishAt` on an already-public video and ignores it on an
unlisted one, which would publish a week early with nothing in the response to
say so — hence the private upload.

**TikTok has no scheduling API**, so TikTok posts same-day. Before the audit
clears it is a private draft anyway, which the broadcaster publishes whenever
they like.

The scheduled task's own run time (`-At` on the installer) only decides when
the bot *works*; it no longer decides when anything goes live.
- **One account = one route.** If two games share a YouTube channel, list both
  `gameIds` on the same route so the per-account cap covers them together.
- **`exclude`** lists categories that never leave Twitch (IRL, Just Chatting,
  Music…). It is checked *before* the routes and *before* the fallback, so a
  catch-all fallback cannot sweep them up. This is what lets the fallback stay
  a true catch-all: a new game you start streaming routes itself with no config
  change, while the excluded categories stay excluded.

## 1. Prerequisite: ffmpeg on the rig

Install ffmpeg and either put it on `PATH` or set `FFMPEG_PATH` to the exe.
Verify: `ffmpeg -version`.

## 2. config.json

```
cp server/clipper/config.example.json server/clipper/config.json
```

Fill in your games and the `credsEnv` names. To discover a game's id:

```
node server/clipper/run.js --dry-run
```

That lists each clip in the pool with its game id and name — no Postgres, no
uploads. `config.json` is gitignored; it holds no secrets (only credsEnv names).

## 3. YouTube credentials (per channel)

Each destination channel needs its own **refresh token**. One-time, per channel:

1. In Google Cloud, create a project, enable **YouTube Data API v3**, and make
   an **OAuth client** (type: Desktop or Web) → client id + secret.
2. Add the channel's Google account as a test user (or publish the consent
   screen) with scope `https://www.googleapis.com/auth/youtube.upload`.
3. Do the consent flow once to obtain a **refresh token** for that channel
   (Google's OAuth Playground, or a small local script — see Google's "Using
   OAuth 2.0 for installed apps").
4. Put them in the service environment under the route's `credsEnv`:

```
YT_MTG_CLIENT_ID=...
YT_MTG_CLIENT_SECRET=...
YT_MTG_REFRESH_TOKEN=...      # the MTG channel's refresh token
```

Quota: `videos.insert` costs ~1600 units; the default 10,000/day budget per
project covers a handful of Shorts. High volume → raise the quota or split
channels across projects.

## 4. TikTok credentials (per account) — READ THE AUDIT NOTE

1. Register an app at TikTok for Developers, add the **Content Posting API**,
   request scopes `video.publish` and `video.upload`.
2. Authorize each posting account once to get a **refresh token**.
3. Put them under the route's `credsEnv`:

```
TT_MTG_CLIENT_KEY=...
TT_MTG_CLIENT_SECRET=...
TT_MTG_REFRESH_TOKEN=...
```

**Audit gate:** until TikTok **audits** your app, the API can only post as
`SELF_ONLY` (a private draft the creator then finishes in-app). The config
defaults TikTok to `SELF_ONLY` for exactly this reason. After audit, set
`"privacy": "PUBLIC_TO_EVERYONE"` on each route's `tiktok` block. The bot also
reads the account's allowed privacy levels and downgrades to `SELF_ONLY` rather
than failing if a level is not yet permitted.

An account with no creds set is **skipped** (logged, not an error), so you can
turn YouTube on first and add TikTok later.

## 5. Postgres

A real run records the ledger in the same Postgres the site uses. Set
`DATABASE_URL` on the scheduled task (or run `--service` style as the other rig
scripts do). A dry run does not need it.

## 6. Schedule it (Windows Task Scheduler)

```
powershell -NoProfile -ExecutionPolicy Bypass -File .\server\scripts\install-clipper-task.ps1 -DryRun
```

Registers a daily SYSTEM task that logs to `server/clipper/logs/clipper.log`.
Start with `-DryRun` (lists, posts nothing), then re-run without it to go live.

The task needs no environment plumbing: `env-boot.js` loads `server/.env`, and
`--service phantomace-web` (which the installer passes) overlays the
**production** `DATABASE_URL` from the service's own environment block —
`server/.env` holds the dev connection string, so this is deliberate and
matches the other rig scripts. Put the `YT_*` / `TT_*` families and
`FFMPEG_PATH` in `server/.env`.

## Running it by hand

```
node server/clipper/run.js --dry-run            # list the pool + routing, no work
node server/clipper/run.js --dry-run --render    # also produce the MP4s to inspect
node server/clipper/run.js --limit 4             # a real run, cap at 4 this time
node server/clipper/run.js                        # the normal daily run
node server/clipper/run.js --service phantomace-web   # against production KV

node server/clipper/scripts/doctor.js            # readiness check
node server/clipper/scripts/doctor.js --live     # …and really call Twitch
node server/clipper/scripts/list-games.js        # the pool, by game
```

Dry-run renders are left in `CLIPPER_WORK` (default the OS temp dir under
`clipper/<slug>/short.mp4`) for review.

## Caveats

- **Clip download is unofficial.** Helix has no download endpoint, and the file
  cannot be derived from anything Helix returns: Twitch serves clips from a
  separate CDN under a **signed, expiring** url. So `twitch.js` asks Twitch's
  **GQL endpoint** — the one its own web player uses — with Twitch's public web
  client id. This is undocumented, used deliberately and with the broadcaster's
  agreement, and is the only way to automate posting their own clips. Expect it
  to break one day; `downloadClip()` throws loudly rather than posting a broken
  file, and `clipSourceUrl()` is the only function that would need replacing.
  (Clips still on the old CDN derive from their thumbnail, kept as a fallback.)
- **Audio/music:** clips may contain copyrighted game/stream audio. YouTube and
  TikTok may mute or block such Shorts. Nothing here strips or replaces audio.
- The bot never reposts a clip once recorded; clearing `clipper_posted` in KV
  makes the whole pool eligible again.
