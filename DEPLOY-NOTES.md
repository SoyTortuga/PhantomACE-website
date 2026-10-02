# Deploy Notes — PhantomACE (self-hosted rig)

The rig **is** production `phantomace.tv` (self-hosted Node + Postgres; no Cloudflare
Pages). Deploying = `git pull` on the rig. All commands below run **on the rig, in
PowerShell**, from the repo root:

```
cd C:\Users\EZiRLS8\Documents\PhantomACE-Website
```

## When a restart is needed

- **Static changes** (anything under `assets/`, `css/`, `js/`, `games/`, or a root
  `*.html`): `git pull` + a hard-refresh in the browser. No restart — files are read
  from disk per request.
- **Server changes** (anything under `functions/` or `server/`): `git pull` **plus**
  `nssm restart phantomace-web`.

Standard full deploy (safe whenever server files changed):

```
git pull; nssm restart phantomace-web
```

## One-time actions a pull can't do

These are not part of `git pull` — run them once when the relevant feature first ships.

### Giveaway reward pool (per-rarity slots)
Skull Clicker giveaways use a pool of 3 rewards per rarity, each capped by Twitch at
one redemption per user per stream. First delete any hand-made "Enter Rare Giveaway" /
"Enter Mythic Giveaway" rewards in the Twitch creator dashboard so the app can own the
new ones, then create the pool and verify all six are `MANAGEABLE`:

```
node server/scripts/giveaway-rewards.js --service phantomace-web --create --confirm
node server/scripts/giveaway-rewards.js --service phantomace-web
```

### Cloudflare cache purge (reused asset filenames)
When an image is replaced under its existing filename (e.g. the Mana Clash banner),
the Cloudflare edge keeps serving the old one. Purge the specific URL in the Cloudflare
dashboard → Caching → Purge (or Purge Everything), then hard-refresh. Example:
`https://phantomace.tv/assets/images/game-mana-clash.png`.

### Broadcaster OAuth re-authorization
The activity feed and EventSub subscription status need the broadcaster's expanded
scopes. Complete Step 2 in `/api/admin/bot-setup`, signed in as the broadcaster, once.

### Minting a badge code
Badges are minted by hand against the production DB, e.g. the mini-golf spectator badge
(24-hour claim window):

```
node server/scripts/mint-badge-code.js --badge mini-golf --days 1 --confirm --service phantomace-web
```

## Automatic — no action required

- **Month-end resets.** Skull Clicker's monthly progress reset ("wipe the run, keep the
  legacy") and every game's leaderboard reset fire automatically on the **Pacific**
  (America/Los_Angeles) month boundary — the shared season calendar in
  `functions/api/season-time.js`, not UTC. Nothing to run at month-end.
- Skull Clicker leaderboards are **display-only** (no prizes); monthly prize codes come
  only from Memory Match, Commander Bingo, Mana Clash (score + wins), PhamShock, MTGBBB.

## Post-deploy smoke check (hard-refresh first)

- **Skull Clicker**: the Grimoire / Cursed Garden / Hallowtide tabs render; the Reaping
  tab shows per-automation ON/OFF toggles; each system has a "❔ How it works" dropdown;
  the season board reads "bragging rights only" (no prize promise).
- **Dino Park**: renders all 5 tabs in a small/narrow window.
- **Header**: the account and notification flyouts open upward without clipping off the
  bottom of the screen.
- **Giveaway**: opening a Rare draw from Bot Control enables exactly one slot reward;
  a second redemption by the same user is blocked by Twitch.
- Confirm `/_private/giveaway-codes/*` still 404s.
