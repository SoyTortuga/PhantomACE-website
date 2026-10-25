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
- **One account = one route.** If two games share a YouTube channel, list both
  `gameIds` on the same route so the per-account cap covers them together.

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

Run daily, e.g. 09:00:

```
node C:\path\to\PhantomACE-website\server\clipper\run.js
```

with `DATABASE_URL`, `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`,
`TWITCH_BROADCASTER_ID`, the per-account `YT_*` / `TT_*`, and (if ffmpeg is not
on PATH) `FFMPEG_PATH` in the task's environment.

## Running it by hand

```
node server/clipper/run.js --dry-run            # list the pool + routing, no work
node server/clipper/run.js --dry-run --render    # also produce the MP4s to inspect
node server/clipper/run.js --limit 4             # a real run, cap at 4 this time
node server/clipper/run.js                        # the normal daily run
```

Dry-run renders are left in `CLIPPER_WORK` (default the OS temp dir under
`clipper/<slug>/short.mp4`) for review.

## Caveats

- **Clip download is unofficial.** Helix has no download endpoint; the source
  MP4 is derived from the clip's thumbnail URL. Stable in practice, but the
  first thing to break if Twitch changes that scheme — `twitch.js` throws
  loudly rather than posting a broken file.
- **Audio/music:** clips may contain copyrighted game/stream audio. YouTube and
  TikTok may mute or block such Shorts. Nothing here strips or replaces audio.
- The bot never reposts a clip once recorded; clearing `clipper_posted` in KV
  makes the whole pool eligible again.
