# Connecting the channels without a call

The broadcaster has to approve access themselves — nobody can do that part for
them. But it can be done over messages in a few minutes, with no screen share.

**Do this when they're actually at their desk.** The code they send back
expires within minutes and works only once.

Repeat the whole cycle **once per channel**.

---

## 1. Generate the link (you)

```
node server/clipper/scripts/oauth-youtube.js --name YT_MTG --print-url
```

`YT_MTG` → the **PhantomACEMTG** channel.
`YT_GAMES` → the **PhantomACEtoo** channel.

Do them one at a time so the links can't get mixed up.

## 2. Message to send (template)

Paste the link in where it says, and send. Reword it however you normally talk
to them — the only bits that matter are *which account to sign into*, and that
the scary warning and the error page are both supposed to happen.

> Hey! Got the clip bot ready to hook up to **PhantomACEMTG**. Takes about two
> minutes — but do it when you're actually sat at a computer, the link goes
> stale pretty fast.
>
> 1. Open this: `<paste the URL>`
> 2. Make sure you're signed into the Google account that owns PhantomACEMTG.
>    If you've got a few accounts floating around, easiest thing is to open it
>    in an incognito window.
> 3. Google will throw up a scary-looking *"hasn't verified this app"* screen.
>    That's just because it's a tool I built for you rather than something
>    published publicly. Click **Advanced** → **Go to PhantomACE Clipper**.
> 4. Hit **Allow**. All it can do is upload videos to that one channel.
> 5. Your browser will then land on an error page — "can't reach this site" or
>    similar, with `127.0.0.1` in the address. That's meant to happen, you
>    haven't broken anything.
> 6. Copy the whole address out of the address bar and send it over. That's the
>    only bit I need.
>
> That's it, I'll take it from there. You can unhook it whenever you like from
> your Google account settings, and I never see your password.

For the second channel, same message with **PhantomACEtoo** swapped in.

### TikTok version (later)

Same shape, once the TikTok app exists:

> Hey! Same deal as the YouTube one, this time for TikTok. Two minutes, and
> again do it while you're at a computer.
>
> 1. Open this: `<paste the URL>`
> 2. Sign in as the TikTok account the clips should post to, and approve it.
> 3. You'll land on a page that probably looks broken or 404s — that's fine.
> 4. Copy the whole address from the address bar and send it over.
>
> Heads up: until TikTok approves the app, anything it makes shows up as a
> **private draft** in your TikTok app rather than going live — so you'll get
> the final say on each one for now.

## 3. Exchange what they send back (you)

```
node server/clipper/scripts/oauth-youtube.js --name YT_MTG --code "<the address they sent>"
```

It prints **AUTHORIZED CHANNEL** — check it says the channel you expected
before using the token. A token for the wrong channel is perfectly valid and
would silently post to the wrong place.

Then paste the printed `YT_MTG_REFRESH_TOKEN=` line into `server/.env`.

## 4. Repeat for the other channel, then

```
node server/clipper/scripts/doctor.js
```

---

## What you need from the broadcaster, in total

| # | What | Why |
|---|---|---|
| 1 | Confirmation that clips may be posted, and to which channels | The go-ahead |
| 2 | The channels existing (**PhantomACEMTG**, **PhantomACEtoo**) | Somewhere to post |
| 3 | One redirected address per channel (step 2 above) | Becomes the refresh token |
| 4 | *(TikTok only)* an app registered under their TikTok account, plus the same approve-and-send step | TikTok posting |

**You never need their password**, and you never need them on a call.

## If the code expires

They took too long, or used it twice. No harm: run `--print-url` again and send
a fresh link. Nothing needs undoing.

## If they're signed into the wrong Google account

The script prints the channel it actually authorized. If it's wrong, have them
redo it in an incognito window, signed into the right account. Discard the
wrong token — don't paste it anywhere.

## The fully hands-off alternative

If this round trip gets tedious (new channels, re-auth later), the broadcaster
can add your Google account as a **Manager** on the Brand Account that owns the
channels. You could then authorize without involving them at all, picking the
channel at the consent screen.

The trade-off: the token is then tied to *your* account rather than theirs, so
it breaks if your access is ever removed, and it is worse for custody — the
whole point of the arrangement is that the broadcaster owns the credentials.
Prefer the round trip above; keep this in reserve.
