#Requires -Version 5.1
<#
.SYNOPSIS
  ContextOS 发版前脚本：重建编译产物 -> 重新打包安装包 -> 静默安装自检。

.DESCRIPTION
  为什么要这个脚本：
  dist/ 和 frontend/dist/ 都在 .gitignore 里，不进版本库，所以
  inst/contextos-installer.exe 是否与当前 HEAD 一致完全靠人记。
  曾经发生过安装包比 HEAD 落后 3 个提交、把两个真 bug 一起发出去的情况。

  这个脚本做三件事：
    1. 重建 dist/ 与 frontend/dist/（先把旧 frontend/dist 移走，规避 vite emptyOutDir 被拦截）
    2. 用 Inno Setup 重新编译 inst/contextos-installer.exe（旧包自动备份）
    3. 把新包静默安装到一个临时目录，逐项 grep 关键标记，任何一项不通过就报错退出

.PARAMETER SkipVerify
  跳过第 3 步的静默安装自检。仅在你明确知道自己在做什么时使用。

.PARAMETER KeepVerifyDir
  自检完成后保留临时安装目录，便于人工翻看。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\release-build.ps1
#>
[CmdletBinding()]
param(
  [switch]$SkipVerify,
  [switch]$KeepVerifyDir
)

$ErrorActionPreference = "Stop"

function Write-Step { param([string]$Text) Write-Host "" ; Write-Host "==> $Text" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Text) Write-Host "    [OK]   $Text" -ForegroundColor Green }
function Write-Bad  { param([string]$Text) Write-Host "    [FAIL] $Text" -ForegroundColor Red }
function Write-Info { param([string]$Text) Write-Host "    $Text" -ForegroundColor Gray }

$root = Split-Path -Parent $PSScriptRoot
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$tmpRoot = Join-Path $root ".workbuddy-ai\tmp"
if (-not (Test-Path $tmpRoot)) { New-Item -ItemType Directory -Path $tmpRoot -Force | Out-Null }

# ---------------------------------------------------------------- 0. 前置检查

Write-Step "0/4 前置检查"

$node = Get-Command node -ErrorAction SilentlyContinue
$npm  = Get-Command npm  -ErrorAction SilentlyContinue
if (-not $node) { Write-Bad "找不到 node，请确认已安装 Node.js 并在 PATH 中。"; exit 1 }
if (-not $npm)  { Write-Bad "找不到 npm，请确认已安装 Node.js 并在 PATH 中。"; exit 1 }
Write-Ok "node: $($node.Source)"

$isccCandidates = @(
  "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
  "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
)
$iscc = $isccCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $iscc) {
  Write-Bad "找不到 Inno Setup 6 的 ISCC.exe。请安装 Inno Setup 6，或把路径加进脚本里的 `$isccCandidates。"
  exit 1
}
Write-Ok "ISCC: $iscc"

Push-Location $root
try {

  # ------------------------------------------------------------ 1. 重建产物

  Write-Step "1/4 重建编译产物 (tsc + vite build)"

  # vite 的 emptyOutDir 在某些环境下会被批量删除保护拦截，先移走旧目录。
  $feDist = Join-Path $root "frontend\dist"
  if (Test-Path $feDist) {
    $aside = Join-Path $tmpRoot "frontend-dist-$stamp"
    Move-Item -Path $feDist -Destination $aside -Force
    Write-Info "旧 frontend/dist 已移到 $aside"
  }

  & $npm.Source run build:all
  $buildExit = $LASTEXITCODE
  if ($buildExit -ne 0) { Write-Bad "npm run build:all 失败 (exit=$buildExit)"; exit $buildExit }

  $mainJs = Join-Path $root "dist\apps\daemon\src\main.js"
  $feIndex = Join-Path $root "frontend\dist\index.html"
  if (-not (Test-Path $mainJs))  { Write-Bad "缺少 $mainJs"; exit 1 }
  if (-not (Test-Path $feIndex)) { Write-Bad "缺少 $feIndex"; exit 1 }
  Write-Ok "dist\apps\daemon\src\main.js 已生成"
  Write-Ok "frontend\dist\index.html 已生成"

  # ------------------------------------------------------------ 2. 重新打包

  Write-Step "2/4 重新编译安装包"

  $installer = Join-Path $root "inst\contextos-installer.exe"
  if (Test-Path $installer) {
    $backup = Join-Path $tmpRoot "installer-backup-$stamp.exe"
    Move-Item -Path $installer -Destination $backup -Force
    Write-Info "旧安装包已备份到 $backup"
  }

  & $iscc (Join-Path $root "contextos.iss")
  $isccExit = $LASTEXITCODE
  if ($isccExit -ne 0) { Write-Bad "ISCC 编译失败 (exit=$isccExit)"; exit $isccExit }
  if (-not (Test-Path $installer)) { Write-Bad "ISCC 报告成功但找不到 $installer"; exit 1 }

  $sizeMb = [math]::Round((Get-Item $installer).Length / 1MB, 2)
  Write-Ok "安装包已生成：$installer ($sizeMb MB)"

  if ($SkipVerify) {
    Write-Step "4/4 跳过自检 (-SkipVerify)"
    Write-Host ""
    Write-Host "安装包已就绪，但未经自检。发给别人之前请至少手工装一次。" -ForegroundColor Yellow
    exit 0
  }

  # ------------------------------------------------------------ 3. 静默安装

  Write-Step "3/4 静默安装到临时目录"

  $verifyDir = Join-Path $tmpRoot "release-verify"
  if (Test-Path $verifyDir) {
    Move-Item -Path $verifyDir -Destination (Join-Path $tmpRoot "release-verify-$stamp") -Force
  }
  New-Item -ItemType Directory -Path $verifyDir -Force | Out-Null

  $log = Join-Path $tmpRoot "release-verify-$stamp.log"
  $instArgs = @("/VERYSILENT", "/DIR=`"$verifyDir`"", "/NOICONS", "/SUPPRESSMSGBOXES", "/LOG=`"$log`"")
  $proc = Start-Process -FilePath $installer -ArgumentList $instArgs -Wait -PassThru
  if ($proc.ExitCode -ne 0) {
    Write-Bad "静默安装失败 (exit=$($proc.ExitCode))，日志：$log"
    exit $proc.ExitCode
  }
  Write-Ok "安装完成：$verifyDir"

  # ------------------------------------------------------------ 4. 内容自检

  Write-Step "4/4 内容自检"

  & $node.Source $verifyScript $verifyDir
  $verifyExit = $LASTEXITCODE

  # 清理临时安装
  if (-not $KeepVerifyDir) {
    $unins = Join-Path $verifyDir "unins000.exe"
    if (Test-Path $unins) {
      Start-Process -FilePath $unins -ArgumentList @("/VERYSILENT", "/SUPPRESSMSGBOXES") -Wait | Out-Null
    }
    if (Test-Path $verifyDir) {
      Move-Item -Path $verifyDir -Destination (Join-Path $tmpRoot "release-verify-done-$stamp") -Force
    }
    Write-Info "临时安装目录已移入 .workbuddy-ai\tmp"
  }

  Write-Host ""
  if ($verifyExit -ne 0) {
    Write-Host "自检未通过（退出码 $verifyExit）。不要分发这个安装包。" -ForegroundColor Red
    exit $verifyExit
  }
  Write-Host "自检通过。安装包可以分发。" -ForegroundColor Green
  exit 0

} finally {
  Pop-Location
}
