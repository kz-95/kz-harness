# Starts the one shared KzH Web UI (http://127.0.0.1:3080).
# Pick or switch the workspace in the UI; nothing here is tied to a project.
# The DSH version is pinned so the installed plugins stay compatible; bump it
# together with the executor plugins (see C:\Harness\README.md).
param(
  [string]$Workspace = 'C:\HarnessProjects',
  [switch]$NoOpen
)
$ErrorActionPreference = 'Stop'
$DshVersion = '0.1.5-rc.2'

# Keys, chats, settings and the installed profile live here. Named for this
# harness rather than the engine it runs on; every script below and the engine
# itself read $DSH_HOME, so this one line moves all of it.
# An existing $DSH_HOME (set by hand or by a parent shell) still wins.
if (-not $env:DSH_HOME) { $env:DSH_HOME = Join-Path $HOME '.kzh' }

# A terminal opened before Set-TypeSafeKey.ps1 ran will not have the key yet.
# DSH also reads keys from $DSH_HOME\.env, so only warn when neither has it.
if (-not $env:TYPESAFE_API_KEY) {
  $k = [Environment]::GetEnvironmentVariable('TYPESAFE_API_KEY', 'User')
  $dshEnv = Join-Path $env:DSH_HOME '.env'
  if ($k) { $env:TYPESAFE_API_KEY = $k }
  elseif (-not ((Test-Path $dshEnv) -and (Select-String -Path $dshEnv -Pattern '^\s*TYPESAFE_API_KEY\s*=' -Quiet))) {
    Write-Warning 'TYPESAFE_API_KEY not set: Jev routing will use the labelled fallback agent. See C:\Harness\README.md step 2.'
  }
  Remove-Variable k -ErrorAction SilentlyContinue
}

# Codex's Windows sandbox ("elevated" in ~/.codex/config.toml) needs
# codex-windows-sandbox-setup.exe on PATH. The Codex desktop app ships it in a
# versioned folder the CLI does not search, so put the newest one on PATH.
$helper = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin') -Filter 'codex-windows-sandbox-setup.exe' -Recurse -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($helper) { $env:PATH = "$($helper.DirectoryName);$env:PATH" }
else { Write-Warning 'codex-windows-sandbox-setup.exe not found: Codex runs cannot read files. Open the Codex app once, or set [windows] sandbox in ~/.codex/config.toml.' }

if (-not (Test-Path $Workspace)) { New-Item -ItemType Directory -Path $Workspace | Out-Null }
# Privacy: no DSH telemetry, no Claude Code telemetry/error reporting from harness runs,
# and no registry check on every start (the version is pinned; Update-Harness.ps1 updates).
$env:DSH_TELEMETRY_DISABLED = '1'
$env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
$env:npm_config_prefer_offline = 'true'

Set-Location $Workspace
# The "No project" workspace (<harness>\no-project) for plain chat; added before DSH opens its storage.
node (Join-Path $PSScriptRoot 'scripts\ensure-no-project.mjs')
# npx spends about 5 seconds re-resolving a package that is already unpacked in its
# cache, every single launch. When the pinned version is already there, run its entry
# point directly: same process, same arguments, about 120 ms instead. Anything unexpected
# (missing cache, wrong version, no entry point) falls back to npx, which will fetch it.
$dshArgs = @('web')
if ($NoOpen) { $dshArgs += '--no-open' }

function Resolve-DshBin {
  $cache = if ($env:npm_config_cache) { $env:npm_config_cache } else { Join-Path $env:LOCALAPPDATA 'npm-cache' }
  $npx = Join-Path $cache '_npx'
  if (-not (Test-Path $npx)) { return $null }
  foreach ($d in Get-ChildItem $npx -Directory -ErrorAction SilentlyContinue) {
    $pkg = Join-Path $d.FullName 'node_modules\@deepseek-ai\dsh\package.json'
    $bin = Join-Path $d.FullName 'node_modules\@deepseek-ai\dsh\lib\bin.js'
    if (-not (Test-Path $pkg) -or -not (Test-Path $bin)) { continue }
    # Only the pinned version: a stale cache entry must not silently run the wrong engine.
    try { $v = (Get-Content $pkg -Raw | ConvertFrom-Json).version } catch { continue }
    if ($v -eq $DshVersion) { return $bin }
  }
  return $null
}

$dshBin = Resolve-DshBin
if (-not $dshBin) {
  Write-Host "Fetching the engine (first run or new version); this takes a moment."
  # Fetch without booting. The patches below rewrite files in the npx cache, and on a
  # version bump the pinned engine is not unpacked yet, so patching before this point
  # would edit the version that is leaving and start the new one untouched. --version
  # unpacks it and exits, which leaves the patches something real to work on.
  & npx -y "@deepseek-ai/dsh@$DshVersion" --version | Out-Null
  $dshBin = Resolve-DshBin
}

# After the engine is resolved, never before: these patch the copy that is about to run.
# Per-run effort and 1.5x speed for Codex (re-applied if the connector was reinstalled).
node (Join-Path $PSScriptRoot 'scripts\patch-codex-effort.mjs')
# Upstream wording the app and the prompts show: DeepSeek Harness / DSH -> Kz-harness.
node (Join-Path $PSScriptRoot 'scripts\patch-dsh-branding.mjs')
# Search, bookmarks and a taller scrolling list in the composer's model menu.
node (Join-Path $PSScriptRoot 'scripts\patch-dsh-model-menu.mjs')

if ($dshBin) {
  & node $dshBin @dshArgs
} else {
  # The fetch left nothing Resolve-DshBin can see, so the patches above found no engine
  # and npx is about to boot an unpatched one. Invisible from the app, so say it here.
  Write-Warning 'The pinned engine is not in the npx cache after fetching: this run starts unpatched (upstream wording, no model-menu extras, no Codex effort). Run Start-KzH.ps1 again once it is cached.'
  & npx -y "@deepseek-ai/dsh@$DshVersion" @dshArgs
}
