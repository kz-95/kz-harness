# Updates Kz-harness: pulls new harness code from git, refreshes packages,
# and reports (or with -BumpDsh applies) a newer engine (DSH) version.
# The app's Kz-harness -> Check for updates runs this and restarts the harness.
#   powershell -ExecutionPolicy Bypass -File C:\Harness\scripts\Update-Harness.ps1 [-BumpDsh]
param([switch]$BumpDsh)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$start = Join-Path $root 'Start-KzH.ps1'

Write-Host '== Harness code'
# git reports "no upstream" and similar on stderr; that is data here, not a failure.
$ErrorActionPreference = 'Continue'
$branch = git -C $root rev-parse --abbrev-ref HEAD 2>$null
$upstream = git -C $root rev-parse --abbrev-ref '@{u}' 2>$null
if ($LASTEXITCODE -or -not $upstream) { Write-Host "   branch $branch has no remote to update from; skipped." }
else {
  git -C $root fetch --quiet
  $behind = [int](git -C $root rev-list --count 'HEAD..@{u}')
  if ($behind -eq 0) { Write-Host "   up to date ($branch)." }
  elseif (git -C $root status --porcelain) { Write-Host "   WARN $behind new commit(s) on $upstream, but you have local changes; commit or stash them, then update again." }
  else {
    git -C $root pull --ff-only --quiet
    if ($LASTEXITCODE) { throw 'git pull failed (branches diverged?). Resolve it in a terminal.' }
    Write-Host "   pulled $behind commit(s)."
    if (git -C $root diff --name-only 'HEAD@{1}' HEAD -- app) { Write-Host '   WARN the desktop app changed: close Kz-harness, then run scripts\Install-Harness.ps1 to rebuild Kz-harness.exe.' }
  }
}
$ErrorActionPreference = 'Stop'

Write-Host '== Packages'
foreach ($dir in 'plugins\jev-router', 'plugins\jev-review', 'app') {
  Push-Location (Join-Path $root $dir)
  try { npm install --no-audit --no-fund | Out-Null; if ($LASTEXITCODE) { throw "npm install failed in $dir" } } finally { Pop-Location }
  Write-Host "   ok: $dir"
}

Write-Host '== uv (for the optional Laya decision model)'
# Kept at the version config\laya.json pins, checked by size and SHA-256, every time: a KzH version
# that moves the pin gets the new uv here. Laya itself never updates on its own (Settings does it).
$layaPins = Get-Content (Join-Path $root 'config\laya.json') -Raw | ConvertFrom-Json
$uvDir = Join-Path $root 'engine\uv'
$uvExe = Join-Path $uvDir 'uv.exe'
$uvWant = "^uv $([regex]::Escape($layaPins.uv.version))\b"
$uvHave = ''
if (Test-Path $uvExe) { try { $uvHave = (& $uvExe --version) -join '' } catch { $uvHave = '' } }
if ($uvHave -notmatch $uvWant) {
  New-Item -ItemType Directory -Force $uvDir | Out-Null
  $uvPart = Join-Path $uvDir 'uv.zip.part'
  $uvZip = Join-Path $uvDir 'uv.zip'
  & curl.exe -fL --retry 5 -C - -o $uvPart $layaPins.uv.source
  if ($LASTEXITCODE) { throw 'uv: the download failed (run this again to resume)' }
  if ((Get-Item $uvPart).Length -ne $layaPins.uv.size) { throw 'uv: the download is not the size config\laya.json pins (run this again to resume)' }
  $uvHash = (Get-FileHash $uvPart -Algorithm SHA256).Hash.ToLower()
  if ($uvHash -ne $layaPins.uv.sha256) { Remove-Item $uvPart; throw "uv: SHA256 $uvHash does not match config\laya.json; the file was deleted" }
  Move-Item $uvPart $uvZip -Force
  Expand-Archive $uvZip -DestinationPath $uvDir -Force
  Remove-Item $uvZip
  $uvHave = (& $uvExe --version) -join ''
  if ($uvHave -notmatch $uvWant) { throw "uv reports '$uvHave', not $($layaPins.uv.version)" }
}
Write-Host "   ok: uv $($layaPins.uv.version)"

