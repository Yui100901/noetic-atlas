@echo off
setlocal
cd /d "%~dp0"
set "release_pause="
if "%~1"=="" set "release_pause=1"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 24.13 or later ^(24.x^) is required on the build machine.
  if defined release_pause pause
  exit /b 1
)
node -e "const [major,minor]=process.versions.node.split('.').map(Number); process.exit(major===24 && minor>=13 ? 0 : 1)"
if errorlevel 1 (
  echo Node.js 24.13 or later ^(24.x^) is required on the build machine.
  if defined release_pause pause
  exit /b 1
)
node scripts/release.mjs %*
set "release_result=%errorlevel%"
echo.
if defined release_pause pause
exit /b %release_result%
