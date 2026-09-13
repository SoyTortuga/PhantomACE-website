# ══════════════════════════════════════════════
#  Install the PhantomACE web server as a Windows service.
#
#  Run from an ELEVATED PowerShell on the rig.
#
#  Dev service (port 8789, dev database):
#     .\server\scripts\install-services.ps1 `
#        -Database 'phantomace-tv-dev' -PublicOrigin 'https://dev.phantomace.tv' `
#        -Port 8789 -ServiceName 'phantomace-web-dev'
#
#  Production service (added at cutover, see server\CUTOVER-RUNBOOK.md):
#     .\server\scripts\install-services.ps1
#
#  WHY NSSM RATHER THAN PM2
#  pm2 is what the bot service's README documents, but `pm2 startup` does not
#  support Windows — so those instructions do not actually survive a reboot,
#  which was confirmed on this machine (no pm2 service exists). NSSM matches
#  what is already here: cloudflared runs as a Windows service.
#
#  WHY THE POSTGRES DEPENDENCY MATTERS
#  Services start in dependency order but Windows does not wait for a service
#  to be *ready*, only *started*. DependOnService gets the ordering; the
#  connect-retry loop in lib/db.js covers the readiness gap. Both are needed —
#  with neither, the site is down after every reboot until someone notices.
# ══════════════════════════════════════════════

#  CREDENTIALS ARE NOT PASSED ON THE COMMAND LINE. The connection string is
#  read from server\.env, and only the database NAME is swapped when targeting
#  dev vs production. A password typed as a parameter would end up in
#  PowerShell history, in process listings, and in any transcript of the
#  session that ran it.

[CmdletBinding()]
param(
    [string] $Database     = 'phantomace-tv',
    [string] $PublicOrigin = 'https://phantomace.tv',
    [int]    $Port         = 8790,
    [string] $ServiceName  = 'phantomace-web'
)

$ErrorActionPreference = 'Stop'

function Assert-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($id)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run this from an elevated PowerShell (Run as Administrator).'
    }
}

Assert-Admin

$repoRoot  = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$serverDir = Join-Path $repoRoot 'server'
$entry     = Join-Path $serverDir 'index.js'
$logDir    = Join-Path $serverDir 'logs'

if (-not (Test-Path $entry)) { throw "Cannot find $entry" }
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# ── Derive the connection string from server\.env ─────────────────────────
# dotenv does not override variables already present in the environment, so
# whatever we set on the service wins over the file. That is what lets one
# .env serve both the dev and production services.
$envFile = Join-Path $serverDir '.env'
if (-not (Test-Path $envFile)) {
    throw "server\.env not found. Copy server\.env.example and fill it in first."
}
$envLine = Select-String -Path $envFile -Pattern '^\s*DATABASE_URL\s*=' | Select-Object -First 1
if (-not $envLine) { throw 'DATABASE_URL is not set in server\.env' }

$databaseUrl = ($envLine.Line -replace '^\s*DATABASE_URL\s*=\s*', '').Trim().Trim('"').Trim("'")
# Swap only the database name; leave credentials and host untouched.
$databaseUrl = $databaseUrl -replace '/[^/?]+(\?|$)', "/$Database`$1"

# Redacted for display — never print the password back to the console.
$shown = $databaseUrl -replace '://([^:]+):[^@]+@', '://$1:***@'
Write-Host "[setup] database url: $shown"

# ── nssm ──────────────────────────────────────────────────────────────────
if (-not (Get-Command nssm -ErrorAction SilentlyContinue)) {
    Write-Host '[setup] nssm not found; installing via winget...'
    winget install --id NSSM.NSSM -e --source winget --accept-package-agreements --accept-source-agreements
    Write-Host '[setup] If nssm is still not on PATH, open a NEW elevated shell and re-run.'
}
$nssm = (Get-Command nssm -ErrorAction SilentlyContinue).Source
if (-not $nssm) { throw 'nssm is not on PATH. Open a new elevated shell and re-run.' }

$node = (Get-Command node).Source
Write-Host "[setup] node:  $node"
Write-Host "[setup] entry: $entry"

# ── the Postgres service to depend on ─────────────────────────────────────
# Discovered rather than hardcoded: the version suffix changes across
# Postgres upgrades, and a stale name silently drops the dependency.
$pg = Get-Service -Name 'postgresql*' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $pg) { throw 'No postgresql* service found. Is Postgres installed on this machine?' }
Write-Host "[setup] postgres service: $($pg.Name)"

# ── (re)create the service ────────────────────────────────────────────────
if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
    Write-Host "[setup] $ServiceName exists; stopping and removing first"
    & $nssm stop $ServiceName confirm | Out-Null
    & $nssm remove $ServiceName confirm | Out-Null
    Start-Sleep -Seconds 2
}

