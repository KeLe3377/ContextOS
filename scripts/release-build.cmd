@echo off
chcp 65001 >nul
setlocal
pushd "%~dp0.."
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0release-build.ps1" %*
set EXITCODE=%ERRORLEVEL%
popd
echo.
if not "%EXITCODE%"=="0" (
  echo [ContextOS] 发版构建失败或未通过自检，退出码 %EXITCODE%
) else (
  echo [ContextOS] 发版构建完成并通过自检
)
pause
exit /b %EXITCODE%
