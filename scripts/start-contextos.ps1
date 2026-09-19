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

# 光是“文件存在”还不够：PATH 里的同名程序、被安全策略拦下的 exe 都会让
# `& $node` 静默失败（$LASTEXITCODE 为空）。所以逐个候选真正跑一次 `-v`。
function Test-NodeCommand([string]$candidate) {
  if (-not $candidate) { return $false }
  if (-not (Test-Path $candidate)) { return $false }
  try {
    $version = & $candidate -v 2>$null
    return ("$version" -match "^v\d+")
  } catch {
    return $false
  }
}

function Get-NodeCommand {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source -and (Test-NodeCommand $cmd.Source)) { return $cmd.Source }

  $candidates = @(
    "C:\Program Files\nodejs\node.exe",
    "C:\Program Files (x86)\nodejs\node.exe"
  )
  if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles "nodejs\node.exe") }
  if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA "Programs\nodejs\node.exe") }
  foreach ($candidate in $candidates) {
    if (Test-NodeCommand $candidate) { return $candidate }
  }

  return $null
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
    Write-Host "ContextOS 已在运行"
    Write-Host "守护进程: $healthUrl"
    Write-Host "前端地址: $frontendUrl"
    Write-Host ""
    if (-not $NoBrowser) {
      Start-Process $frontendUrl
    }
    exit 0
  }
} catch {
  # 没有健康的守护进程在监听，继续正常启动流程。
}

try {
  $node = Get-NodeCommand
  if (-not $node) {
    throw "未找到可执行的 Node.js。请安装 Node.js 20 LTS（https://nodejs.org）后重试。"
  }

  $useCompiledBuild = Test-Path $daemonEntry
  if (-not $useCompiledBuild -and -not (Test-Path $sourceEntry)) {
    throw "未找到 ContextOS 守护进程入口。预期编译产物 '$daemonEntry' 或源码 '$sourceEntry'。"
  }

  # 不能只判断 node_modules 目录是否存在：安装时 npm install 失败会留下一个空目录，
  # 那样会跳过装依赖、随后报 "Cannot find module 'fastify'"。检查真实依赖包。
  $missingDeps = @()
  foreach ($dep in @("fastify", "better-sqlite3", "zod")) {
    if (-not (Test-Path (Join-Path $repoRoot "node_modules/$dep"))) { $missingDeps += $dep }
  }
  if ($missingDeps.Count -gt 0) {
    Write-Host "正在安装依赖（缺少 $($missingDeps -join '、')）..."
    if ($useCompiledBuild) {
      npm install --omit=dev --no-audit --no-fund
    } else {
      npm install --no-audit --no-fund
    }
    if ($LASTEXITCODE -ne 0) { throw "npm install 失败，退出码 $LASTEXITCODE。" }
  }

  $frontendPath = Get-FrontendPath
  if (-not $frontendPath) {
    throw "未找到前端构建产物。预期 '$repoRoot' 下的 frontend/dist/index.html 或 index.html。"
  }

  $resolvedDataDir = Resolve-DataDir $DataDir
  $databaseFile = Join-Path $resolvedDataDir "contextos.sqlite"

  $env:CONTEXTOS_HOST = $HostName
  $env:CONTEXTOS_PORT = "$Port"
  $env:CONTEXTOS_DATA_DIR = $resolvedDataDir
  $env:CONTEXTOS_DATABASE_FILE = $databaseFile
  $env:CONTEXTOS_FRONTEND_DIR = Split-Path -Parent $frontendPath

  Write-Host ""
  Write-Host "ContextOS 本地启动"
  Write-Host "守护进程: $healthUrl"
  Write-Host "前端地址: $frontendUrl"
  Write-Host "构建产物: $frontendPath"
  Write-Host "数据目录: $resolvedDataDir"
  Write-Host "运行模式: $(if ($useCompiledBuild) { '编译产物' } else { '源码 (tsx)' })"
  Write-Host "Node:     $node"
  Write-Host ""
  Write-Host "测试期间请保持本窗口打开，按 Ctrl+C 停止守护进程。"
  Write-Host ""

  if (-not $NoBrowser) {
    Start-Process $frontendUrl
  }

  if ($useCompiledBuild) {
    & $node $daemonEntry
    $daemonExit = $LASTEXITCODE
    if ($null -eq $daemonExit) { throw "守护进程启动失败：无法执行 '$node'。" }
    if ($daemonExit -ne 0) { throw "守护进程退出，退出码 $daemonExit。" }
  } else {
    npm run dev
    if ($LASTEXITCODE -ne 0) { throw "npm run dev 退出，退出码 $LASTEXITCODE。" }
  }
} catch {
  Write-Host ""
  Write-Host "========================================" -ForegroundColor Red
  Write-Host "启动 ContextOS 时发生错误：" -ForegroundColor Red
  Write-Host "$_" -ForegroundColor Red
  Write-Host "========================================" -ForegroundColor Red
  Write-Host ""
  try {
    Read-Host "按回车键退出"
  } catch {
    # 非交互宿主（CI / 计划任务）：跳过等待。
  }
  exit 1
}
