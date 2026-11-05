param([Parameter(Mandatory=$true)][string]$GradlePath, [Parameter(Mandatory=$true)][string]$InitScript, [switch]$Offline)
$ErrorActionPreference = 'Stop'
$taskArguments = @('--no-daemon', '--init-script', $InitScript, ':app:clean', ':app:assembleDebug')
if ($Offline) { $taskArguments = @('--offline') + $taskArguments }
& $GradlePath @taskArguments
exit $LASTEXITCODE
