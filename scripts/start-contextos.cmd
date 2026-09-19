@echo off
setlocal
rem 切到 UTF-8 代码页，保证本文件中的中文提示不会显示成乱码
chcp 65001 >nul
cd /d "%~dp0\.."

rem 源码开发模式：数据放在仓库内 .contextos
rem 安装后的纯产物模式：数据放在 %APPDATA%\ContextOS\.contextos，避免卸载时被删除
set "DATA_DIR=.contextos"
if not exist "%~dp0..\apps\daemon\src\main.ts" (
  if exist "%~dp0..\dist\apps\daemon\src\main.js" (
    set "DATA_DIR=%APPDATA%\ContextOS\.contextos"
  )
)

powershell -ExecutionPolicy Bypass -File "scripts\start-contextos.ps1" -DataDir "%DATA_DIR%"
pause
