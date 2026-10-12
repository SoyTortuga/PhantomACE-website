# ══════════════════════════════════════════════
#  Register the Minecraft whitelist sync as a Windows scheduled task.
#
#  Run ONCE from an ELEVATED PowerShell, in the website folder:
#     powershell -NoProfile -ExecutionPolicy Bypass -File .\server\scripts\install-minecraft-whitelist-task.ps1
#
#  Every 15 minutes it runs sync-minecraft-whitelist.ps1, which is what takes
#  lapsed subscribers off the server. Joining does not wait for it — the site
#  pushes new names through Crafty immediately.
#
#  A scheduled task rather than a timer inside the web server, for the same
#  reason as the nightly backup: it should keep happening when the site is
#  restarting, and it writes into another program's folder, which the web
#  server has no business doing on every request.
# ══════════════════════════════════════════════

[CmdletBinding()]
param(
    [string] $TaskName = 'PhantomACE Minecraft Whitelist Sync',
    [int]    $EveryMinutes = 15
)

$ErrorActionPreference = 'Stop'

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this from an elevated PowerShell (Run as Administrator).'
}

$script = Join-Path $PSScriptRoot 'sync-minecraft-whitelist.ps1'
if (-not (Test-Path $script)) { throw "Cannot find $script" }

# -ExecutionPolicy Bypass because this machine blocks .ps1 execution by
# policy; scoped to this one invocation rather than changed system-wide.
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument ('-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $script)

# Starting a minute from now, repeating. The duration is spelled out because
# leaving it off has meant "one day" on some Windows builds — a sync that
# quietly stops tomorrow is worse than none.
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes) `
    -RepetitionDuration (New-TimeSpan -Days 3650)

# SYSTEM, like the backup: runs whether or not anyone is logged in, and can
# read server\.env and write into the Crafty server folder.
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

# IgnoreNew: if one run is somehow slow, the next does not pile up on it.
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd `
    -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Write-Host "[task] '$TaskName' exists; replacing it"
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Description `
    'Writes the subscriber whitelist from phantomace.tv into the Minecraft server and reloads it. See server/scripts/sync-minecraft-whitelist.ps1.' | Out-Null

Write-Host ""
Write-Host "[task] registered '$TaskName', every $EveryMinutes minutes"
Write-Host ""
Write-Host "[task] RUN IT ONCE NOW to prove it works:"
Write-Host "         Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "         Get-ScheduledTaskInfo -TaskName '$TaskName'   # LastTaskResult 0 = success"
Write-Host "         Get-Content .\server\logs\whitelist-sync.log -Tail 5"
Write-Host ""
