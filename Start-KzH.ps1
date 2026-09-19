# Starts the one shared DeepSeek Harness Web UI (http://127.0.0.1:3080).
# Pick or switch the workspace in the UI; nothing here is tied to a project.
# The DSH version is pinned so the installed plugins stay compatible; bump it
# together with the executor plugins (see C:\Harness\README.md).
param(
  [string]$Workspace = 'C:\HarnessProjects',
  [switch]$NoOpen
)
$ErrorActionPreference = 'Stop'
$DshVersion = '0.1.5-rc.2'

# A terminal opened before Set-TypeSafeKey.ps1 ran will not have the key yet.
# DSH also reads keys from $DSH_HOME\.env, so only warn when neither has it.
if (-not $env:TYPESAFE_API_KEY) {
  $k = [Environment]::GetEnvironmentVariable('TYPESAFE_API_KEY', 'User')
  $dshEnv = Join-Path $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }) '.env'
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
# Per-run effort and 1.5x speed for Codex (re-applied if the connector was reinstalled).
node (Join-Path $PSScriptRoot 'scripts\patch-codex-effort.mjs')
$dshArgs = @('-y', "@deepseek-ai/dsh@$DshVersion", 'web')
if ($NoOpen) { $dshArgs += '--no-open' }
& npx @dshArgs
