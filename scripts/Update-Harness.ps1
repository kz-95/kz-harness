# Updates Kz-harness: pulls new harness code from git, refreshes packages,
# and reports (or with -BumpDsh applies) a newer DeepSeek Harness version.
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

Write-Host '== DeepSeek Harness'
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
