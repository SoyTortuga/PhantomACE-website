<#
  ══════════════════════════════════════════════
   MINECRAFT WHITELIST SYNC — the site's list onto the game server

   Run by the scheduled task from install-minecraft-whitelist-task.ps1,
   every 15 minutes. By hand, for a one-off:

     powershell -NoProfile -ExecutionPolicy Bypass -File .\server\scripts\sync-minecraft-whitelist.ps1

   WHAT IT IS FOR. Joining is already instant: /minecraft pushes
   `whitelist add` through Crafty the moment somebody submits a name. What
   nothing does on its own is take a LAPSED subscriber off — their place
   simply stops being renewed on the site, and something has to notice and
   act. That is this: fetch the site's list, write it as whitelist.json,
   tell the server to reload it. enforce-whitelist then removes anyone no
   longer on it.

   SECRETS COME FROM server\.env, NOT FROM HERE. Same as backup-db.ps1: the
   task carries no token in its arguments, so nothing sensitive is visible
   in Task Scheduler or in PowerShell history.

   IT FETCHES FROM 127.0.0.1, NOT phantomace.tv. Same machine, so the token
   travels over loopback and never touches Cloudflare, and a sync still
   works while the tunnel is down.

   IT REFUSES BEFORE IT WRITES. Every way this can go wrong ends with the
   previous whitelist.json left in place: a site that is down, a bad token,
   a response that is not a list of real players, and — the one that would
   lock everybody out — an EMPTY list replacing a non-empty one. That last
   case is almost certainly a fault rather than every subscriber lapsing in
   the same fifteen minutes, so it needs -AllowEmpty to go through.

   NO BYTE-ORDER MARK. Windows PowerShell's UTF8 writes one, and the
   server's JSON reader can reject a whitelist.json that starts with it —
   which would lock everybody out. The file is written with .NET directly.
  ══════════════════════════════════════════════
#>

[CmdletBinding()]
param(
  # Production; the dev service is 8789. Set by install-services.ps1.
  [int]$Port = 8790,
  [switch]$AllowEmpty,
  # Where whitelist.json lives. Defaults to MINECRAFT_SERVER_DIR in .env,
  # then to Crafty's folder for CRAFTY_SERVER_ID.
  [string]$ServerDir,
  # Defaults to server\.env. Overridable so the suite can run this against
  # a throwaway config instead of production's.
  [string]$EnvFile,
  [string]$LogFile
)

$ErrorActionPreference = 'Stop'

$serverRoot = Split-Path -Parent $PSScriptRoot          # ...\server
if (-not $EnvFile) { $EnvFile = Join-Path $serverRoot '.env' }
if ($LogFile) { $logFile = $LogFile } else { $logFile = Join-Path (Join-Path $serverRoot 'logs') 'whitelist-sync.log' }
$logDir     = Split-Path -Parent $logFile

function Log($m) {
  $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m
  Write-Host $line
  try {
    if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force $logDir | Out-Null }
    Add-Content -Path $logFile -Value $line -Encoding UTF8
  } catch { }
}

function Fail($m) {
  Log "FAILED: $m - whitelist.json left as it was"
  exit 1
}

function EnvValue($name) {
  if (-not (Test-Path $EnvFile)) { Fail "server\.env not found at $EnvFile" }
  $esc = [regex]::Escape($name)
  $hit = Select-String -Path $EnvFile -Pattern ('^\s*' + $esc + '\s*=') | Select-Object -First 1
  if (-not $hit) { return $null }
  return ($hit.Line -replace ('^\s*' + $esc + '\s*=\s*'), '').Trim().Trim('"').Trim("'")
}

# Minecraft's rules, and the same shape the site stores.
$NameRe = '^[A-Za-z0-9_]{3,16}$'
$UuidRe = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

# ── Configuration ────────────────────────────────────────────────────────
$token = EnvValue 'MINECRAFT_WHITELIST_TOKEN'
if (-not $token) { Fail 'MINECRAFT_WHITELIST_TOKEN is not set in server\.env' }

$craftyUrl    = EnvValue 'CRAFTY_URL'
$craftyToken  = EnvValue 'CRAFTY_TOKEN'
$craftyServer = EnvValue 'CRAFTY_SERVER_ID'

if (-not $ServerDir) { $ServerDir = EnvValue 'MINECRAFT_SERVER_DIR' }
if (-not $ServerDir -and $craftyServer) { $ServerDir = Join-Path 'C:\Crafty\servers' $craftyServer }
if (-not $ServerDir) { Fail 'No server folder: set MINECRAFT_SERVER_DIR or CRAFTY_SERVER_ID in server\.env' }
if (-not (Test-Path (Join-Path $ServerDir 'server.properties'))) {
  Fail "$ServerDir does not look like a Minecraft server (no server.properties)"
}
$target = Join-Path $ServerDir 'whitelist.json'

