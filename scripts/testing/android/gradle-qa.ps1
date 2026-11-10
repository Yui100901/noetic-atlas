param([Parameter(Mandatory=$true)][string]$GradlePath, [Parameter(Mandatory=$true)][string]$InitScript, [switch]$Offline, [string]$QaVersion, [string]$QaVersionCode)
$ErrorActionPreference = 'Stop'
$taskArguments = @('--no-daemon', '--init-script', $InitScript, ':app:clean', ':app:assembleDebug')
if ($Offline) { $taskArguments = @('--offline') + $taskArguments }
if ($QaVersion -or $QaVersionCode) {
    if (!$QaVersion -or $QaVersionCode -notmatch '^[1-9]\d*$') { throw 'Both QA version properties are required' }
    $taskArguments = @("-PnoeticQaVersion=$QaVersion", "-PnoeticQaVersionCode=$QaVersionCode") + $taskArguments
}
& $GradlePath @taskArguments
exit $LASTEXITCODE
