@echo off
setlocal
chcp 65001 >nul
if defined NOETIC_NODE (
  "%NOETIC_NODE%" "%~dp0scripts\start.mjs" %*
  goto finished
)
where node.exe >nul 2>&1
if errorlevel 1 goto fallback
node.exe "%~dp0scripts\start.mjs" %*
goto finished
:fallback
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start.ps1" %*
:finished
set "siteExit=%errorlevel%"
if not "%siteExit%"=="0" pause
exit /b %siteExit%
