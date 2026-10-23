# Arguments are passed unchanged to the shared Node release implementation.
$ErrorActionPreference = 'Stop'
$releaseArguments = @($args)
$releaseExitCode = 1
Push-Location -LiteralPath $PSScriptRoot
try {
  $nodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (!$nodeCommand) { throw 'Node.js 24.13 or later (24.x) is required on the build machine.' }
  & $nodeCommand.Source -e 'const [major,minor]=process.versions.node.match(/[0-9]+/g).map(Number); process.exit(major===24 && minor>=13 ? 0 : 1)'
  if ($LASTEXITCODE -ne 0) { throw 'Node.js 24.13 or later (24.x) is required on the build machine.' }
  & $nodeCommand.Source 'scripts/release.mjs' @releaseArguments
  $releaseExitCode = $LASTEXITCODE
}
catch { [Console]::Error.WriteLine($_.Exception.Message) }
finally { Pop-Location }
exit $releaseExitCode
