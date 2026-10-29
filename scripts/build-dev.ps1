# Build the local debug binaries used while developing ContextOS.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/build-dev.ps1

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

cargo build -p wake
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$bins = @("contextos-mcp", "contextos-cli")

$args = @("build", "-p", "wake-core")
foreach ($bin in $bins) {
    $args += @("--bin", $bin)
}

cargo @args
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$targetDir = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { "target" }
$debugDir = Join-Path $targetDir "debug"

Write-Host "Built:"
foreach ($name in @("ContextOS.exe", "contextos-mcp.exe", "contextos-cli.exe")) {
    $path = Join-Path $debugDir $name
    if (Test-Path $path) {
        Write-Host "  $path"
    }
}
