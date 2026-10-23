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
where npm >nul 2>nul
if errorlevel 1 (
  echo npm is required on the build machine.
  if defined release_pause pause
  exit /b 1
)
set "release_bootstrap=1"
for %%A in (%*) do (
  if "%%~A"=="--help" set "release_bootstrap="
  if "%%~A"=="-h" set "release_bootstrap="
  if "%%~A"=="--dry-run" set "release_bootstrap="
)
if not exist node_modules\@electron\packager\package.json goto :bootstrap
if not exist node_modules\tsx\package.json goto :bootstrap
if not exist node_modules\typescript\package.json goto :bootstrap
goto :release
:bootstrap
if defined release_bootstrap (
  set "ELECTRON_SKIP_BINARY_DOWNLOAD=1"
  call npm ci --include=dev
  if errorlevel 1 (
    if defined release_pause pause
    exit /b 1
  )
)
:release
call npm run release -- %*
set "release_result=%errorlevel%"
echo.
if defined release_pause pause
exit /b %release_result%
