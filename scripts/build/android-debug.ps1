param([string]$SdkRoot = '', [string]$JavaRoot = '', [ValidateSet('Debug','Release')][string]$Mode = 'Debug')
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if ($Mode -eq 'Release' -and $env:ANDROID_KEYSTORE) {
  foreach ($name in @('ANDROID_STORE_PASSWORD','ANDROID_KEY_ALIAS','ANDROID_KEY_PASSWORD')) {
    if (![Environment]::GetEnvironmentVariable($name)) { throw "正式签名配置不完整：$name" }
  }
}
if (!$JavaRoot) { $JavaRoot = $env:JAVA_HOME }
if (!$SdkRoot) {
  foreach ($candidate in @((Join-Path $taskRoot '.localtools\android-sdk'), $env:ANDROID_HOME, $env:ANDROID_SDK_ROOT, (Join-Path $env:LOCALAPPDATA 'Android\Sdk'))) {
    if ($candidate -and (Test-Path -LiteralPath (Join-Path $candidate 'platforms\android-36\android.jar'))) { $SdkRoot = $candidate; break }
  }
}
if (!$JavaRoot -or !(Test-Path -LiteralPath (Join-Path $JavaRoot 'bin\java.exe'))) { throw '需要 Java 21，请设置 JAVA_HOME 或通过 -JavaRoot 指定 JDK 路径' }
if (!$SdkRoot -or !(Test-Path -LiteralPath (Join-Path $SdkRoot 'platforms\android-36\android.jar'))) { throw '需要 Android SDK API 36，请通过 -SdkRoot 指定，参见 docs/发布与部署.md' }
$JavaRoot = (Resolve-Path -LiteralPath $JavaRoot).ProviderPath
$SdkRoot = (Resolve-Path -LiteralPath $SdkRoot).ProviderPath
$env:JAVA_HOME = $JavaRoot
$env:ANDROID_HOME = $SdkRoot
$env:ANDROID_SDK_ROOT = $SdkRoot
$env:PATH = (Join-Path $JavaRoot 'bin') + ';' + $env:PATH
$env:GRADLE_USER_HOME = Join-Path $taskRoot '.localtools\gradle-home'
Push-Location $taskRoot
try {
  $signingDirectory = Join-Path $taskRoot '.localtools\signing'
  New-Item -ItemType Directory -Path $signingDirectory -Force | Out-Null
  $debugKey = Join-Path $signingDirectory 'debug.keystore'
  if (!(Test-Path -LiteralPath $debugKey)) {
    & (Join-Path $JavaRoot 'bin\keytool.exe') -genkeypair -keystore $debugKey -alias androiddebugkey -storepass android -keypass android -dname 'CN=Android Debug,O=Android,C=US' -keyalg RSA -keysize 2048 -validity 10000
    if ($LASTEXITCODE -ne 0) { throw '无法创建项目本地调试签名' }
  }
  & npm.cmd run mobile:sync
  if ($LASTEXITCODE -ne 0) { throw 'Web 资源构建或 Capacitor 同步失败' }
  $sdkProperty = $SdkRoot.Replace('\', '/').Replace(':', '\:')
  $sdkProperty = ($sdkProperty.ToCharArray() | ForEach-Object { if ([int]$_ -gt 127) { '\u{0:x4}' -f [int]$_ } else { [string]$_ } }) -join ''
  [IO.File]::WriteAllText((Join-Path $taskRoot 'android\local.properties'), "sdk.dir=$sdkProperty`n", [Text.UTF8Encoding]::new($false))
  Push-Location (Join-Path $taskRoot 'android')
  try {
    $localGradle = Join-Path $taskRoot '.localtools\gradle-8.14.3\bin\gradle.bat'
    if (Test-Path -LiteralPath $localGradle) { & $localGradle --no-daemon :app:clean ":app:assemble$Mode" }
    else { & .\gradlew.bat --no-daemon :app:clean ":app:assemble$Mode" }
    if ($LASTEXITCODE -ne 0) { throw 'Android 构建失败' }
  }
  finally { Pop-Location }
  New-Item -ItemType Directory -Path (Join-Path $taskRoot 'dist\apk') -Force | Out-Null
  $apkName = if ($Mode -eq 'Debug') { 'app-debug.apk' } elseif ($env:ANDROID_KEYSTORE) { 'app-release.apk' } else { 'app-release-unsigned.apk' }
  $artifactName = if ($Mode -eq 'Debug') { 'noetic-atlas-debug.apk' } elseif ($env:ANDROID_KEYSTORE) { 'noetic-atlas-release.apk' } else { 'noetic-atlas-release-unsigned.apk' }
  Copy-Item -LiteralPath (Join-Path $taskRoot "android\app\build\outputs\apk\$($Mode.ToLower())\$apkName") -Destination (Join-Path $taskRoot "dist\apk\$artifactName")
  New-Item -ItemType Directory -Path (Join-Path $taskRoot 'artifacts') -Force | Out-Null
  $artifactPath = Join-Path $taskRoot "artifacts\$artifactName"
  Copy-Item -LiteralPath (Join-Path $taskRoot "dist\apk\$artifactName") -Destination $artifactPath
  # Native .NET hashing also works when Windows PowerShell inherits a module
  # search path from PowerShell 7 that omits the Get-FileHash module.
  $hashAlgorithm = [Security.Cryptography.SHA256]::Create()
  $apkStream = [IO.File]::OpenRead($artifactPath)
  try { $apkHash = [BitConverter]::ToString($hashAlgorithm.ComputeHash($apkStream)).Replace('-', '').ToLowerInvariant() }
  finally { $apkStream.Dispose(); $hashAlgorithm.Dispose() }
  Write-Output ([pscustomobject]@{ Path = $artifactPath; SHA256 = $apkHash })
}
finally { Pop-Location }
