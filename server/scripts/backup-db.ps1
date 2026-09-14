# ══════════════════════════════════════════════
#  Daily database backup.
#
#  Run manually:
#     powershell -NoProfile -ExecutionPolicy Bypass -File .\server\scripts\backup-db.ps1
#
#  Install as a scheduled task (elevated, once):
#     .\server\scripts\install-backup-task.ps1
#
#  WHY THIS EXISTS
#  There is exactly one row per player in dino_parks and no history. When a
#  subscriber reported missing dinosaurs on 2026-09-13, answering "is anything
#  actually gone?" took an investigation across several live queries and some
#  guesswork, because there was nothing to compare against. Nothing had been
#  lost that time. There was no reason to believe that in advance, and no way
#  to find out cheaply.
#
#  CREDENTIALS ARE NOT PASSED ON THE COMMAND LINE. The connection string comes
#  from server\.env. A password as an argument ends up in PowerShell history,
#  in process listings, and in any transcript of the session that ran it.
# ══════════════════════════════════════════════

[CmdletBinding()]
param(
    [string] $Database  = 'phantomace-tv',
    [string] $BackupDir = 'C:\PhantomACE-Backups',
    [int]    $KeepDays  = 30
)

$ErrorActionPreference = 'Stop'

function Log([string] $msg) {
    Write-Host ("[backup] {0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg)
}

$serverDir = Split-Path -Parent $PSScriptRoot
$envFile   = Join-Path $serverDir '.env'

if (-not (Test-Path $envFile)) { throw "server\.env not found at $envFile" }

$envLine = Select-String -Path $envFile -Pattern '^\s*DATABASE_URL\s*=' | Select-Object -First 1
if (-not $envLine) { throw 'DATABASE_URL is not set in server\.env' }

$databaseUrl = ($envLine.Line -replace '^\s*DATABASE_URL\s*=\s*', '').Trim().Trim('"').Trim("'")
# Swap only the database name; credentials and host are left untouched.
$databaseUrl = $databaseUrl -replace '/[^/?]+(\?|$)', "/$Database`$1"

# ── find pg_dump ──────────────────────────────────────────────────────────
# Discovered rather than hardcoded: the version is in the path, so a Postgres
# upgrade would silently break a pinned one — and a backup that stops running
# is usually noticed only when it is needed.
$pgDump = (Get-Command pg_dump -ErrorAction SilentlyContinue).Source
if (-not $pgDump) {
    $candidate = Get-ChildItem 'C:\Program Files\PostgreSQL\*\bin\pg_dump.exe' -ErrorAction SilentlyContinue |
                 Sort-Object FullName -Descending | Select-Object -First 1
    if ($candidate) { $pgDump = $candidate.FullName }
}
if (-not $pgDump) { throw 'pg_dump not found. Is Postgres installed on this machine?' }
Log "using $pgDump"

New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
$stamp  = Get-Date -Format 'yyyy-MM-dd_HHmm'
$target = Join-Path $BackupDir "$Database`_$stamp.dump"

# ── dump ──────────────────────────────────────────────────────────────────
# Custom format (-Fc) so a SINGLE TABLE can be restored without touching the
# rest — which is the case this exists for: "what did one player have
# yesterday", not "the server burned down".
#
# oauth_tokens is excluded deliberately. It holds live Twitch access and
# refresh tokens; a backup file is copied, emailed and left on desktops, and
# those credentials should not travel with it. Losing them costs one
# re-authorisation, which is cheap next to leaking them.
Log "dumping $Database -> $target"
& $pgDump --dbname=$databaseUrl --format=custom --no-owner --no-privileges `
          --exclude-table=oauth_tokens --file=$target

if ($LASTEXITCODE -ne 0) { throw "pg_dump exited $LASTEXITCODE" }

# ── verify ────────────────────────────────────────────────────────────────
# A backup that silently produces an empty file is worse than no backup: it
# looks like protection right up to the moment it is needed. Check the file
# exists, is a plausible size, and that the expected tables are inside it.
if (-not (Test-Path $target)) { throw 'pg_dump reported success but produced no file' }

$size = (Get-Item $target).Length
Log ("wrote {0:N0} bytes" -f $size)
if ($size -lt 2048) { throw "backup is only $size bytes — treating as failed" }

$pgRestore = $pgDump -replace 'pg_dump\.exe$', 'pg_restore.exe'
if (Test-Path $pgRestore) {
    $tables = (& $pgRestore --list $target 2>$null | Select-String -Pattern 'TABLE DATA public (\w+)' -AllMatches |
               ForEach-Object { $_.Matches.Groups[1].Value })
    # The tables whose loss could not be reconstructed from anywhere else.
    # giveaway_entries and checkins are on the list because they hold a month
    # of earned entries and every check-in streak: unlike a leaderboard, there
    # is no second copy and no way to recompute them from Twitch.
    $required = @('dino_parks', 'inventories', 'phamily_months', 'phamily_alltime',
                  'giveaway_entries', 'checkins')
    $missing  = $required | Where-Object { $tables -notcontains $_ }
    if ($missing) { throw "backup is missing expected table(s): $($missing -join ', ')" }
    Log ("verified {0} table(s) present, including {1}" -f $tables.Count, ($required -join ', '))

    if ($tables -contains 'oauth_tokens') { throw 'oauth_tokens is IN the backup — it must be excluded' }
} else {
    Log 'WARNING pg_restore not found; wrote the dump but could not verify its contents'
}

# ── prune ─────────────────────────────────────────────────────────────────
# Pruning happens only AFTER a verified success, so a run of failures can
# never delete the last good backup.
$cutoff = (Get-Date).AddDays(-$KeepDays)
$old = Get-ChildItem $BackupDir -Filter "$Database`_*.dump" | Where-Object { $_.LastWriteTime -lt $cutoff }
foreach ($f in $old) { Remove-Item $f.FullName -Force; Log "pruned $($f.Name)" }

$kept = (Get-ChildItem $BackupDir -Filter "$Database`_*.dump").Count
Log "done — $kept backup(s) retained in $BackupDir"

# ══════════════════════════════════════════════
#  RESTORING — read this before you need it
#
#  One table into a scratch database, to inspect without touching production:
#     createdb -U postgres scratch
#     pg_restore --dbname=scratch --table=dino_parks <file>.dump
#     psql -d scratch -c "select key, value->'state'->'park' from dino_parks where key='dino_park_53418405';"
#
#  One table back into production, replacing what is there:
#     pg_restore --dbname="<connection string>" --clean --table=dino_parks <file>.dump
#     ^ think first. This replaces EVERY player's row from that table, not one
#       player's. To restore a single player, go through a scratch database and
#       copy the one row across.
#
#  Everything:
#     pg_restore --dbname="<connection string>" --clean <file>.dump
#     Then re-run the broadcaster's bot-setup, because oauth_tokens is not in
#     the backup by design.
# ══════════════════════════════════════════════
