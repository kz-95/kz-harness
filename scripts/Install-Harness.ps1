# Installs or repairs Kz-harness on this PC. Safe to run again: every step
# checks first and only does what is missing. Keys are never read or printed.
#   powershell -ExecutionPolicy Bypass -File C:\Harness\scripts\Install-Harness.ps1
# Local models are opt-in (nothing is downloaded by default):
#   ... Install-Harness.ps1 -LocalModels qwen3-8b,gemma4-e4b    (or: all)
param([switch]$NoShortcuts, [string[]]$LocalModels)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
# The data folder is whatever Start-KzH.ps1 sets, read from that file so there is
# one source of truth; the engine's own default (~/.dsh) applies only if it is gone.
$startPs1 = Get-Content (Join-Path $root 'Start-KzH.ps1') -Raw
$homeName = ([regex]::Match($startPs1, "DSH_HOME = Join-Path \`$HOME '([^']+)'")).Groups[1].Value
if (-not $homeName) { $homeName = '.dsh'; Write-Host "   !!  Start-KzH.ps1 sets no DSH_HOME; falling back to ~/.dsh" -ForegroundColor Yellow }
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME $homeName }
$profileDir = Join-Path $dshHome 'profiles\web'
$dshVersion = ([regex]::Match((Get-Content (Join-Path $root 'Start-KzH.ps1') -Raw), "\`$DshVersion = '([^']+)'")).Groups[1].Value
function Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "   ok: $text" -ForegroundColor Green }
function Warn($text) { Write-Host "   !!  $text" -ForegroundColor Yellow }
# UTF-8 without a byte-order mark: PowerShell 5.1's -Encoding utf8 adds one, which YAML readers may trip on.
$utf8 = New-Object System.Text.UTF8Encoding $false

Step 'Tools'
foreach ($cmd in 'node', 'npm', 'git') { if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "$cmd is not installed. Install Node.js 24 (https://nodejs.org) and Git (https://git-scm.com), then run this again." } }
$node = [version]((node --version).TrimStart('v'))
if ($node -lt [version]'22.19.0') { throw "Node $node is too old; the engine needs 22.19 or newer." }
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
# The app as its own Kz-harness.exe (name, icon, version info, locked-down fuses).
$appExe = Join-Path $root 'app\dist\Kz-harness-win32-x64\Kz-harness.exe'
if (Get-Process Kz-harness -ErrorAction SilentlyContinue) { Warn 'Kz-harness is running; close it and run this again to rebuild Kz-harness.exe.' }
else {
  Push-Location (Join-Path $root 'app')
  try { npm run package | Out-Null; if ($LASTEXITCODE) { throw 'Building Kz-harness.exe failed' } } finally { Pop-Location }
  Ok 'Kz-harness.exe built'
}