Write-Host '== Config'
# Install-Harness.ps1 writes the patch file once and skips it ever after, so a
# later template change (a new gate percent, a newly disabled skill) never reaches
# the running harness and nobody is told. Report the drift, do not merge it: the
# live file is the user's to hand-edit and a merge would overwrite those edits
# silently. Telling beats doing here, because only the user knows which is which.
$homeName = ([regex]::Match((Get-Content $start -Raw), "DSH_HOME = Join-Path \`$HOME '([^']+)'")).Groups[1].Value
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } elseif ($homeName) { Join-Path $HOME $homeName } else { Join-Path $HOME '.dsh' }
$live = Join-Path $dshHome 'profiles\web\cordis.patch.yml'
$template = Join-Path $root 'config\cordis.patch.yml'
# Settings lines only: comment and blank-line drift changes nothing at runtime.
# Line-level, not YAML-aware (PowerShell 5.1 ships no YAML parser), so a shared
# line such as `config:` can join the list when the counts differ. It over-reports
# rather than under-reports, which is the safe direction for a warning.
function Get-Settings($path) { (Get-Content $path) | ForEach-Object { ($_ -replace '#.*', '').TrimEnd() } | Where-Object { $_ } }
if (-not (Test-Path $live)) { Write-Host "   WARN no live config at $live; run scripts\Install-Harness.ps1." }
else {
  # The template says C:/Harness; the live copy says wherever this checkout lives.
  $want = Get-Settings $template | ForEach-Object { $_.Replace('C:/Harness', ($root -replace '\\', '/')) }
  $drift = Compare-Object $want (Get-Settings $live)
  $gaps = @($drift | Where-Object SideIndicator -eq '<=' | ForEach-Object InputObject)
  $localOnly = @($drift | Where-Object SideIndicator -eq '=>' | ForEach-Object InputObject)
  # Back in template order, so the warning reads as the YAML you would paste.
  $missing = @($want | Where-Object { $gaps -contains $_ } | Select-Object -Unique)
  if ($missing) {
    Write-Host "   WARN $($missing.Count) setting(s) from config\cordis.patch.yml are missing in $live"
    $missing | ForEach-Object { Write-Host "        $_" }
    Write-Host '   Nothing was merged. Copy the lines you want by hand, so your own edits stay yours.'
  }
  if ($localOnly) { Write-Host "   note: $($localOnly.Count) setting line(s) live only in your copy; left alone." }
  if (-not $missing -and -not $localOnly) { Write-Host '   live config matches the template.' }
}

Write-Host '== Engine'
$pinned = ([regex]::Match((Get-Content $start -Raw), "\`$DshVersion = '([^']+)'")).Groups[1].Value
$tag = if ($pinned -match '-') { 'next' } else { 'latest' }
$latest = (npm view "@deepseek-ai/dsh@$tag" version 2>$null)
if (-not $latest) { $latest = (npm view @deepseek-ai/dsh version) }
if ($latest -eq $pinned) { Write-Host "   $pinned is current." }
elseif (-not $BumpDsh) { Write-Host "   WARN $latest is available (pinned: $pinned). Plugins are tested on $pinned; run with -BumpDsh to switch." }
else {
  (Get-Content $start -Raw).Replace("`$DshVersion = '$pinned'", "`$DshVersion = '$latest'") | Set-Content $start -Encoding utf8 -NoNewline
  npx -y "@deepseek-ai/dsh@$latest" plugin --profile web add -w "@deepseek-ai/dsh-subagent-claude-code@$latest" "@deepseek-ai/dsh-subagent-codex@$latest"
  if ($LASTEXITCODE) { throw "Installing executors $latest failed; Start-KzH.ps1 now pins $latest, revert it with git if needed." }
  Write-Host "   switched $pinned -> $latest. If the harness fails to start, run: git -C $root checkout Start-KzH.ps1"
}
Write-Host 'Update finished.'
