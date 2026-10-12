# Putting the Minecraft server on the domain without publishing the IP

The subscriber Minecraft server runs **on the rig**, which also serves
production `phantomace.tv`. That one fact drives everything below.

**Run this off-stream.** The router change and the first connection test are
the risky parts; neither is interesting to watch.

---

## The thing to understand first

> **Corrected 2026-10-12.** This document was first written believing the rig
> was a machine on a connection whose IP had never been published. It is a
> **shared rack**, and another server on it — OnlySands — publishes
> `mcv.onlysands.tv` as a plain A record to the rack's public address
> (`71.34.104.186`, CenturyLink broadband, Portland; its website is behind
> Cloudflare but the game subdomain is not). So **the address is already
> public**, and was before PhantomACE's Minecraft server existed.
>
> Confirm from the rig with:
> `(Invoke-RestMethod 'https://api.ipify.org?format=json').ip`
> If that matches, everything below about "not spending the advantage" is
> moot — the advantage is already spent, and the decision is a different one.
> See **Shared rack, shared fate** at the end.

The rig has **no inbound port open and its own IP in no DNS record of ours**.
The Cloudflare Tunnel is outbound-only and Node binds to `127.0.0.1`, so
nothing *we* publish points at it.

Minecraft Java is raw TCP. That means:

- **A subdomain alone hides nothing.** `mc.phantomace.tv` as an A record is a
  public lookup — `nslookup` returns the IP in one second.
- **Cloudflare's orange cloud cannot carry it.** The proxy is HTTP/HTTPS only,
  so the record has to be grey-cloud "DNS only", which is the exposed case.
- **The existing tunnel cannot carry it either.** `cloudflared` does do
  arbitrary TCP, but the *player* would have to run `cloudflared access tcp`
  locally. Fine for you, useless for viewers.
- **Cloudflare Spectrum** can, and supports Minecraft on Pro/Business — but
  it is metered (5 GB/month on Pro, then $1/GB). Minecraft eats that in
  evenings. Wrong tool.

So the answer is a Minecraft-aware TCP proxy in front: **TCPShield**, free
tier, Java on all plans, custom domain via a single CNAME.

### What that does and does not buy

| Threat | Protected? |
|---|---|
| Someone reads the IP out of DNS | **Yes** — DNS points at TCPShield, never at the rig |
| Someone who learns the IP joins directly | **Yes** — the firewall allowlist refuses them, and the TCPShield plugin blocks direct joins as well |
| Someone who learns the IP floods the uplink | **No.** Nothing on this side helps |

That last row is the one that matters. A volumetric attack aimed at the home
IP saturates the same line that serves `phantomace.tv`, and the website goes
down with the game. **The only defence is that the address stays unknown.**

Which *would* mean: never publish an A record for the rig. But see the
correction above — if the rack's address is already in DNS via a neighbour,
then putting our own record alongside it adds very little, and the useful
work moves from "keep it secret" to "stop sharing a fate". Read **Shared
rack, shared fate** before choosing.

---

## 1. TCPShield

Create a free account, add a network, and set the backend to the rig's **WAN
IP and port 25565**. Add `mc.phantomace.tv` as a domain. The panel gives you a
hostname to point DNS at.

## 2. Cloudflare DNS

| Type | Name | Target | Proxy |
|---|---|---|---|
| CNAME | `mc` | the hostname TCPShield gave you | **DNS only (grey)** |

Orange-clouding it will not work — Cloudflare will not proxy a Minecraft
connection, and the record exists only to hand players TCPShield's address.

Optional, so players can type `mc.phantomace.tv` with no `:25565`:

| Type | Name | Service | Proto | Port | Target |
|---|---|---|---|---|---|
| SRV | `mc` | `_minecraft` | `_tcp` | 25565 | the same TCPShield hostname |

TCPShield's own checklist notes SRV records sometimes fail to resolve for
some clients; if someone cannot connect, have them try `mc.phantomace.tv:25565`
explicitly before you go looking for a real fault.

## 3. Router

Forward TCP **25565** to the rig's LAN address. This is unavoidable for
home hosting and is the step that creates the exposure described above.

## 4. Firewall — the step that actually protects the website

Everything above is cosmetic if the port answers the whole internet. From an
**elevated** PowerShell on the rig:

```bash
.\server\scripts\sync-tcpshield-firewall.ps1
```

That is a dry run: it fetches TCPShield's published ranges from
`tcpshield.com/v4`, lists anything already open that could bypass them, and
writes nothing. Re-run with `-Apply` to create the rule.

