# Minecraft → Enshrouded (rig runbook)

Decisions this follows:
- **Minecraft: archive the world and stop the server.** No site code is removed — the
  `/minecraft` page, whitelist API and Crafty client all stay in the repo until you decide.
- **Enshrouded access: sub-gated password, no rotation.** The `/enshrouded` page reveals
  the player password to logged-in subscribers only.

---

# Part 1 — Archive and shut down Minecraft

Do these in order. Step 2 is the only irreversible-risk step; don't skip the verify.

## 1. Stop the server (so the world saves clean)

Stop the **Cursed Walking** server from the Crafty panel (`https://<rig>:8444`) and wait
for it to report stopped. Stopping from the panel flushes the world; killing the process
or copying a running world can give you a torn save.

## 2. Back up the whole server folder, then VERIFY

The server folder is under `C:\Crafty\servers\<CRAFTY_SERVER_ID>` — the id is
`CRAFTY_SERVER_ID` in `server\.env`. Copy the **whole folder**, not just the world: it also
holds the modpack, configs and `whitelist.json`.

```powershell
$src = "C:\Crafty\servers\<CRAFTY_SERVER_ID>"
$dst = "D:\Backups\CursedWalking-$(Get-Date -Format yyyyMMdd)"
robocopy $src $dst /E /COPY:DAT /R:2 /W:2 /NFL /NDL
# verify: counts and size should match
"{0} files / {1:N1} MB" -f (Get-ChildItem $src -Recurse -File).Count, ((Get-ChildItem $src -Recurse -File | Measure-Object Length -Sum).Sum/1MB)
"{0} files / {1:N1} MB" -f (Get-ChildItem $dst -Recurse -File).Count, ((Get-ChildItem $dst -Recurse -File | Measure-Object Length -Sum).Sum/1MB)
```

Both lines must match. **Put a second copy somewhere off the rig** (external drive or
cloud) — a backup that lives only on the machine you're about to repurpose isn't a backup.

## 3. Disable the whitelist sync task

It runs every 15 minutes and will now fail forever against a dead server, filling the log
with noise and firing failures at the site feed.

```powershell
Disable-ScheduledTask -TaskName 'PhantomACE Minecraft Whitelist Sync'
Get-ScheduledTask -TaskName 'PhantomACE Minecraft Whitelist Sync' | Select-Object TaskName,State
```

`State` should read `Disabled`. (Disable, not unregister — re-enabling is one command if
you go back.)

## 4. Leave Crafty itself alone (or stop it)

Crafty only hosts the one server. You can leave the Crafty service running (it costs
little and keeps the panel available), or stop it to free RAM for Enshrouded:

```powershell
Get-Service | Where-Object { $_.Name -like '*crafty*' } | Select-Object Name,Status
# then, using the name it prints:
Stop-Service -Name '<crafty-service-name>'
```

Don't uninstall Crafty or delete the server folder — the archive decision is still open.

## 5. Close the Minecraft port

Firewall rule and router port-forward for **25566** should come down, so a dead port isn't
left answering the internet.

```powershell
Get-NetFirewallRule | Where-Object { $_.DisplayName -like '*minecraft*' -or $_.DisplayName -like '*25566*' } |
  Select-Object DisplayName,Enabled,Direction
# disable the ones that match:
# Disable-NetFirewallRule -DisplayName '<name>'
```
Then remove the 25566 forward on the router.

## 6. DNS — leave it for now

`mc.phantomace.tv` (A) and the `_minecraft._tcp` SRV stay put while the archive decision is
open; they'll just point at a closed port. Remove them when you decide Minecraft is done.

---

# Part 2 — Install the Enshrouded server

## 0. Check you have the headroom first

Official recommendation is **16 GB RAM** and an 8-core / 3.7 GHz CPU for a full 16 players
(6-core / 3.2 GHz for 4–6), plus **30 GB SSD**. The rig also runs Postgres, the Node site
and the Cloudflare tunnel.

```powershell
$os = Get-CimInstance Win32_OperatingSystem
"RAM total {0:N1} GB / free {1:N1} GB" -f ($os.TotalVisibleMemorySize/1MB), ($os.FreePhysicalMemory/1MB)
Get-CimInstance Win32_Processor | Select-Object Name,NumberOfCores,NumberOfLogicalProcessors
Get-PSDrive C | Select-Object Used,Free
```

If free RAM is tight, drop `slotCount` — each slot costs memory and CPU.

## 1. SteamCMD + the server

