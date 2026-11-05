# The shared Node entry owns dependency preparation and startup decisions.
$ErrorActionPreference = 'Stop'
$siteRoot = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $siteRoot
try {
    $siteNode = if ($env:NOETIC_NODE) { $env:NOETIC_NODE } else {
        $siteInstalledNode = Get-Command node.exe -ErrorAction SilentlyContinue
        if ($siteInstalledNode) { $siteInstalledNode.Source }
    }
    if (-not $siteNode) { throw 'Node.js 24.13 or later (24.x) is required. Set NOETIC_NODE to its executable if needed.' }
    # Check before loading the Node entry so older runtimes report a clear error.
    & $siteNode -e 'const [major,minor]=process.versions.node.match(/[0-9]+/g).map(Number); process.exit(major===24 && minor>=13 ? 0 : 1)'
    if ($LASTEXITCODE -ne 0) { throw 'Node.js 24.13 or later (24.x) is required.' }
    if (-not $env:NOETIC_NPM_CLI) {
        $siteNpmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
        if ($siteNpmCommand) { $env:NOETIC_NPM_CLI = Join-Path (Split-Path -Parent $siteNpmCommand.Source) 'node_modules/npm/bin/npm-cli.js' }
    }
    & $siteNode (Join-Path $PSScriptRoot 'start.mjs') @args
    $siteExitCode = $LASTEXITCODE
}
catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    $siteExitCode = 1
}
finally { Pop-Location }
exit $siteExitCode
