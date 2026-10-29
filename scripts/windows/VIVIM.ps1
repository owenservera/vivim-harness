# One local World and one dedicated browser. Never stop another process.
[CmdletBinding()]
param(
    [switch]$DryRun,
    [string]$DataDir = $(if ($env:CAPTURE_STUDIO_HOME) { $env:CAPTURE_STUDIO_HOME } else { 'C:\VIVIM' }),
    [ValidateRange(1024,65535)][int]$StudioPort = 38703
)
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$cli = Join-Path $repo 'bin\studio.mjs'
$cdpPort = 38702

function Get-Health([int]$Port) {
    $headers = @{}
    if ($env:CAPTURE_STUDIO_TOKEN) { $headers['x-studio-token'] = $env:CAPTURE_STUDIO_TOKEN }
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/v1/health" -Headers $headers -TimeoutSec 2
        if ($health.apiVersion -eq 1 -and $health.version -and $null -ne $health.recorder) { return $true }
    } catch { }
    return $false
}
function Test-Port([int]$Port) {
    $client = New-Object Net.Sockets.TcpClient
    try {
        $pending = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $pending.AsyncWaitHandle.WaitOne(400)) { return $false }
        $client.EndConnect($pending)
        return $true
    } catch { return $false } finally { $client.Dispose() }
}
function Open-World([int]$Port) {
    $url = "http://127.0.0.1:$Port/"
    # Pairing is human-owned: never put a token into process arguments or logs.
    if ($DryRun) { Write-Host "[Dry run] Would open your World: $url" }
    else { Start-Process $url; Write-Host "Your World is ready: $url" }
    Write-Host 'If asked to pair, use the pairing details from your running VIVIM window.'
    Write-Host 'Sign in to your AI website yourself in the dedicated VIVIM browser. No API key or password sharing is needed.'
}

try {
    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $node) { throw 'Install Node.js 22 or newer from https://nodejs.org, then open VIVIM again.' }
    $version = & $node --version
    if ($LASTEXITCODE -ne 0 -or $version -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22) {
        throw 'VIVIM needs Node.js 22 or newer. Update it at https://nodejs.org, then try again.'
    }
    Write-Host "VIVIM - Node.js $version is ready."
    if (-not (Test-Path -LiteralPath $cli)) { throw 'Keep the scripts/windows folder inside your VIVIM installation, then try again.' }

    $ports = @(@($StudioPort, 38710, 38703, 7878) | Select-Object -Unique)
    $occupied = @()
    foreach ($candidate in $ports) {
        if (Get-Health $candidate) {
            Write-Host "VIVIM is already running on port $candidate. Reusing it; no browser or Studio will be started."
            Open-World $candidate
            exit 0
        }
        if (Test-Port $candidate) { $occupied += $candidate }
    }
    if ($occupied.Count) {
        throw "A local app is already using a VIVIM port ($($occupied -join ', ')), but VIVIM could not verify it. If VIVIM requires pairing, set CAPTURE_STUDIO_TOKEN in this window and try again. Do not start a second VIVIM or close your browser."
    }
    $DataDir = [IO.Path]::GetFullPath($DataDir)
    $profile = Join-Path $DataDir 'chrome-profile'
    if (Test-Port $cdpPort) {
        # Use the native ownership contract, not mere port reachability.
        $verify = "import { verifyBrowserOwner } from './src/chrome/browser-ownership.mjs'; try { await verifyBrowserOwner({profileDir:process.argv[1],port:38702}); console.log('Dedicated VIVIM browser verified.'); } catch { console.error('The browser is reachable but is not verified for this VIVIM profile.'); process.exitCode=1; }"
        Push-Location $repo
        try { & $node --input-type=module -e $verify $profile; $verified = $LASTEXITCODE -eq 0 }
        finally { Pop-Location }
        if (-not $verified) {
            throw 'Your browser was left untouched. Check that VIVIM uses the same data folder as before (-DataDir). Save your work before closing only the dedicated VIVIM browser and reopening VIVIM. Never delete its profile.'
        }
    } else {
        if ($DryRun) { Write-Host "[Dry run] Would run: node bin/studio.mjs launch --data-dir `"$DataDir`" --port $cdpPort" }
        else {
            & $node $cli launch --data-dir $DataDir --port $cdpPort
            if ($LASTEXITCODE -ne 0) { throw 'The dedicated browser could not open. Read the message above; your existing profile has not been deleted.' }
        }
    }
    if ($DryRun) {
        Write-Host "[Dry run] Would start Studio on port $StudioPort using data folder $DataDir, only after the dedicated browser is ready."
        Open-World $StudioPort
        exit 0
    }
    # Re-check after browser startup in case a second click started Studio meanwhile.
    foreach ($candidate in $ports) {
        if (Get-Health $candidate) { Open-World $candidate; exit 0 }
        if (Test-Port $candidate) { throw 'Another local app started while VIVIM was opening. Open the existing VIVIM window instead of starting another.' }
    }
    $arguments = '"{0}" serve --data-dir "{1}" --port {2} --studio-port {3} --no-open' -f $cli, $DataDir, $cdpPort, $StudioPort
    Write-Host 'Opening VIVIM. Keep its window open while using your World.'
    $studio = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $repo -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds(25)
    do {
        if (Get-Health $StudioPort) { Open-World $StudioPort; exit 0 }
        if ($studio.HasExited) { throw 'VIVIM stopped before it was ready. Check the VIVIM window for the next step; no restart was attempted.' }
        Start-Sleep -Milliseconds 400
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'VIVIM is still opening. Check its window for progress. Do not start another copy; try opening your World once it is ready.'
} catch {
    Write-Host "VIVIM needs your attention: $($_.Exception.Message)" -ForegroundColor Yellow
    exit 1
}
