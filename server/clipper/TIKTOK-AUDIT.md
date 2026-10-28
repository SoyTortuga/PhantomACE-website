# TikTok Content Posting API — audit submission (draft)

Prepared by the developer; **reviewed and submitted by the broadcaster**, since
the app represents their brand. Until this is approved the API can only create
`SELF_ONLY` private drafts — which is why every route ships with
`"privacy": "SELF_ONLY"`.

Nothing here blocks YouTube. Ship YouTube first; submit this in parallel.

---

## Before submitting — checklist

- [ ] App created at TikTok for Developers under the **broadcaster's** account
      (not the developer's personal account)
- [ ] Products added: **Login Kit** and **Content Posting API**
- [ ] Scopes requested: `user.info.basic`, `video.upload`, `video.publish`
- [ ] Redirect URI registered (must match what `oauth-tiktok.js --redirect` uses)
- [ ] Privacy policy URL and Terms URL reachable (see below)
- [ ] Demo video recorded (see script below)
- [ ] `node server/clipper/scripts/doctor.js` shows the TikTok route connected

## App details (copy into the submission form)

**App name:** PhantomACE Clip Poster

**Category:** Content / Creator tools

**Short description:**
> An internal tool used solely by the PhantomACE Twitch channel to publish its
> own stream highlights to its own TikTok account. It takes clips created on the
> channel's Twitch broadcasts, reformats them to a 9:16 vertical video with the
> channel's branding, and posts them to the channel's TikTok account on a
> schedule.

**Who uses it:** Only the broadcaster (the account owner). It is not offered to
other users, has no sign-up, and posts to exactly one authorized account per
configured channel.

**How content is obtained:** Clips are created from the broadcaster's own
Twitch channel and retrieved through the official Twitch Helix API using the
channel's own credentials. No third-party or user-generated content from other
creators is posted.

## Scope justification

| Scope | Why it is needed |
|---|---|
| `user.info.basic` | Confirm which account was authorized, so a clip is never posted to the wrong account. |
| `video.upload` | Upload the rendered 9:16 MP4 to the authorized account. |
| `video.publish` | Publish the uploaded video (as a draft until audit approval, public after). |

No scope is used for reading other users' data, and the app never acts on an
account other than the one that explicitly authorized it.

## Demo video script (~60–90 seconds)

TikTok wants to see the end-to-end flow. Record a screen capture:

1. Show `server/clipper/config.json` — point out one route and its game.
2. Run `node server/clipper/scripts/oauth-tiktok.js --name TT_MAIN`; show the
   TikTok consent screen and the account approving it.
3. Run `node server/clipper/run.js --dry-run --render` and show the rendered
   vertical video that comes out (the branded 9:16 file).
4. Run a real post, then show the resulting video in the TikTok app's drafts.
5. State out loud: "This posts only to the PhantomACE account, using clips from
   the PhantomACE Twitch channel."

Keep the broadcaster's credentials off-screen.

## Privacy policy / terms

The submission needs reachable URLs. The site already serves suitable pages —
confirm these resolve before submitting, and add a line to the privacy page
noting that the channel publishes its own clips to its own social accounts:

- Privacy: `https://phantomace.tv/privacy.html`
- Terms / guidelines: `https://phantomace.tv/guidelines.html`

## After approval

1. Re-run `node server/clipper/scripts/oauth-tiktok.js --name <TT_NAME>` and
   confirm it now reports privacy levels beyond `SELF_ONLY`.
2. In `config.json`, change that route's `tiktok.privacy` to
   `"PUBLIC_TO_EVERYONE"`.
3. `node server/clipper/scripts/doctor.js` to confirm, then the next scheduled
   run posts publicly. No code change required.
