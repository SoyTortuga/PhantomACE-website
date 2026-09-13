# ══════════════════════════════════════════════
#  Register the daily backup as a Windows scheduled task.
#
#  Run ONCE from an ELEVATED PowerShell:
#     powershell -NoProfile -ExecutionPolicy Bypass -File .\server\scripts\install-backup-task.ps1
#
#  Scheduled Task rather than a timer inside the web server, deliberately: a
#  backup must not stop happening because the site crashed. Those are exactly
#  the days you want yesterday's copy.
# ══════════════════════════════════════════════

[CmdletBinding()]
param(
    [string] $TaskName = 'PhantomACE Daily Backup',
    [string] $At       = '04:30'
)

$ErrorActionPreference = 'Stop'

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this from an elevated PowerShell (Run as Administrator).'
}

$script = Join-Path $PSScriptRoot 'backup-db.ps1'
if (-not (Test-Path $script)) { throw "Cannot find $script" }

# -ExecutionPolicy Bypass because this machine blocks .ps1 execution by
# policy; scoped to this one invocation rather than changed system-wide.
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument ('-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $script)

$trigger = New-ScheduledTaskTrigger -Daily -At $At

# RunLevel Highest so it can read server\.env and write outside the profile.
# SYSTEM rather than a user account: the task must run whether or not anyone
# is logged in, which is the same reason the web server is a service.
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

# StartWhenAvailable so a backup missed because the machine was off still runs
# once it comes back, rather than silently skipping that day.
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
    -DontStopOnIdleEnd -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Write-Host "[task] '$TaskName' exists; replacing it"
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Description `
    'Nightly pg_dump of phantomace-tv, excluding oauth_tokens. See server/scripts/backup-db.ps1.' | Out-Null

Write-Host ""
Write-Host "[task] registered '$TaskName', daily at $At"
Write-Host ""
Write-Host "[task] RUN IT ONCE NOW to prove it works — a scheduled task that has"
Write-Host "       never succeeded is not a backup, it is an assumption:"
Write-Host "         Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "         Get-ScheduledTaskInfo -TaskName '$TaskName'   # LastTaskResult 0 = success"
Write-Host "         Get-ChildItem C:\PhantomACE-Backups"
Write-Host ""
Write-Host "[task] And check again in a week. The failure mode for backups is"
Write-Host "       silence, not errors."
