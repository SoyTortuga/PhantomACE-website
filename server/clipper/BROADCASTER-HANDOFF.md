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

> Hey — ready to connect **PhantomACEMTG** to the clips bot. Two minutes, and
> I need you at a computer right now because the link is time-sensitive.
>
> 1. Open this link: `<paste the URL>`
> 2. **Sign in to the Google account that owns PhantomACEMTG** — this is the
>    important bit; if you're signed into a different account, use an incognito
>    window.
> 3. You'll see a warning saying *"Google hasn't verified this app."* That's
>    expected — it's the tool I built for you. Click **Advanced**, then
>    **Go to PhantomACE Clipper (unsafe)**.
> 4. Approve the permission (it only allows uploading videos to that channel).
> 5. Your browser will then show an **error page** — something like "can't
>    reach this site" at an address starting `127.0.0.1`. **That is normal,
>    nothing broke.**
> 6. Copy the **entire address from the address bar** and send it to me.
>
> That's it. I'll handle the rest. You can disconnect this any time from your
> Google account settings, and I never see your password.

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
