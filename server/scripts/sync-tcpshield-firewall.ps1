<#
  ══════════════════════════════════════════════
   MINECRAFT PORT — OPEN TO TCPSHIELD, SHUT TO EVERYONE ELSE

     .\server\scripts\sync-tcpshield-firewall.ps1            show what would change
     .\server\scripts\sync-tcpshield-firewall.ps1 -Apply     write the rule

   WHY THIS IS A SCRIPT AND NOT A ONE-OFF CLICK. The rig serves
   phantomace.tv over an outbound-only Cloudflare Tunnel, so until Minecraft
   there was no inbound port at all and the home IP was in no DNS record
   anywhere. Port 25565 is the first hole in that, and it sits on the same
   home uplink as production.

   TCPShield in front means players never learn the IP. That only holds
   while the port refuses everyone except TCPShield — otherwise the proxy
   is a suggestion, and the first person to find the address connects
   straight past it.

   THEIR RANGES CHANGE. The allowlist is fetched from tcpshield.com/v4 (the
   list their own setup checklist points at) and re-applied, so run this on
   a schedule. A stale list fails CLOSED — players get refused — which is
   the right direction for a mistake to fall, but it is still an outage, so
   it is worth a scheduled task rather than remembering.

   WINDOWS FIREWALL: ALLOW ONLY, NEVER A MATCHING BLOCK. The default
   inbound action is already Block, so one scoped Allow rule is the whole
   policy. Adding a Block rule for the same port would WIN over the Allow —
   block beats allow in Windows — and nobody could connect at all.

   THE RULE THIS IS REALLY GUARDING AGAINST is the one Windows offers to
   create for you. Start a Java server and Windows pops "allow Java to
   communicate on this network"; clicking yes writes an allow-from-anywhere
   rule for the whole java.exe, which silently undoes everything here. This
   script reports any such rule it finds.
  ══════════════════════════════════════════════
#>

param(
  [switch]$Apply,
  [int]$Port = 25565,
  [string]$RuleName = 'Minecraft (TCPShield only)',
  [string]$ListUrl = 'https://tcpshield.com/v4'
)

$ErrorActionPreference = 'Stop'

function Step($m) { Write-Host "`n== $m" -ForegroundColor Cyan }
function Bad($m)  { Write-Host $m -ForegroundColor Red }
function Warn($m) { Write-Host $m -ForegroundColor Yellow }
function Good($m) { Write-Host $m -ForegroundColor Green }

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
         ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($Apply -and -not $admin) { Bad 'Run this from an elevated PowerShell to apply.'; exit 1 }

# ── Fetch the allowlist ─────────────────────────────────────────────────
Step "Fetching TCPShield ranges from $ListUrl"
try {
  $body = (Invoke-WebRequest -Uri $ListUrl -UseBasicParsing -TimeoutSec 20).Content
} catch {
  Bad "Could not fetch the list: $($_.Exception.Message)"
  Bad 'Nothing changed. The existing rule is left exactly as it was.'
  exit 1
}

# One CIDR or address per line. Anything that is not one is ignored rather
# than passed to the firewall, which would reject the whole rule.
$ranges = $body -split "`r?`n" |
  ForEach-Object { $_.Trim() } |
  Where-Object { $_ -match '^\d{1,3}(\.\d{1,3}){3}(/\d{1,2})?$' }

if ($ranges.Count -lt 1) {
  Bad 'The list came back with no usable addresses. Refusing to write a rule that would allow nothing.'
  exit 1
}
Write-Host "$($ranges.Count) range(s): $($ranges -join ', ')"

# The list is SHORT by design - it was two /24-ish blocks when this was
# written - so an absolute "too few" threshold is just a false alarm. What
# actually signals a bad fetch (a captive portal, an error page) is the list
# SHRINKING against the rule already in force.
$current = $null
try {
  $current = (Get-NetFirewallRule -DisplayName $RuleName -ErrorAction Stop | Get-NetFirewallAddressFilter).RemoteAddress
} catch { }
if ($current -and $current -ne 'Any' -and $ranges.Count -lt $current.Count) {
  Warn "The applied rule has $($current.Count) range(s) and this fetch returned $($ranges.Count)."
  Warn "Check $ListUrl by hand before applying - a shrinking list locks players out."
}