App id is **2278520** (the dedicated server, *not* the game's 1203620). Anonymous login;
no Steam account needed.

```powershell
# SteamCMD (skip if already installed)
New-Item -ItemType Directory -Path C:\steamcmd -Force | Out-Null
Invoke-WebRequest https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip -OutFile C:\steamcmd\steamcmd.zip
Expand-Archive C:\steamcmd\steamcmd.zip -DestinationPath C:\steamcmd -Force

# install / update the server
C:\steamcmd\steamcmd.exe +force_install_dir C:\Enshrouded +login anonymous +app_update 2278520 validate +quit
```

Re-run that same `app_update` line to patch the server after a game update.

## 2. Generate the config

Run `C:\Enshrouded\enshrouded_server.exe` **once** and close it. That writes
`enshrouded_server.json` next to the exe.

## 3. Configure it — read this part carefully

> **The dangerous default:** per Enshrouded's docs, *"If a group is enabled but no password
> is set, every player can freely join this server with the permission level of that
> particular group."* An empty-password group = an open server. **Every group you keep must
> have a password.** Delete the ones you don't want.

For a sub-gated server, keep exactly two groups: one for you/mods, one for subscribers.
Note the old top-level `"password"` line is **no longer used** for dedicated servers.

```json
{
    "name": "PhantomACE - Enshrouded",
    "saveDirectory": "./savegame",
    "logDirectory": "./logs",
    "ip": "0.0.0.0",
    "queryPort": 15637,
    "slotCount": 16,
    "gameSettingsPreset": "Default",
    "enableTextChat": true,
    "userGroups": [
        {
            "name": "Admin",
            "password": "<long random admin password — never published>",
            "canKickBan": true,
            "canAccessInventories": true,
            "canEditBase": true,
            "canExtendBase": true,
            "reservedSlots": 2
        },
        {
            "name": "Subscriber",
            "password": "<the password the site reveals to subs>",
            "canKickBan": false,
            "canAccessInventories": true,
            "canEditBase": true,
            "canExtendBase": true,
            "reservedSlots": 0
        }
    ]
}
```

`reservedSlots: 2` on Admin keeps two seats free so you and a mod can always get in even at
16/16. Give the Subscriber password to the site (Part 3) — **don't** post it in chat or
Discord, or the sub-gate is pointless.

## 4. Firewall + router

**UDP 15637** inbound (the query/game port). Some setups also want UDP 27015 for Steam.

```powershell
New-NetFirewallRule -DisplayName "Enshrouded 15637 UDP" -Direction Inbound -Protocol UDP -LocalPort 15637 -Action Allow
```
Then forward UDP 15637 on the router to the rig's LAN IP (`192.168.0.111`).

## 5. Run it as a service

Same pattern as `phantomace-web`, so it survives reboots:

```powershell
nssm install enshrouded-server "C:\Enshrouded\enshrouded_server.exe"
nssm set enshrouded-server AppDirectory "C:\Enshrouded"
nssm set enshrouded-server Start SERVICE_AUTO_START
nssm start enshrouded-server
nssm status enshrouded-server
```

Log output lands in `C:\Enshrouded\logs`.

## 6. DNS

Enshrouded has **no SRV support** — players type an address and port, so the port can't be
hidden the way the Minecraft SRV hid 25566.

| Type | Name | Content | Proxy |
|---|---|---|---|
| A | `ens` | the rig's public IP (`71.34.104.186`) | **DNS only** (grey cloud) |

Players then connect to **`ens.phantomace.tv:15637`**. Same exposure caveat as
`MINECRAFT-EXPOSURE.md`: this publishes the rack's IP, which `mcv.onlysands.tv` already does,
so it adds little — but it is a real A record pointing at your box.

## 7. Verify

- `nssm status enshrouded-server` → `SERVICE_RUNNING`
- Server appears in Enshrouded's server browser under its name
- A friend outside the LAN can join `ens.phantomace.tv:15637` with the Subscriber password
- Entering a wrong password is refused

---

# Part 3 — The site page

`/enshrouded` shows the address and the **Subscriber password to logged-in subscribers
only**. Non-subs see the pitch and a subscribe link; logged-out see a login prompt.

The password is stored server-side (never in page markup) and the API withholds it from
anyone who isn't a subscriber. When you change it on the server, update it on the site —
they are not linked automatically (no rotation, by decision).

## Known limits of this model

- **No whitelist exists in Enshrouded.** Access is a shared password; a sub who leaks it
  has given away access to everyone. Nothing on the site can prevent that.
- **Revoking a lapsed sub means changing the password** on the server and the site, which
  kicks out everyone until they re-read it.
- **16 players maximum**, hard engine cap.
