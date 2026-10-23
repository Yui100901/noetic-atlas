$ErrorActionPreference = 'Stop'
$siteRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $siteRoot

$siteNode = $null
$siteNodeCandidates = @()
$siteInstalledNode = Get-Command node.exe -ErrorAction SilentlyContinue
if ($siteInstalledNode) { $siteNodeCandidates += $siteInstalledNode.Source }
if ($env:NOETIC_NODE) { $siteNodeCandidates += $env:NOETIC_NODE }
foreach ($siteCandidate in $siteNodeCandidates) {
    if (Test-Path -LiteralPath $siteCandidate) {
        $siteVersionText = & $siteCandidate --version
        if ($LASTEXITCODE -ne 0) { continue }
        $siteVersion = [version]($siteVersionText.Trim().TrimStart('v'))
        if ($siteVersion.Major -eq 24 -and $siteVersion.Minor -ge 13) { $siteNode = $siteCandidate; break }
    }
}
if (-not $siteNode) { throw '需要Node.js 24.13或更新的24.x版本。安装后重新运行。' }
Write-Host "Node: $siteNode"

if (-not (Test-Path -LiteralPath 'node_modules/fastify/package.json') -or -not (Test-Path -LiteralPath 'node_modules/pdfjs-dist/build/pdf.mjs')) {
    $siteNpmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
    $siteNpmCli = if ($siteNpmCommand) { Join-Path (Split-Path -Parent $siteNpmCommand.Source) 'node_modules/npm/bin/npm-cli.js' } else { '' }
    if (-not $siteNpmCli -or -not (Test-Path -LiteralPath $siteNpmCli)) { throw '未找到npm，请先安装包含npm的Node.js，或在本目录执行npm ci。' }
    & $siteNode $siteNpmCli ci
    if ($LASTEXITCODE -ne 0) { throw '依赖安装失败。' }
}

& $siteNode 'scripts/build/prepare-third-party.mjs'
if ($LASTEXITCODE -ne 0) { throw '本机PDF资源准备失败。' }
& $siteNode 'node_modules/typescript/bin/tsc' -p tsconfig.server.json
if ($LASTEXITCODE -ne 0) { throw '后端编译失败。' }
& $siteNode 'node_modules/typescript/bin/tsc' -p tsconfig.web.json --noEmit
if ($LASTEXITCODE -ne 0) { throw '前端类型检查失败。' }
& $siteNode 'node_modules/vite/bin/vite.js' build
if ($LASTEXITCODE -ne 0) { throw '前端构建失败。' }

$siteHost = if ($env:HOST) { $env:HOST } else { '127.0.0.1' }
$sitePort = if ($env:PORT) { $env:PORT } else { '4317' }
Write-Host "打开 http://${siteHost}:$sitePort ，按 Ctrl+C 退出。"
& $siteNode 'dist/server/main.js'
exit $LASTEXITCODE