Two things it is watching for:

- **The rule Windows offers to make for you.** Starting a Java server pops
  "allow Java to communicate on this network", and clicking yes writes an
  allow-from-anywhere rule that silently undoes all of this. The script flags
  any rule that names port 25565 or lets `java.exe`/`javaw.exe` accept from
  anywhere. Delete those.
- **A shrinking allowlist.** It compares the fetched list against the rule in
  force and refuses to quietly narrow it, because a captive portal or an error
  page would otherwise lock every player out.

TCPShield's ranges change, so **put this on a scheduled task** (daily is
plenty) with `-Apply`. A stale list fails closed — players get refused rather
than strangers getting in — which is the right direction, but it is still an
outage.

## 5. `server.properties`

- `prevent-proxy-connections=false` — this one is the classic gotcha. Left
  true, the server checks that the connecting IP matches the one Mojang's
  session server saw; behind any proxy it will not, and players are rejected
  with an authentication error that looks like a login problem. *(Not stated
  in TCPShield's docs — it is the standard fix for that symptom. If logins
  fail with an auth error right after cutover, this is the first thing to
  check.)*
- `online-mode=true` — keep it. TCPShield is a TCP proxy, not an auth proxy;
  Mojang authentication still works and turning it off would let anyone in
  under any name.

## 6. Real player IPs

Without help, every player appears to come from TCPShield, which breaks IP
bans and confuses anti-VPN plugins. Use **either** the TCPShield plugin
**or** proxy protocol — their docs are explicit that the two cannot coexist,
and the plugin goes on one server only, not on both a proxy and a backend.

---

## Verify

From a connection that is **not** your home network (phone hotspot):

1. `mc.phantomace.tv` connects and you can play.
2. The raw IP on 25565 is **refused**. If it connects, step 4 did not take —
   stop and fix it before telling anyone the address.
3. `nslookup mc.phantomace.tv` returns TCPShield, not your IP.
4. `https://phantomace.tv/api/health` still returns `ok:true` — the new
   firewall rule must not have disturbed the tunnel.

## If it goes wrong

Fastest shutdown, in order: disable the firewall rule
(`Disable-NetFirewallRule -DisplayName 'Minecraft (TCPShield only)'`), then
remove the router port-forward. The website is unaffected by both.

---

## Still outstanding

- **Resource contention.** Minecraft's heap and its stop-the-world GC now share
  a box with Postgres and the Node server. Watch site latency on a busy
  evening; if it bites, the fix is moving Minecraft off the rig, which also
  removes the uplink risk entirely.
- **The whitelist.** Nothing above decides *who* may join. The site already
  verifies subscriber status at login against `helix/subscriptions/user` using
  the viewer's own `user:read:subscriptions` scope, so it can hold a Minecraft
  username per subscriber and serve a whitelist the server syncs, with lapsed
  subs ageing out on their own. Not built — see the note in
  `server/scripts/sync-tcpshield-firewall.ps1` and ask.

---

## Shared rack, shared fate

The rig is one tenant in a rack behind a single broadband connection, and at
least one neighbour publishes that connection's IP in DNS.

What follows from that:

- **Option A costs us almost nothing extra.** The address is already out, so
  an `mc.phantomace.tv` A record beside `mcv.onlysands.tv` is not the moment
  the secret is lost. That moment has passed.
- **TCPShield in front of our server alone achieves little for the uplink.**
  It would still stop direct joins to our port, which is worth having — but
  the flood risk is a property of the *connection*, and the neighbour's record
  keeps that address published whatever we do.
- **The single point of failure is live today.** One saturating attack on that
  line takes down phantomace.tv, both Minecraft servers, and everything else
  in the rack. Nothing in this repo can fix that alone.

So the real conversation is with whoever runs OnlySands, and it is about the
connection rather than about either game server:

1. **Both behind a proxy, or neither.** Half-measures protect nobody, because
   one published record re-exposes the shared address.
2. **Their Cloudflare is currently decorative if the web server shares this
   IP.** `onlysands.tv` is proxied, but `mcv.onlysands.tv` hands out the
   origin — which is the standard way a Cloudflare origin gets found and hit
   directly. Worth telling them regardless of what we decide about Minecraft.
3. **If the rack matters, it wants its own answer** — a business line with
   upstream DDoS mitigation, or the game servers moved off it — rather than
   per-service patching.

Until that conversation happens, option A is a reasonable choice here, because
the exposure it creates already exists. What it is NOT is a safe default to
reach for again later on a connection that has stayed private.
