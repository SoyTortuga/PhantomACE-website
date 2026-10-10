<#
  ══════════════════════════════════════════════
   DEPLOY — pull, decide, restart, and prove it landed

     cd C:\path\to\PhantomACE-Website
     .\server\scripts\deploy.ps1

     -NoTests     skip the suite (don't)
     -Force       restart even when nothing under server/ or functions/ moved
     -Timeout 90  seconds to wait for the service to come back (default 60)

   THE THREE THINGS THIS DOES THAT THE TWO-COMMAND VERSION DID NOT.

   IT DECIDES WHETHER A RESTART IS NEEDED. Static files are read from disk
   per request, so a pull that touched only html/css/js is already live.
   Restarting anyway is not free: Mana Clash round timers, the chat scramble
   clock and the announcement ticker all live in that process, so a needless
   restart drops a game that was mid-round.

   IT REFUSES TO RESTART ONTO A RED SUITE. The boot assertions are fatal by
   design — a file under functions/ that is neither route nor declared
   library exits the process — and that is exactly how the site went to
   SERVICE_PAUSED once already. The suite catches it here, before the
   service is touched.

   IT PROVES THE DEPLOY LANDED. /api/health reports the commit read from
   .git AT BOOT, so polling it until the sha matches HEAD distinguishes
   "the service is up" from "the service is up and running what I pulled".
   A process that came back on the OLD code, or came back with Postgres
   unreachable, is reported as a failure with the rollback command rather
   than as a successful deploy.

   It never rolls back on its own. Somebody is at the keyboard — they ran
   this — and an automatic reset is the wrong thing to do to a repo whose
   previous commit might itself have been half of something.
  ══════════════════════════════════════════════
#>

param(
  [switch]$NoTests,
  [switch]$Force,
  [int]$Timeout = 60,
  [string]$Service = 'phantomace-web',
  # 8790 is production; the dev service (phantomace-web-dev) is on 8789.
  # Both are set by server/scripts/install-services.ps1.
  [int]$Port = 8790
)

$HealthUrl = "http://127.0.0.1:$Port/api/health"

$ErrorActionPreference = 'Stop'
Set-Location (git rev-parse --show-toplevel)

function Step($m) { Write-Host "`n== $m" -ForegroundColor Cyan }
function Bad($m)  { Write-Host $m -ForegroundColor Red }
function Good($m) { Write-Host $m -ForegroundColor Green }

# ── Refuse to deploy on top of local edits ──────────────────────────────
# A dirty tree on the rig means somebody hand-patched production. Pulling
# over it either conflicts or silently buries the change; either way it is
# a thing to look at, not to drive past.
$dirty = git status --porcelain
if ($dirty) {
  Bad 'The rig has uncommitted changes:'
  $dirty | ForEach-Object { Write-Host "  $_" }
  Bad 'Deal with those first (git stash, or commit them somewhere).'
  exit 1
}

$before = (git rev-parse HEAD).Trim()
Step "Pulling (at $($before.Substring(0,8)))"
git pull --ff-only
if (-not $?) { Bad 'Pull failed.'; exit 1 }

$after = (git rev-parse HEAD).Trim()
if ($before -eq $after) {
  Good 'Already up to date. Nothing to do.'
  if (-not $Force) { exit 0 }
}

# ── What moved decides whether the service must restart ─────────────────
$changed = @()
if ($before -ne $after) { $changed = git diff --name-only "$before..$after" }
$needsRestart = $Force -or ($changed | Where-Object { $_ -like 'server/*' -or $_ -like 'functions/*' }).Count -gt 0

if ($changed.Count) {
  Write-Host "$($changed.Count) file(s) changed:"
  $changed | Select-Object -First 20 | ForEach-Object { Write-Host "  $_" }
  if ($changed.Count -gt 20) { Write-Host "  ... and $($changed.Count - 20) more" }
}

# Gitignored asset trees do not arrive with a pull — see the dino-park
# assets. Say so rather than letting a missing sprite be a mystery later.
if ($changed | Where-Object { $_ -like 'games/dino-park/*' }) {
  Write-Host 'Note: dino-assets/** is gitignored. New art needs a manual copy.' -ForegroundColor Yellow
}

# ── The suite, before anything is touched ───────────────────────────────
if ($NoTests) {
  Write-Host 'Skipping tests (-NoTests).' -ForegroundColor Yellow
} else {
  Step 'Running the suite'
  node server/scripts/run-all-tests.js
  if (-not $?) {
    Bad ''
    Bad 'Suite is RED. The service has NOT been restarted and is still serving'
    Bad "the old build. To undo the pull:  git reset --hard $before"
    exit 1
  }
}

if (-not $needsRestart) {
  Good ''
  Good 'Static files only — already live, no restart needed.'
  exit 0
}

# ── Restart, then prove it ──────────────────────────────────────────────
Step "Restarting $Service"
nssm restart $Service
if (-not $?) { Bad "nssm restart failed. Check: nssm status $Service"; exit 1 }

Step "Waiting for $HealthUrl to report $($after.Substring(0,8))"
$deadline = (Get-Date).AddSeconds($Timeout)
$health = $null
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 1500
  try {
    $r = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec 5
    $health = $r.Content | ConvertFrom-Json
    # Both halves matter: up, AND running what was just pulled.
    if ($health.ok -and $health.commit -eq $after) { break }
    $health = $null
  } catch { $health = $null }
}

if (-not $health) {
  Bad ''
  Bad "The service did not come back healthy on $after within ${Timeout}s."
  Bad 'The site may be down. Look at, in this order:'
  Bad "  nssm status $Service"
  Bad "  Get-Content server\logs\$Service.out.log -Tail 40   (a boot FATAL names the file)"
  Bad "  git reset --hard $before ; nssm restart $Service    (to go back)"
  exit 1
}

Good ''
Good "Live on $($health.commitShort) - $($health.routes) routes, database $($health.database)."
