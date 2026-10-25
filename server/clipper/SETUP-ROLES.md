# Clipper — who does what: Owner vs. Developer

This splits Clipper setup between the **Owner** (the broadcaster, or anyone
acting with the broadcaster's account credentials and brand authority) and the
**Developer** (the person building and operating the bot on the broadcaster's
behalf).

**Guiding rule:** every account, developer app, channel, and refresh token that
represents the broadcaster is the **Owner's asset**. The Developer may drive the
mechanics, but these should be created under the Owner's (or their org's)
identity — never the Developer's personal accounts — so the Owner keeps control
and can revoke access at any time. The Developer owns the code and the rig.

## Division of actions

| # | Action | Owner | Developer | Notes |
|---|--------|:-----:|:---------:|-------|
| 1 | Authorize clips to be re-posted off-platform (brand/editorial decision) | ✅ | | The green light to run this at all. |
| 2 | Decide routing: which game → which account, cadence, hashtags, privacy | ✅ (decides) | ✅ (implements in `config.json`) | Editorial choices are the Owner's; wiring is the Developer's. |
| 3 | Twitch app credentials for reading clips | | ✅ | Reuses the site's existing `TWITCH_CLIENT_ID/_SECRET` + `TWITCH_BROADCASTER_ID`. **No new Owner action.** |
| 4 | Own / create the destination **YouTube channels** (one per game, or shared) | ✅ | | The Owner's channels. Developer can advise on the split. |
| 5 | Own the destination **TikTok account(s)** | ✅ | | The Owner's account(s). |
| 6 | Create the **Google Cloud project**, enable YouTube Data API v3, create the OAuth client | | ✅ | Should sit in an **Owner-owned** GCP org/account that the Developer is granted access to — not the Developer's personal project. |
| 7 | Accept the **YouTube API Services Terms** | ✅ | | Legally the account holder's acceptance. |
| 8 | **Grant YouTube consent** per channel → yields the refresh token | ✅ (clicks "Allow" signed in as the channel) | ✅ (runs the flow, captures the token) | Only the Owner can authenticate as their channel. Developer prepares the flow; Owner authorizes. Revocable anytime in Google account permissions. |
| 9 | Register the **TikTok developer app**, request Content Posting API scopes | ✅ (owns it) | ✅ (does the legwork) | Represents the brand → registered under the Owner's org. |
| 10 | Accept **TikTok Developer Terms** | ✅ | | Account holder's acceptance. |
| 11 | Submit the **TikTok app audit** (required before public posts) | ✅ (brand/identity review) | ✅ (prepares submission) | Until approved, posts are `SELF_ONLY`; the Owner/their team finishes them in-app. |
| 12 | **Authorize TikTok** account → yields the refresh token | ✅ (logs in, grants) | ✅ (runs the flow, captures the token) | Owner's credential; revocable in TikTok's authorized-apps settings. |
| 13 | Provide / approve branding assets (logo, frame, hashtags) | ✅ (approves) | ✅ (integrates) | Logo + font already in the repo. |
| 14 | Install **ffmpeg** on the rig | | ✅ | |
| 15 | Store the refresh tokens + client secrets in the **rig service env** | | ✅ | Developer handles storage; the tokens remain the Owner's and stay only on the Owner's rig. |
| 16 | Fill `config.json` (game IDs, account routing) | | ✅ | `node run.js --dry-run` lists game IDs. |
| 17 | Set up the **scheduled task**, deploy via `git pull` | | ✅ | |
| 18 | Monitor runs, handle failures, manage API quota, maintain the pipeline | | ✅ | Including the clip-download caveat in `README.md`. |
| 19 | Handle content/copyright takedowns, respond to platform strikes | ✅ | ✅ (flags/advises) | Platform actions land on the Owner's accounts. |

## The hand-off points (where both are needed at once)

Three steps need the Owner present to authenticate while the Developer runs the
mechanics — worth scheduling together:

- **#8 YouTube consent** — per channel. Developer opens the OAuth flow; Owner
  signs in to that channel's Google account and approves; Developer captures the
  refresh token into the rig env.
- **#11 TikTok audit** — Developer prepares the submission (app description,
  demo video, scope justification); Owner reviews and submits under the brand.
- **#12 TikTok authorization** — same pattern as #8.

## Credential custody (state this in writing with the broadcaster)

- The refresh tokens grant posting to the Owner's channels. Agree that they are
  stored **only** on the Owner's rig service environment, are never committed,
  and that the Owner can revoke them unilaterally (Google account → third-party
  access; TikTok → manage app permissions).
- If the Developer relationship ends: the Owner rotates `TWITCH_CLIENT_SECRET`,
  revokes the YouTube/TikTok grants, and removes the Developer's access to the
  GCP project and TikTok app — all of which they retain because the accounts are
  theirs.

## Minimum to go live on YouTube only (TikTok later)

If the audit will take time, you can ship YouTube first: do #1–#8, #13–#18, set
only the `YT_*` env vars, and leave the `TT_*` vars unset — each TikTok route
no-ops (logged, not an error) until its credentials exist.
