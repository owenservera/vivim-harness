# Builds android/build/vivim.apk with the plain Android build tools (no Gradle).
#
#   pwsh -File android/build.ps1
#
# Requires: JDK 17+ (JAVA_HOME or Android Studio's jbr), Android SDK with
# platforms\android-34 and build-tools\34.0.0.
param(
  [switch]$Clean
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Resolve-Sdk {
  if ($env:ANDROID_HOME) { return $env:ANDROID_HOME }
  if ($env:ANDROID_SDK_ROOT) { return $env:ANDROID_SDK_ROOT }
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Android\Sdk'),
    'C:\Android\Sdk'
  )
  foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
  throw 'Android SDK not found. Set ANDROID_HOME.'
}

function Resolve-JavaHome {
  if ($env:JAVA_HOME -and (Test-Path (Join-Path $env:JAVA_HOME 'bin\javac.exe'))) { return $env:JAVA_HOME }
  $candidates = @(
    'C:\Program Files\Android\Android Studio\jbr',
    'C:\Program Files\Java\jdk-17',
    'C:\Program Files\Eclipse Adoptium\jdk-17'
  )
  foreach ($c in $candidates) { if (Test-Path (Join-Path $c 'bin\javac.exe')) { return $c } }
  throw 'JDK not found. Set JAVA_HOME to a JDK 17+ installation.'
}

$sdk      = Resolve-Sdk
$javaHome = Resolve-JavaHome
$bt       = Join-Path $sdk 'build-tools\34.0.0'
$androidJar = Join-Path $sdk 'platforms\android-34\android.jar'
foreach ($tool in @('aapt2.exe', 'zipalign.exe', 'apksigner.bat')) {
  if (-not (Test-Path (Join-Path $bt $tool))) { throw "Missing build tool: $(Join-Path $bt $tool). Install build-tools;34.0.0." }
}
if (-not (Test-Path $androidJar)) { throw "Missing platform jar: $androidJar. Install platforms;android-34." }

$javac   = Join-Path $javaHome 'bin\javac.exe'
$keytool = Join-Path $javaHome 'bin\keytool.exe'
$java    = Join-Path $javaHome 'bin\java.exe'
$d8Jar   = Join-Path $bt 'lib\d8.jar'
$aapt2   = Join-Path $bt 'aapt2.exe'
$zipalign = Join-Path $bt 'zipalign.exe'
$apksigner = Join-Path $bt 'apksigner.bat'

$out      = Join-Path $here 'build'
$resFlat  = Join-Path $out 'res'
$gen      = Join-Path $out 'gen'
$classes  = Join-Path $out 'classes'
$dexDir   = Join-Path $out 'dex'
$keystore = Join-Path $here '.keystore'

if ($Clean -and (Test-Path $out)) { Remove-Item -Recurse -Force $out }
foreach ($d in @($out, $resFlat, $gen, $classes, $dexDir)) {
  if (Test-Path $d) { Remove-Item -Recurse -Force $d }
  New-Item -ItemType Directory -Path $d -Force | Out-Null
}

Write-Host '[1/7] aapt2 compile (resources)'
& $aapt2 compile --dir (Join-Path $here 'res') -o (Join-Path $out 'res.zip')
if ($LASTEXITCODE -ne 0) { throw 'aapt2 compile failed' }

Write-Host '[2/7] aapt2 link (resources + manifest)'
$baseApk = Join-Path $out 'base.apk'
& $aapt2 link -o $baseApk -I $androidJar --manifest (Join-Path $here 'AndroidManifest.xml') `
  -R (Join-Path $out 'res.zip') --java $gen --auto-add-overlay
if ($LASTEXITCODE -ne 0) { throw 'aapt2 link failed' }

Write-Host '[3/7] javac (--release 11)'
$sources = @()
$sources += (Get-ChildItem -Path (Join-Path $here 'src') -Recurse -Filter *.java | ForEach-Object { $_.FullName })
$sources += (Get-ChildItem -Path $gen -Recurse -Filter *.java | ForEach-Object { $_.FullName })
& $javac --release 11 -encoding UTF-8 -Xlint:-options -classpath $androidJar -d $classes @sources
if ($LASTEXITCODE -ne 0) { throw 'javac failed' }

Write-Host '[4/7] d8 (classes.dex)'
$classFiles = Get-ChildItem -Path $classes -Recurse -Filter *.class | ForEach-Object { $_.FullName }
& $java -cp $d8Jar com.android.tools.r8.D8 --release --min-api 26 --lib $androidJar --output $dexDir @classFiles
if ($LASTEXITCODE -ne 0) { throw 'd8 failed' }

Write-Host '[5/7] package (base.apk + classes.dex)'
$unsigned = Join-Path $out 'unsigned.apk'
Copy-Item $baseApk $unsigned -Force
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open($unsigned, 'Update')
try {
  [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
    $zip, (Join-Path $dexDir 'classes.dex'), 'classes.dex', 'Optimal') | Out-Null
} finally {
  $zip.Dispose()
}

Write-Host '[6/7] zipalign'
$aligned = Join-Path $out 'aligned.apk'
& $zipalign -f -p 4 $unsigned $aligned
if ($LASTEXITCODE -ne 0) { throw 'zipalign failed' }

Write-Host '[7/7] sign (debug keystore)'
if (-not (Test-Path $keystore)) {
  & $keytool -genkeypair -keystore $keystore -storetype PKCS12 -alias vivim `
    -storepass android -keypass android -keyalg RSA -keysize 2048 -validity 10000 `
    -dname 'CN=VIVIM, O=VIVIM, C=US'
  if ($LASTEXITCODE -ne 0) { throw 'keytool failed' }
}
$finalApk = Join-Path $out 'vivim.apk'
if (Test-Path $finalApk) { Remove-Item $finalApk -Force }
& $apksigner sign --ks $keystore --ks-key-alias vivim --ks-pass pass:android --key-pass pass:android `
  --min-sdk-version 26 --out $finalApk $aligned
if ($LASTEXITCODE -ne 0) { throw 'apksigner failed' }

& $apksigner verify --print-certs $finalApk
if ($LASTEXITCODE -ne 0) { throw 'apksigner verify failed' }

Remove-Item (Join-Path $out 'res.zip'), $unsigned, $aligned -Force -ErrorAction SilentlyContinue
$size = [math]::Round((Get-Item $finalApk).Length / 1KB, 1)
Write-Host ''
Write-Host "APK: $finalApk ($size KB)"
Write-Host 'Install: adb install -r android\build\vivim.apk'
