param(
  [int]$Port = 4721,
  [string]$HostName = "127.0.0.1",
  [string]$DataDir = ".contextos",
  [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$daemonEntry = Join-Path $repoRoot "dist/apps/daemon/src/main.js"
$sourceEntry = Join-Path $repoRoot "apps/daemon/src/main.ts"
$healthUrl = "http://${HostName}:${Port}/api/health"
$frontendUrl = "http://${HostName}:${Port}/"

Set-Location $repoRoot

function Resolve-DataDir([string]$value) {
  if ([System.IO.Path]::IsPathRooted($value)) { return $value }
  return Join-Path $repoRoot $value
}

function Get-NodeCommand {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }

  $candidates = @(
    "C:\Program Files\nodejs\node.exe",
    "C:\Program Files (x86)\nodejs\node.exe"
  )
  if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles "nodejs\node.exe") }
  if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA "Programs\nodejs\node.exe") }
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) { return $candidate }
  }

  # 找不到就退回 PATH 解析，让系统自己报错
  return "node"
}

function Get-FrontendPath {
  $candidates = @(
    (Join-Path $repoRoot "frontend/dist/index.html"),
    (Join-Path $repoRoot "index.html")
  )
  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) { return $candidate }
  }
  return $null
}

try {
  $health = Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec 2
  if ($health.processState -eq "ready") {
    Write-Host ""
    Write-Host "ContextOS is already running"
    Write-Host "Daemon:   $healthUrl"
    Write-Host "Frontend: $frontendUrl"
    Write-Host ""
    if (-not $NoBrowser) {
      Start-Process $frontendUrl
    }
    exit 0
  }
} catch {
  # No healthy daemon is listening; continue with a normal local startup.
}

try {
  $node = Get-NodeCommand

  $useCompiledBuild = Test-Path $daemonEntry
  if (-not $useCompiledBuild -and -not (Test-Path $sourceEntry)) {
    throw "ContextOS daemon entry not found. Expected compiled build at '$daemonEntry' or source at '$sourceEntry'."
  }

  if (-not (Test-Path (Join-Path $repoRoot "node_modules"))) {
    Write-Host "Installing dependencies..."
    if ($useCompiledBuild) {
      npm install --omit=dev --no-audit --no-fund
    } else {
      npm install --no-audit --no-fund
    }
    if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE." }
  }

  $frontendPath = Get-FrontendPath
  if (-not $frontendPath) {
    throw "Frontend build output not found under '$repoRoot'. Expected frontend/dist/index.html or index.html."
  }

  $resolvedDataDir = Resolve-DataDir $DataDir
  $databaseFile = Join-Path $resolvedDataDir "contextos.sqlite"

  $env:CONTEXTOS_HOST = $HostName
  $env:CONTEXTOS_PORT = "$Port"
  $env:CONTEXTOS_DATA_DIR = $resolvedDataDir
  $env:CONTEXTOS_DATABASE_FILE = $databaseFile
  $env:CONTEXTOS_FRONTEND_DIR = Split-Path -Parent $frontendPath

  Write-Host ""
  Write-Host "ContextOS local startup"
  Write-Host "Daemon:   $healthUrl"
  Write-Host "Frontend: $frontendUrl"
  Write-Host "Build:    $frontendPath"
  Write-Host "Data:     $resolvedDataDir"
  Write-Host "Mode:     $(if ($useCompiledBuild) { 'compiled build' } else { 'source (tsx)' })"
  Write-Host ""
  Write-Host "Keep this terminal open while testing. Press Ctrl+C to stop the daemon."
  Write-Host ""

  if (-not $NoBrowser) {
    Start-Process $frontendUrl
  }

  if ($useCompiledBuild) {
    & $node $daemonEntry
    if ($LASTEXITCODE -ne 0) {
      throw "Daemon exited with code $LASTEXITCODE. If 'node' was not recognized, install Node.js 20 LTS from https://nodejs.org and try again."
    }
  } else {
    npm run dev
    if ($LASTEXITCODE -ne 0) { throw "npm run dev exited with code $LASTEXITCODE." }
  }
} catch {
  Write-Host ""
  Write-Host "========================================" -ForegroundColor Red
  Write-Host "Error occurred while starting ContextOS:" -ForegroundColor Red
  Write-Host "$_" -ForegroundColor Red
  Write-Host "========================================" -ForegroundColor Red
  Write-Host ""
  try {
    Read-Host "Press Enter to exit"
  } catch {
    # Non-interactive host (CI / scheduled task): skip the prompt.
  }
  exit 1
}
