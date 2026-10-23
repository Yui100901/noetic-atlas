param([Parameter(Mandatory=$true)][string]$Archive,[Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference='Stop'
$projectRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$cacheRoot=[IO.Path]::GetFullPath((Join-Path $projectRoot '.localtools/desktop-cache'))
$resolvedArchive=[IO.Path]::GetFullPath($Archive)
$resolvedDestination=[IO.Path]::GetFullPath($Destination)
if($resolvedDestination -ne $cacheRoot -or [IO.Path]::GetDirectoryName($resolvedArchive) -ne $cacheRoot) { throw 'Invalid runtime extraction path.' }
Expand-Archive -LiteralPath $resolvedArchive -DestinationPath $resolvedDestination -Force
