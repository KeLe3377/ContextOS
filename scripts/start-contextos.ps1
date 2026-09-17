param(
  [int]$Port = 4721,
  [string]$HostName = "127.0.0.1",
  [string]$DataDir = ".contextos",
  [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$frontendPath = Join-Path $repoRoot "frontend\dist\index.html"
$databaseFile = Join-Path $DataDir "contextos.sqlite"
$healthUrl = "http://${HostName}:${Port}/api/health"
$frontendUrl = "http://${HostName}:${Port}/"

Set-Location $repoRoot

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

if (-not (Test-Path (Join-Path $repoRoot "node_modules"))) {
  Write-Host "Installing dependencies..."
  npm install
}

npm run frontend:build

if (-not (Test-Path $frontendPath)) {
  throw "Frontend build output not found: $frontendPath"
}

$env:CONTEXTOS_HOST = $HostName
$env:CONTEXTOS_PORT = "$Port"
$env:CONTEXTOS_DATA_DIR = $DataDir
$env:CONTEXTOS_DATABASE_FILE = $databaseFile

Write-Host ""
Write-Host "ContextOS local startup"
Write-Host "Daemon:   $healthUrl"
Write-Host "Frontend: $frontendUrl"
Write-Host "Build:    $frontendPath"
Write-Host "Data:     $(Join-Path $repoRoot $DataDir)"
Write-Host ""
Write-Host "Keep this terminal open while testing. Press Ctrl+C to stop the daemon."
Write-Host ""

if (-not $NoBrowser) {
  Start-Process $frontendUrl
  Start-Process $healthUrl
}

npm run dev