Step "Engine $dshVersion and the Claude / Codex executors"
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
    foreach ($oldName in 'Jev Harness.lnk', 'Kz Harness.lnk') { # the app's earlier names
      $old = Join-Path $dir $oldName
      if (Test-Path $old) { Remove-Item $old }
    }
    $lnk = $ws.CreateShortcut((Join-Path $dir 'Kz-harness.lnk'))
    if (Test-Path $appExe) { $lnk.TargetPath = $appExe; $lnk.Arguments = ''; $lnk.WorkingDirectory = Split-Path $appExe }
    else { $lnk.TargetPath = $electron; $lnk.Arguments = "`"$(Join-Path $root 'app')`""; $lnk.WorkingDirectory = Join-Path $root 'app' }
    $lnk.IconLocation = "$(Join-Path $root 'app\assets\logo.ico'),0"
    $lnk.Description = 'Kz-harness: Claude, Codex and DeepSeek routed and reviewed by Jev'
    $lnk.Save()
    Ok (Join-Path $dir 'Kz-harness.lnk')
  }
}

Step 'Local models (optional)'
# Modules come from config/local-models.json only: official source, exact size and SHA256, nothing else.
$manifest = (Get-Content (Join-Path $root 'config\local-models.json') -Raw | ConvertFrom-Json).modules
$engineDir = Join-Path $root 'engine\llama'
$modelsDir = Join-Path $root 'models'
function Read-Marker($path) { if (Test-Path $path) { try { return Get-Content $path -Raw | ConvertFrom-Json } catch { } }; return $null }
function Write-Marker($path, $obj) { New-Item -ItemType Directory -Force (Split-Path $path) | Out-Null; [IO.File]::WriteAllText($path, ($obj | ConvertTo-Json -Compress), $utf8) }
function Test-Module($m) {
  if ($m.kind -eq 'engine') { return (Test-Path (Join-Path $engineDir 'llama-server.exe')) -and ((Read-Marker (Join-Path $engineDir ".installed\$($m.id).json")).sha256 -eq $m.sha256) }
  $file = Join-Path $modelsDir $m.file
  if (-not (Test-Path $file)) { return $false }
  $mark = Read-Marker (Join-Path $modelsDir ".verified\$($m.file).json")
  $item = Get-Item $file
  $ms = [DateTimeOffset]::new($item.LastWriteTimeUtc).ToUnixTimeMilliseconds()
  return $mark -and $mark.size -eq $item.Length -and [math]::Floor($mark.mtimeMs) -eq $ms -and $mark.sha256 -eq $m.sha256
}
function Get-Verified($m, $dest) {
  $part = "$dest.part"
  & curl.exe -fL --retry 5 -C - -o $part $m.source
  if ($LASTEXITCODE) { throw "download of $($m.file) failed (run again to resume)" }
  if ((Get-Item $part).Length -ne $m.size) { throw "$($m.file): size differs from the manifest (run again to resume)" }
  $hash = (Get-FileHash $part -Algorithm SHA256).Hash.ToLower()
  if ($hash -ne $m.sha256) { Remove-Item $part; throw "$($m.file): SHA256 $hash does not match the manifest; the file was deleted" }
  Move-Item $part $dest -Force
}
function Install-Module($m) {
  Write-Host "   installing $($m.name) ($([math]::Round($m.size / 1GB, 2)) GB) from $($m.source)"
  if ($m.kind -eq 'engine') {
    New-Item -ItemType Directory -Force $engineDir | Out-Null
    $zip = Join-Path $engineDir $m.file
    Get-Verified $m $zip
    Expand-Archive $zip -DestinationPath $engineDir -Force
    Remove-Item $zip
    Write-Marker (Join-Path $engineDir ".installed\$($m.id).json") @{ sha256 = $m.sha256 }
  } else {
    New-Item -ItemType Directory -Force $modelsDir | Out-Null
    $dest = Join-Path $modelsDir $m.file
    Get-Verified $m $dest
    $item = Get-Item $dest
    Write-Marker (Join-Path $modelsDir ".verified\$($m.file).json") @{ size = $item.Length; mtimeMs = [DateTimeOffset]::new($item.LastWriteTimeUtc).ToUnixTimeMilliseconds(); sha256 = $m.sha256 }
  }
  Ok "$($m.id): SHA256 verified"
}
# Engine build for this PC, as the plugin picks it: CUDA when the NVIDIA driver supports it, else Vulkan, else CPU.
$cuda = 0
if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) { $cuda = [double]([regex]::Match((nvidia-smi | Out-String), 'CUDA Version:\s*([\d.]+)').Groups[1].Value + '0') }
$variant = ($manifest | Where-Object { $_.kind -eq 'engine' -and $_.minCuda -and $cuda -ge $_.minCuda } | Sort-Object minCuda -Descending | Select-Object -First 1).variant
if (-not $variant) { $variant = if (Get-CimInstance Win32_VideoController | Where-Object { $_.Name -match 'NVIDIA|GeForce|AMD|Radeon|Intel' }) { 'vulkan' } else { 'cpu' } }
$engineMods = @($manifest | Where-Object { $_.kind -eq 'engine' -and $_.variant -eq $variant })
$models = @($manifest | Where-Object { $_.kind -ne 'engine' })
foreach ($m in $models) { Write-Host ("   {0,-20} {1,-28} {2,5:N1} GB  {3}" -f $m.id, $m.name, ($m.size / 1GB), $(if (Test-Module $m) { 'installed' } else { '-' })) }
if (-not $LocalModels) {
  Write-Host "   Nothing downloaded. Install with -LocalModels <id,id|all>, or type /install-llm in Kz-harness (it suggests what fits this PC)."
} else {
  $ids = @($LocalModels | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim().ToLower() } | Where-Object { $_ })
  $want = if ($ids -contains 'all') { $models } else { @($ids | ForEach-Object { $id = $_; $m = $models | Where-Object { $_.id -eq $id }; if (-not $m) { throw "unknown local model '$id'; valid: $(($models.id) -join ', '), all" }; $m }) }
  $todo = @()
  if (-not (@($manifest | Where-Object kind -eq 'engine' | Group-Object variant | Where-Object { @($_.Group | Where-Object { -not (Test-Module $_) }).Count -eq 0 }).Count)) { $todo += $engineMods }
  foreach ($m in $want) {
    if ($m.kind -eq 'vision') { $base = $models | Where-Object { $_.id -eq $m.for }; if (-not (Test-Module $base) -and $todo -notcontains $base) { $todo += $base } }
    if (-not (Test-Module $m) -and $todo -notcontains $m) { $todo += $m }
  }
  $need = ($todo | Measure-Object size -Sum).Sum * 1.1
  $free = (Get-PSDrive ($root.Substring(0, 1))).Free
  if ($need -gt $free) { throw "not enough disk space: needs $([math]::Round($need / 1GB, 1)) GB, $([math]::Round($free / 1GB, 1)) GB free" }
  if (-not $todo.Count) { Ok 'already installed' }
  foreach ($m in $todo) { Install-Module $m }
}

Write-Host "`nDone. Start it with the Kz-harness icon, then check Settings -> Jev setup." -ForegroundColor Green