# WHY THE SCRIPT NAME IS RELATIVE AND NOT $entry
# `nssm install <name> <exe> <params>` stores everything after the exe as one
# verbatim parameters string and does NOT quote it when building the service's
# command line. The repo path on the rig is "...\PhantomACE Website" — it has a
# space — so an absolute path here is split at that space: node receives
# "C:\Users\EZiRLS8\Documents\PhantomACE", exits 1 with MODULE_NOT_FOUND, and
# NSSM turns that into a crash loop that reports only as Status=Paused.
#
# Passing a bare "index.js" removes the space from the command line entirely,
# so there is no quoting to get wrong. It resolves against AppDirectory, which
# is already load-bearing for an unrelated reason — dotenv reads server\.env
# from the working directory — so this relies on nothing new. If AppDirectory
# were ever wrong the server could not read its secrets either.
#
# Note this is specific to the parameters string. Paths in single-value
# settings (AppDirectory, AppStdout, AppStderr) are stored and used verbatim,
# and spaces in those are fine — the crash-looping install still wrote its log
# to "...\PhantomACE Website\server\logs\server.out.log" correctly.
& $nssm install $ServiceName $node 'index.js'
& $nssm set $ServiceName AppDirectory       $serverDir
& $nssm set $ServiceName DisplayName        'PhantomACE Web Server'
& $nssm set $ServiceName Description        'Serves phantomace.tv (static site + /api) backed by Postgres.'
& $nssm set $ServiceName Start              SERVICE_AUTO_START
& $nssm set $ServiceName DependOnService    $pg.Name

# Restart on crash, but throttled so a boot-time failure loop is visible in
# the log rather than spinning invisibly.
& $nssm set $ServiceName AppExit Default Restart
& $nssm set $ServiceName AppRestartDelay    5000
& $nssm set $ServiceName AppThrottle        5000

& $nssm set $ServiceName AppStdout          (Join-Path $logDir 'server.out.log')
& $nssm set $ServiceName AppStderr          (Join-Path $logDir 'server.err.log')
& $nssm set $ServiceName AppRotateFiles     1
& $nssm set $ServiceName AppRotateBytes     10485760

# Environment. NSSM wants a single NUL-free multi-line blob; secrets stay in
# server/.env and are read by dotenv, so nothing sensitive is written into the
# service configuration (which is world-readable in the registry).
$envBlock = @(
    "PORT=$Port",
    "PUBLIC_ORIGIN=$PublicOrigin",
    "DATABASE_URL=$databaseUrl"
) -join "`r`n"
& $nssm set $ServiceName AppEnvironmentExtra $envBlock

# ── read back what NSSM actually stored ───────────────────────────────────
# Every `nssm set` above reported success while the service it produced could
# not start at all: the parameters string had been silently split at a space.
# An installer that says "installed" and hands over a service that crash-loops
# is worse than one that fails, because the failure surfaces later and looks
# like a different problem. So assert on the stored values rather than on the
# exit codes of the commands that wrote them.
#
# `nssm get` emits UTF-16, which arrives here with embedded NULs.
function Get-NssmValue([string] $key) {
    ((& $nssm get $ServiceName $key) -join '') -replace "`0", ''
}

$storedParams = (Get-NssmValue 'AppParameters').Trim()
$storedDir    = (Get-NssmValue 'AppDirectory').Trim()
$storedApp    = (Get-NssmValue 'Application').Trim()

$failures = @()
if ($storedParams -ne 'index.js') {
    $failures += "AppParameters is '$storedParams', expected 'index.js'"
}
if ($storedDir -ne $serverDir) {
    $failures += "AppDirectory is '$storedDir', expected '$serverDir'"
}
if (-not (Test-Path (Join-Path $storedDir 'index.js'))) {
    $failures += "no index.js in '$storedDir'"
}
if (-not (Test-Path $storedApp)) {
    $failures += "Application '$storedApp' does not exist"
}

if ($failures.Count) {
    Write-Host ''
    Write-Host '[setup] REFUSING TO LEAVE A BROKEN SERVICE INSTALLED:' -ForegroundColor Red
    foreach ($f in $failures) { Write-Host "          $f" -ForegroundColor Red }
    Write-Host ''
    Write-Host '[setup] removing it again so nothing auto-starts at next boot.'
    & $nssm remove $ServiceName confirm | Out-Null
    throw 'Service configuration failed verification; the service was removed.'
}
Write-Host "[setup] verified: $storedApp index.js (in $storedDir)"

Write-Host ''
Write-Host "[setup] installed '$ServiceName'"
Write-Host "        port      : $Port"
Write-Host "        origin    : $PublicOrigin"
Write-Host "        database  : $Database"
Write-Host "        depends on: $($pg.Name)"
Write-Host ''
Write-Host '[setup] NOT started automatically. Start it deliberately when ready:'
Write-Host "          Start-Service $ServiceName"
Write-Host "          Get-Content '$logDir\server.out.log' -Tail 20"
Write-Host ''
Write-Host '[setup] If it crash-loops, Status reads "Paused" rather than "Stopped"'
Write-Host '        and NSSM keeps restarting it with escalating backoff. Quiet it'
Write-Host "        with:  Stop-Service $ServiceName"
Write-Host '        The reason is always in server.out.log, not in Get-Service.'
Write-Host ''
Write-Host '[setup] Reboot survival is the point of this script. Verify it by actually'
Write-Host '        rebooting and confirming the site answers without anyone logging in.'
