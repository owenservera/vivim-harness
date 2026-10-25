# chrome-cdp.ps1 — start (or reuse) the dedicated Chrome that serves the DevTools protocol.
#
# Why this file exists: a debug port only exists if Chrome was *started* with
# --remote-debugging-port. Any ordinary Chrome launch (taskbar, Start menu, a link in another app)
# attaches to the already-running browser or starts a normal one WITHOUT the port, so the capture
# stack silently loses its browser. Pinning this launcher means the port comes back the same way
# every time, with the same profile, from one double-clickable shortcut.
#
# It never starts a second browser when the port already answers, and it keeps the debug profile as
# a directory junction to your real Chrome profile so sign-ins and cookies are the ones you already
# have — Chrome 136+ refuses remote debugging on the default profile, hence the indirection.
#
# PowerShell 5.1, per-user, no admin required.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\chrome-cdp.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\chrome-cdp.ps1 -Port 9333
#   npm run chrome:cdp

[CmdletBinding()]
param(
  [int]$Port = 9222,
  [string]$Profile = (Join-Path $env:LOCALAPPDATA 'chrome-cdp-profile'),
  [int]$TimeoutSeconds = 25
)

$ErrorActionPreference = 'Stop'

function Test-CdpPort {
  param([int]$P)
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$P/json/version" -UseBasicParsing -TimeoutSec 2
    return ($r.StatusCode -eq 200)
  } catch {
    return $false
  }
}

function Find-ChromeExe {
  $candidates = @()
  if ($env:CHROME_PATH) { $candidates += $env:CHROME_PATH }
  foreach ($base in @($env:PROGRAMFILES, ${env:PROGRAMFILES(X86)}, $env:LOCALAPPDATA)) {
    if (-not $base) { continue }
    $candidates += (Join-Path $base 'Google\Chrome\Application\chrome.exe')
    $candidates += (Join-Path $base 'Google\Chrome Beta\Application\chrome.exe')
    $candidates += (Join-Path $base 'Google\Chrome SxS\Application\chrome.exe')
    $candidates += (Join-Path $base 'Chromium\Application\chrome.exe')
    $candidates += (Join-Path $base 'Microsoft\Edge\Application\msedge.exe')
  }
  foreach ($c in $candidates) {
    if ($c -and (Test-Path -LiteralPath $c -PathType Leaf)) { return $c }
  }
  throw 'Chrome not found. Set CHROME_PATH to chrome.exe and run again.'
}

if ($Port -lt 1 -or $Port -gt 65535) { throw "-Port must be 1..65535 (got $Port)." }

# 1. Already attached? Say so and do nothing — never start a second browser on the same profile.
if (Test-CdpPort -P $Port) {
  Write-Output "already attached on $Port"
  exit 0
}

# 2. The profile directory must resolve to a junction to the real Chrome profile.
$ProfilePath = [System.IO.Path]::GetFullPath($Profile)
$userData = Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'

if (Test-Path -LiteralPath $ProfilePath) {
  $item = Get-Item -LiteralPath $ProfilePath -Force
  $isReparse = (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
  if (-not $isReparse) {
    throw "Refusing to launch: '$ProfilePath' exists but is not a junction. It must be a junction to '$userData' (a real directory there would be a second, empty Chrome profile and Chrome would ignore your existing sign-ins). Delete it and run this script again."
  }
  if (-not (Test-Path -LiteralPath $ProfilePath -PathType Container)) {
    throw "Refusing to launch: '$ProfilePath' is a junction that does not resolve to a directory. Point it at '$userData' or delete it and run this script again."
  }
} else {
  if (-not (Test-Path -LiteralPath $userData -PathType Container)) {
    throw "Chrome profile '$userData' does not exist. Start Chrome once, then run this script again."
  }
  $parent = Split-Path -Parent $ProfilePath
  if ($parent -and -not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
  New-Item -ItemType Junction -Path $ProfilePath -Target $userData | Out-Null
  Write-Output "created junction: $ProfilePath -> $userData"
}

# 3. Launch with exactly the capture flags.
$chrome = Find-ChromeExe
$args = @(
  "--remote-debugging-port=$Port",
  '--remote-debugging-address=127.0.0.1',
  "--user-data-dir=`"$ProfilePath`"",
  '--no-first-run',
  '--no-default-browser-check',
  '--restore-last-session'
)

Write-Output "profile: $ProfilePath"
Write-Output "chrome:  $chrome"
$proc = Start-Process -FilePath $chrome -ArgumentList $args -PassThru

# 4. Wait for the DevTools endpoint to answer.
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
while ((Get-Date) -lt $deadline) {
  if (Test-CdpPort -P $Port) {
    Write-Output "pid:     $($proc.Id)"
    Write-Output "OK"
    exit 0
  }
  Start-Sleep -Milliseconds 250
}

throw "Chrome started (pid $($proc.Id)) but http://127.0.0.1:$Port/json/version did not answer within $TimeoutSeconds s. Close other windows using '$ProfilePath' and run this script again."
