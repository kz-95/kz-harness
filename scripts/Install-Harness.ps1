# Installs or repairs Kz Harness on this PC. Safe to run again: every step
# checks first and only does what is missing. Keys are never read or printed.
#   powershell -ExecutionPolicy Bypass -File C:\Harness\scripts\Install-Harness.ps1
param([switch]$NoShortcuts)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$profileDir = Join-Path $dshHome 'profiles\web'
$dshVersion = ([regex]::Match((Get-Content (Join-Path $root 'Start-DSH.ps1') -Raw), "\`$DshVersion = '([^']+)'")).Groups[1].Value
function Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "   ok: $text" -ForegroundColor Green }
function Warn($text) { Write-Host "   !!  $text" -ForegroundColor Yellow }
# UTF-8 without a byte-order mark: PowerShell 5.1's -Encoding utf8 adds one, which YAML readers may trip on.
$utf8 = New-Object System.Text.UTF8Encoding $false

Step 'Tools'
foreach ($cmd in 'node', 'npm', 'git') { if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "$cmd is not installed. Install Node.js 24 (https://nodejs.org) and Git (https://git-scm.com), then run this again." } }
$node = [version]((node --version).TrimStart('v'))
if ($node -lt [version]'22.19.0') { throw "Node $node is too old; DSH needs 22.19 or newer." }
Ok "node $node, git, npm"
foreach ($cli in 'claude', 'codex') { if (Get-Command $cli -ErrorAction SilentlyContinue) { Ok "$cli CLI found" } else { Warn "$cli CLI not found. That agent stays unavailable until installed (see README)." } }

Step 'Packages'
foreach ($dir in 'plugins\jev-router', 'plugins\jev-review', 'app') {
  Push-Location (Join-Path $root $dir)
  try { npm install --no-audit --no-fund | Out-Null; if ($LASTEXITCODE) { throw "npm install failed in $dir" } } finally { Pop-Location }
  Ok $dir
}
$electron = Join-Path $root 'app\node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electron)) { node (Join-Path $root 'app\node_modules\electron\install.js'); if ($LASTEXITCODE) { throw 'Electron download failed' } }
Ok 'electron'

Step "DeepSeek Harness $dshVersion and the Claude / Codex executors"
$pkg = Join-Path $profileDir 'package.json'
$have = (Test-Path $pkg) -and ((Get-Content $pkg -Raw) -match [regex]::Escape("`"@deepseek-ai/dsh-subagent-codex`": `"$dshVersion`""))
if ($have) { Ok 'already installed' }
else {
  npx -y "@deepseek-ai/dsh@$dshVersion" plugin --profile web add -w "@deepseek-ai/dsh-subagent-claude-code@$dshVersion" "@deepseek-ai/dsh-subagent-codex@$dshVersion"
  if ($LASTEXITCODE) { throw 'Installing the executors failed.' }
  Ok 'installed'
}

Step 'Harness configuration'
$patch = Join-Path $profileDir 'cordis.patch.yml'
if ((Test-Path $patch) -and (Select-String -Path $patch -Pattern 'jev-router' -Quiet)) { Ok 'router already configured' }
else {
  if (Test-Path $patch) { Copy-Item $patch "$patch.bak-$(Get-Date -Format yyyyMMdd-HHmmss)" }
  $template = (Get-Content (Join-Path $root 'config\cordis.patch.yml') -Raw).Replace('C:/Harness', ($root -replace '\\', '/'))
  [IO.File]::WriteAllText($patch, $template, $utf8)
  Ok 'router, review, executors and brand rows written'
}
$settings = Join-Path $dshHome 'settings.yaml'
if (-not (Test-Path $settings) -or -not (Select-String -Path $settings -Pattern '^agent-default-model:' -Quiet)) {
  $existing = if (Test-Path $settings) { (Get-Content $settings -Raw).TrimEnd() + "`n" } else { '' }
  [IO.File]::WriteAllText($settings, "$existing" + "agent-default-model:`n  provider: jev`n  model: jev-auto`n", $utf8)
  Ok 'Jev Auto set as the default model'
} else { Ok 'default model already set' }
New-Item -ItemType Directory -Force (Join-Path $dshHome 'jev-router') | Out-Null
$projects = 'C:\HarnessProjects'
if (-not (Test-Path $projects)) { New-Item -ItemType Directory $projects | Out-Null }
Ok "projects folder $projects"

Step 'Keys'
$envFile = Join-Path $dshHome '.env'
foreach ($name in 'TYPESAFE_API_KEY', 'DEEPSEEK_API_KEY') {
  $inFile = (Test-Path $envFile) -and (Select-String -Path $envFile -Pattern "^\s*$name\s*=" -Quiet)
  $inEnv = [Environment]::GetEnvironmentVariable($name, 'User')
  if ($inFile -or $inEnv) { Ok "$name present" } else { Warn "$name missing: add it to $envFile (see README step 2)." }
}

if (-not $NoShortcuts) {
  Step 'Shortcuts'
  $ws = New-Object -ComObject WScript.Shell
  foreach ($dir in [Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs')) {
    $old = Join-Path $dir 'Jev Harness.lnk'
    if (Test-Path $old) { Remove-Item $old } # the app's earlier name
    $lnk = $ws.CreateShortcut((Join-Path $dir 'Kz Harness.lnk'))
    $lnk.TargetPath = $electron
    $lnk.Arguments = "`"$(Join-Path $root 'app')`""
    $lnk.WorkingDirectory = Join-Path $root 'app'
    $lnk.IconLocation = "$(Join-Path $root 'app\assets\logo.ico'),0"
    $lnk.Description = 'Kz Harness: Claude, Codex and DeepSeek routed and reviewed by Jev'
    $lnk.Save()
    Ok (Join-Path $dir 'Kz Harness.lnk')
  }
}

Write-Host "`nDone. Start it with the Kz Harness icon, then check Settings -> Jev setup." -ForegroundColor Green