# ── What else could let the world onto this server ──────────────────────
# NARROW ON PURPOSE. Every per-application rule Windows writes carries
# LocalPort "Any", so matching on that lists every game the machine has
# ever launched and tells you to delete Remote Assistance. Only two kinds
# of rule actually bear on this: one that names THIS PORT, and one that
# lets the Java process accept from anywhere on any port.
Step "Inbound allow rules that could expose the server"

if (-not $admin) {
  Warn '  Reading the firewall needs elevation - skipping this audit.'
  Warn '  Re-run from an elevated PowerShell to see what is already open.'
} else {
  $risky = @()
  foreach ($r in (Get-NetFirewallRule -Direction Inbound -Enabled True -Action Allow -ErrorAction SilentlyContinue)) {
    if ($r.DisplayName -eq $RuleName) { continue }
    $addr = ($r | Get-NetFirewallAddressFilter).RemoteAddress
    if ($addr -notcontains 'Any') { continue }              # already scoped: not a hole
    $ports = ($r | Get-NetFirewallPortFilter)
    $app   = ($r | Get-NetFirewallApplicationFilter).Program

    $namesPort = $ports | Where-Object { $_.Protocol -eq 'TCP' -and $_.LocalPort -contains "$Port" }
    # The file name, not a regex over the whole path: matching a path
    # separator means escaping a backslash, and that is one more thing to
    # get wrong in a rule that decides who can reach this machine.
    $leaf      = ''
    if ($app) { $leaf = (Split-Path $app -Leaf).ToLower() }
    $isJava    = ($leaf -eq 'java.exe') -or ($leaf -eq 'javaw.exe') -or ($app -and $app -match '(?i)minecraft')
    if ($namesPort) { $risky += [pscustomobject]@{ Rule = $r.DisplayName; Why = "allows TCP $Port from anywhere" } }
    elseif ($isJava) { $risky += [pscustomobject]@{ Rule = $r.DisplayName; Why = "lets $app accept from anywhere" } }
  }

  if ($risky) {
    foreach ($x in $risky) {
      Warn "  $($x.Rule)  -  $($x.Why)"
    }
    Warn ''
    Warn '  Any one of these lets somebody who learns the IP connect straight past TCPShield.'
    Warn '  Check each before removing it - a name you recognise may belong to something else:'
    Warn "      Get-NetFirewallRule -DisplayName '<name>' | Get-NetFirewallApplicationFilter"
    Warn "      Remove-NetFirewallRule -DisplayName '<name>'"
  } else {
    Good '  None. Nothing else opens this port or the Java process to the world.'
  }
}

# ── Apply ───────────────────────────────────────────────────────────────
$existing = Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue

if (-not $Apply) {
  Step 'Dry run'
  if ($existing) {
    Write-Host "Would update '$RuleName' to the $($ranges.Count) range(s) above."
  } else {
    Write-Host "Would create '$RuleName' allowing TCP $Port from those $($ranges.Count) range(s)."
  }
  Write-Host 'Re-run with -Apply (elevated) to write it.'
  exit 0
}

if ($existing) { Step "Updating '$RuleName'" } else { Step "Creating '$RuleName'" }
if ($existing) {
  Set-NetFirewallRule -DisplayName $RuleName -RemoteAddress $ranges -Enabled True -Action Allow
} else {
  New-NetFirewallRule -DisplayName $RuleName -Direction Inbound -Action Allow `
    -Protocol TCP -LocalPort $Port -RemoteAddress $ranges -Profile Any | Out-Null
}

# Read it back. -RemoteAddress silently normalises, and a rule that did not
# take is indistinguishable from one that did until somebody cannot connect.
$after = (Get-NetFirewallRule -DisplayName $RuleName | Get-NetFirewallAddressFilter).RemoteAddress
if (-not $after -or $after -contains 'Any') {
  Bad 'The rule did not take the allowlist - it is allowing any source. Fix before leaving this.'
  exit 1
}
Good "Applied. TCP $Port accepts $($after.Count) range(s) and nothing else."
Write-Host 'Players reach the server only through TCPShield; a direct connection to the IP is refused.'