# ── Fetch the site's list ───────────────────────────────────────────────
$url = "http://127.0.0.1:$Port/api/minecraft/whitelist"
try {
  # Header rather than ?token= so the secret never appears in a URL.
  $resp = Invoke-WebRequest -Uri $url -Headers @{ 'X-Whitelist-Token' = $token } -UseBasicParsing -TimeoutSec 20
} catch {
  Fail "could not fetch the list from the site ($($_.Exception.Message))"
}
$text = $resp.Content

try { $parsed = $text | ConvertFrom-Json } catch { Fail 'the site did not return JSON' }
# @() of an existing array returns that array; of $null, an empty one.
$list = @($parsed)
if ($text.Trim() -notmatch '^\[') { Fail 'the site returned something other than a list' }

foreach ($p in $list) {
  if (-not ($p.name -match $NameRe) -or -not ($p.uuid -match $UuidRe)) {
    Fail "the site returned an entry that is not a real player: $($p | ConvertTo-Json -Compress)"
  }
}

# ── Compare with what is on disk ────────────────────────────────────────
$current = @()
if (Test-Path $target) {
  # Assign FIRST, then wrap. Windows PowerShell 5.1's ConvertFrom-Json emits
  # a JSON array as ONE pipeline object, so @( ... | ConvertFrom-Json) is a
  # list containing the list - the removals came out empty and every run
  # looked like a change. Same trick as $list above.
  try { $onDisk = Get-Content $target -Raw | ConvertFrom-Json; $current = @($onDisk) } catch { $current = @() }
}
$currentIds = @($current | Where-Object { $_.uuid } | ForEach-Object { $_.uuid.ToLower() })
$newIds     = @($list | ForEach-Object { $_.uuid.ToLower() })

if ($list.Count -eq 0 -and $currentIds.Count -gt 0 -and -not $AllowEmpty) {
  Fail ("the site returned an EMPTY list while {0} player(s) are whitelisted. Probably a fault, not everyone lapsing at once. Re-run with -AllowEmpty if it is real" -f $currentIds.Count)
}

$added   = @($list    | Where-Object { $currentIds -notcontains $_.uuid.ToLower() } | ForEach-Object { $_.name })
$removed = @($current | Where-Object { $_.uuid -and ($newIds -notcontains $_.uuid.ToLower()) } | ForEach-Object { $_.name })

if ($added.Count -eq 0 -and $removed.Count -eq 0) {
  Log ("no change ({0} whitelisted)" -f $list.Count)
  exit 0
}

# ── Write it, without a BOM, by replacing rather than rewriting ─────────
# The temp file is made IN THE SERVER FOLDER so it inherits that folder's
# permissions — the Crafty service account must still be able to read it.
$tmp = "$target.new"
try {
  [IO.File]::WriteAllText($tmp, $text, (New-Object Text.UTF8Encoding($false)))
  Move-Item -Path $tmp -Destination $target -Force
} catch {
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  Fail "could not write $target ($($_.Exception.Message))"
}

$summary = "now {0} whitelisted" -f $list.Count
if ($added.Count)   { $summary += "; added: "   + ($added -join ', ') }
if ($removed.Count) { $summary += "; removed: " + ($removed -join ', ') }
Log "updated whitelist.json - $summary"

# ── Tell the running server ─────────────────────────────────────────────
if (-not ($craftyUrl -and $craftyToken -and $craftyServer)) {
  Log 'Crafty is not configured - the server reads the new list on its next start'
  exit 0
}

$stdin = ($craftyUrl.TrimEnd('/')) + "/api/v2/servers/$craftyServer/stdin"
# curl.exe rather than Invoke-RestMethod: Windows PowerShell 5.1 cannot skip
# certificate checks per request, and Crafty's certificate is self-signed.
# -k is scoped to this one call.
$code = & curl.exe -s -k -o NUL -w '%{http_code}' -X POST `
  -H "Authorization: Bearer $craftyToken" -H 'Content-Type: text/plain' `
  --data-raw 'whitelist reload' $stdin

if ($code -eq '200') {
  Log 'server reloaded the whitelist'
} else {
  # Not a failure of the sync: the file is right, and a stopped server
  # reads it when it next starts. Worth a line, not an error.
  Log "file updated, but Crafty answered HTTP $code to the reload - if the server is running, type 'whitelist reload' in its Terminal"
}
exit 0
