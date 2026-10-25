# ══════════════════════════════════════════════
#  Register the Clipper bot as a Windows scheduled task.
#
#  Run ONCE from an ELEVATED PowerShell:
#     powershell -NoProfile -ExecutionPolicy Bypass -File .\server\scripts\install-clipper-task.ps1
#
#  Optional:
#     -At 09:17          time of day to run (default 09:17)
#     -TaskName "..."    task name
#     -Service "..."     the service whose environment supplies the PRODUCTION
#                        DATABASE_URL (default phantomace-web). server\.env
#                        holds the DEV connection string, so the run must take
#                        the production one from the service block — the same
#                        rule every other maintenance script here follows.
#     -DryRun            install a task that only lists what it WOULD post.
#                        Good for the first day; re-run without it to go live.
#
#  A scheduled task rather than a timer inside the web server, deliberately:
#  rendering video is heavy and must not share a process with the site, and a
#  crashed site should not stop (or be stopped by) clip posting.
#
#  Not :00 or :30 by default — those minutes are the busiest on any shared
#  scheduler, and nothing here is time-critical.
# ══════════════════════════════════════════════

[CmdletBinding()]
param(
    [string] $TaskName = 'PhantomACE Clipper',
    [string] $At       = '09:17',
    [string] $Service  = 'phantomace-web',
    [switch] $DryRun
)

$ErrorActionPreference = 'Stop'

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this from an elevated PowerShell (Run as Administrator).'
}

$repo   = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$runner = Join-Path $repo 'server\clipper\run.js'
if (-not (Test-Path $runner)) { throw "Cannot find $runner" }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node is not on PATH for this account. Install Node 20+ or hardcode the path below.' }

$logDir = Join-Path $repo 'server\clipper\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'clipper.log'

$flags = "--service $Service"
if ($DryRun) { $flags = "$flags --dry-run" }

# Scheduled Tasks capture no stdout of their own, so the run goes through
# PowerShell purely to append a transcript. Without this a failed 9am run
# leaves nothing at all to read.
$inner = '& "{0}" "{1}" {2} *>&1 | Tee-Object -FilePath "{3}" -Append' -f $node, $runner, $flags, $log
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument ('-NoProfile -ExecutionPolicy Bypass -Command "{0}"' -f $inner) `
    -WorkingDirectory $repo

$trigger = New-ScheduledTaskTrigger -Daily -At $At

# SYSTEM, RunLevel Highest: it must run whether or not anyone is logged in,
# and it reads the service environment block out of the registry.
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

# StartWhenAvailable so a run missed because the rig was off still happens.
# Two hours is generous: a handful of clips to download, render and upload.
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
    -DontStopOnIdleEnd -ExecutionTimeLimit (New-TimeSpan -Hours 2)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Force | Out-Null

Write-Host ""
Write-Host "Registered '$TaskName' — daily at $At" -ForegroundColor Green
if ($DryRun) { Write-Host "  DRY RUN mode: it will list, not post. Re-run without -DryRun to go live." -ForegroundColor Yellow }
Write-Host "  node   : $node"
Write-Host "  script : $runner $flags"
Write-Host "  log    : $log"
Write-Host ""
Write-Host "Run it once now with:  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "Check readiness first: node server\clipper\scripts\doctor.js --service $Service"
Write-Host ""
