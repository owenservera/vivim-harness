# VIVIM one-click start for Windows. Double-click VIVIM.cmd (or a VIVIM shortcut).
#
#   .\VIVIM.ps1            reuse a running VIVIM, otherwise open the dedicated browser + Studio
#   .\VIVIM.ps1 -LanPair   same, with phone pairing (prints the phone link + QR code)
#   .\VIVIM.ps1 -Stop      stop the Studio we started, or ask before stopping another owner
#   .\VIVIM.ps1 -DryRun    preview only: checks everything, starts/stops/opens nothing
#
# One Studio per browser. Studio runs hidden in the background, so closing this window does not
# stop it; use "Stop VIVIM". The launcher never closes a browser, sends an AI message or signs in.
# Windows PowerShell 5.1 compatible; keep this file ASCII-only (5.1 reads BOM-less files as ANSI).
[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$LanPair,
    [switch]$Stop,
    [switch]$Force,
    [switch]$NoPause,
    [string]$DataDir = $(if ($env:CAPTURE_STUDIO_HOME) { $env:CAPTURE_STUDIO_HOME } else { 'C:\VIVIM' }),
    [ValidateRange(1024, 65535)][int]$StudioPort = 38730
)
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$cli = Join-Path $repo 'bin\studio.mjs'
$helper = Join-Path $PSScriptRoot 'launcher-helper.mjs'
$cdpPort = 38702
$nodeDownload = 'https://nodejs.org/en/download'
$interactive = [Environment]::UserInteractive -and -not $NoPause

function Say([string]$Text) { Write-Host $Text }
function Preview([string]$Text) { Write-Host "[Preview] $Text" -ForegroundColor Cyan }

# --- Studio health -----------------------------------------------------------------------------
# Returns 'ok' (VIVIM answered), 'locked' (VIVIM answered but wants its pairing token),
# 'other' (something else listens there) or 'none' (nothing listens).
# HttpWebRequest with no proxy: works on PowerShell 5.1 and 7 and never routes loopback via a proxy.
function Get-Health([int]$Port, [string]$Token) {
    $request = [Net.HttpWebRequest]::Create("http://127.0.0.1:$Port/api/v1/health")
    $request.Proxy = $null
    $request.Timeout = 2500
    $request.ReadWriteTimeout = 2500
    if ($Token) { $request.Headers.Add('x-studio-token', $Token) }
    $response = $null
    try {
        $response = $request.GetResponse()
        $reader = New-Object IO.StreamReader($response.GetResponseStream())
        $body = $reader.ReadToEnd() | ConvertFrom-Json
        if ($body.apiVersion -eq 1 -and $body.version -and $null -ne $body.recorder) {
            return [pscustomobject]@{ State = 'ok'; Port = $Port; Health = $body }
        }
        return [pscustomobject]@{ State = 'other'; Port = $Port; Health = $null }
    } catch [Net.WebException] {
        $failed = $_.Exception.Response
        if ($failed) {
            $code = [int]$failed.StatusCode
            $failed.Close()
            # Studio in pairing (token) mode answers 401 for /api/* without the token.
            if ($code -eq 401) { return [pscustomobject]@{ State = 'locked'; Port = $Port; Health = $null } }
            return [pscustomobject]@{ State = 'other'; Port = $Port; Health = $null }
        }
        if (Test-Port $Port) { return [pscustomobject]@{ State = 'other'; Port = $Port; Health = $null } }
        return [pscustomobject]@{ State = 'none'; Port = $Port; Health = $null }
    } catch {
        return [pscustomobject]@{ State = 'other'; Port = $Port; Health = $null }
    } finally { if ($response) { $response.Close() } }
}
function Test-Port([int]$Port) {
    $client = New-Object Net.Sockets.TcpClient
    try {
        $pending = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $pending.AsyncWaitHandle.WaitOne(400)) { return $false }
        $client.EndConnect($pending)
        return $true
    } catch { return $false } finally { $client.Close() }
}

# --- Ownership records ------------------------------------------------------------------------
# src/studio/cdp-owner-lock.mjs writes <data>\locks\cdp-<port>.json for the one Studio driving the
# browser. The launcher adds <data>\logs\vivim-launcher.json (pid, port, lan; never a token).
function Read-Json([string]$Path) {
    try { if (Test-Path -LiteralPath $Path) { return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json } } catch { }
    return $null
}
function Test-Alive($ProcessId) {
    if (-not $ProcessId) { return $false }
    return $null -ne (Get-Process -Id ([int]$ProcessId) -ErrorAction SilentlyContinue)
}
function Get-Owner {
    $lock = Read-Json $lockFile
    if ($lock -and $lock.pid -and (Test-Alive $lock.pid) -and $lock.studioPort) { return $lock }
    return $null
}
function Get-LaunchedLog {
    # The pairing link of a Studio this launcher started (log is private to this data folder).
    $file = $studioLog
    $state = Read-Json $stateFile
    if ($state -and $state.logFile) { $file = $state.logFile }
    if (-not (Test-Path -LiteralPath $file)) { return '' }
    try { return [IO.File]::ReadAllText($file) } catch { return '' }
}
function Get-PairingUrl([string]$Log) {
    $match = [regex]::Match($Log, 'http://[0-9.]+:\d+/mobile\?token=[^\s]+')
    if ($match.Success) { return $match.Value }
    return $null
}
function Get-TokenFromUrl([string]$Url) {
    if (-not $Url) { return $null }
    $match = [regex]::Match($Url, '[?&]token=([^&\s]+)')
    if ($match.Success) { return [Uri]::UnescapeDataString($match.Groups[1].Value) }
    return $null
}
function Get-KnownToken {
    # A pairing token can come from the user's environment or from a Studio this launcher started.
    if ($env:CAPTURE_STUDIO_TOKEN) { return $env:CAPTURE_STUDIO_TOKEN }
    $state = Read-Json $stateFile
    $owner = Get-Owner
    if ($state -and $owner -and [int]$state.pid -eq [int]$owner.pid) { return Get-TokenFromUrl (Get-PairingUrl (Get-LaunchedLog)) }
    return $null
}

# Find a running VIVIM: the CDP owner first, then the usual Studio ports.
function Find-Studio {
    $token = Get-KnownToken
    $candidates = New-Object Collections.Generic.List[int]
    $owner = Get-Owner
    if ($owner) { $candidates.Add([int]$owner.studioPort) }
    foreach ($p in @($StudioPort, 38730, 38703, 38710, 7878)) { if (-not $candidates.Contains($p)) { $candidates.Add($p) } }
    $blocked = @()
    foreach ($candidate in $candidates) {
        $probe = Get-Health $candidate $null
        if ($probe.State -eq 'locked' -and $token) {
            $withToken = Get-Health $candidate $token
            if ($withToken.State -eq 'ok') { return [pscustomobject]@{ Port = $candidate; Token = $token; Health = $withToken.Health; Blocked = @() } }
        }
        if ($probe.State -eq 'ok') { return [pscustomobject]@{ Port = $candidate; Token = $null; Health = $probe.Health; Blocked = @() } }
        if ($probe.State -eq 'locked' -and $owner -and $candidate -eq $owner.studioPort) { return [pscustomobject]@{ Port = $candidate; Token = $null; Health = $null; Locked = $true; Blocked = @() } }
        if ($probe.State -eq 'locked') { $blocked += $candidate }
        if ($probe.State -eq 'other') { $blocked += $candidate }
    }
    return [pscustomobject]@{ Port = $null; Blocked = $blocked; Owner = $owner }
}

function Open-World($Found) {
    $base = "http://127.0.0.1:$($Found.Port)/"
    # Token mode: the tokenized URL sets a cookie and redirects to the clean address, so the token
    # does not stay in the address bar. Local mode needs no token at all.
    $url = $base
    if ($Found.Token) { $url = "${base}?token=$([Uri]::EscapeDataString($Found.Token))" }
    if ($DryRun) { Preview "Would open your World: $base" }
    else { Start-Process $url; Say "Your World is open: $base" }
    if ($Found.Locked -and -not $Found.Token) {
        Say 'This VIVIM uses phone pairing. If your World asks for pairing, open the link VIVIM showed when it started, or start VIVIM again with the same CAPTURE_STUDIO_TOKEN.'
    }
    Say 'Sign in to ChatGPT or Claude yourself in the dedicated VIVIM browser. VIVIM uses your own accounts; no API key or password sharing is needed.'
}

function Show-PhoneLink([string]$PairingUrl) {
    Say ''
    Say 'Phone pairing is on. Join your phone to the same WiFi, then scan this code or open the link:'
    Say "  $PairingUrl"
    $env:VIVIM_QR_TEXT = $PairingUrl
    try { & $node $helper qr } catch { } finally { Remove-Item Env:\VIVIM_QR_TEXT -ErrorAction SilentlyContinue }
    if (-not $DryRun) { try { Set-Clipboard -Value $PairingUrl; Say 'The link is also copied to your clipboard.' } catch { } }
    Say 'Anyone with this link can use your VIVIM while it runs. Do not share it. If Windows asks about the firewall, allow private networks only.'
}

function Wait-Exit {
    if ($interactive -and -not $DryRun) { [void](Read-Host 'Press Enter to close this window (VIVIM keeps running)') }
}

function Find-Node {
    $command = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
    # Just installed Node.js? Explorer may still hand out the old PATH; check the usual install folders.
    foreach ($dir in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, (Join-Path $env:LOCALAPPDATA 'Programs'))) {
        if (-not $dir) { continue }
        $candidate = Join-Path $dir 'nodejs\node.exe'
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    return $null
}

function Stop-Studio {
    $owner = Get-Owner
    if (-not $owner) { Say 'VIVIM is not running for this data folder. Nothing to stop.'; return }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$owner.pid)" -ErrorAction SilentlyContinue
    $cliPattern = '(?:' + [regex]::Escape($cli) + '|(?:\.\\|\./)?bin[\\/]studio\.mjs)["\s]'
    if (-not $process -or $process.CommandLine -notmatch $cliPattern -or $process.CommandLine -notmatch '\s(?:serve|start)(?:\s|$)' -or $process.Name -ne 'node.exe') {
        throw "The VIVIM lock points at process $($owner.pid), which is not a VIVIM Studio. Nothing was stopped."
    }
    $probe = Get-Health ([int]$owner.studioPort) (Get-KnownToken)
    if ($probe.Health -and $probe.Health.recorder.state -in @('recording', 'stopping') -and -not $Force) {
        throw 'VIVIM is recording right now. Stop the recording in your World first so it is saved, then use Stop VIVIM again (or add -Force).'
    }
    $state = Read-Json $stateFile
    $creation = $process.CreationDate.ToUniversalTime().ToString('o')
    $ours = $state -and $state.pid -eq $owner.pid -and $state.processCreatedTicks -eq $process.CreationDate.ToUniversalTime().Ticks.ToString()
    if ($DryRun) { Preview "Would stop VIVIM Studio (process $($owner.pid), port $($owner.studioPort)); confirmation required: $(-not $ours). The browser and sign-ins would stay."; return }
    if (-not $ours) {
        if (-not $interactive) { throw 'This Studio was not started by this launcher. Run Stop VIVIM interactively to confirm stopping it.' }
        $answer = Read-Host "Another VIVIM owns this browser (port $($owner.studioPort)). Stop that Studio? Type YES to confirm"
        if ($answer -cne 'YES') { Say 'Nothing was stopped.'; return }
    }
    $currentOwner = Get-Owner
    $currentProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$owner.pid)" -ErrorAction SilentlyContinue
    if (-not $currentOwner -or $currentOwner.pid -ne $owner.pid -or $currentOwner.startedAt -ne $owner.startedAt -or -not $currentProcess -or $currentProcess.CreationDate.ToUniversalTime().ToString('o') -ne $creation) {
        throw 'VIVIM changed while checking. Nothing was stopped. Open Stop VIVIM again.'
    }
    Stop-Process -Id ([int]$owner.pid) -Force
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while ((Test-Alive $owner.pid) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 250 }
    if (Test-Alive $owner.pid) { throw 'VIVIM has not stopped yet. Your browser was left open.' }
    Say 'VIVIM has stopped. The VIVIM browser stays open with your sign-ins; close its window normally if you like.'
}

try {
    $node = Find-Node
    if (-not $node) {
        if (-not $DryRun) { try { Start-Process $nodeDownload } catch { } }
        throw "VIVIM needs Node.js 22 or newer. Install the LTS version from $nodeDownload, then open VIVIM again."
    }
    $version = & $node --version 2>$null
    if ($LASTEXITCODE -ne 0 -or "$version" -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22) {
        if (-not $DryRun) { try { Start-Process $nodeDownload } catch { } }
        throw "VIVIM needs Node.js 22 or newer (found $version). Update it from $nodeDownload, then open VIVIM again."
    }
    Say "VIVIM - Node.js $version is ready."
    if (-not (Test-Path -LiteralPath $cli) -or -not (Test-Path -LiteralPath $helper)) {
        throw 'Some VIVIM files are missing. Keep the scripts\windows folder inside your VIVIM folder, then try again.'
    }

    $DataDir = [IO.Path]::GetFullPath($DataDir)
    # Children (launch, serve) read the data folder from the environment; no --data-dir argument.
    $env:CAPTURE_STUDIO_HOME = $DataDir
    $profileDir = Join-Path $DataDir 'chrome-profile'
    $lockFile = Join-Path $DataDir "locks\cdp-$cdpPort.json"
    $stateFile = Join-Path $DataDir 'logs\vivim-launcher.json'
    $studioLog = Join-Path $DataDir 'logs\vivim-studio.log'

    if ($Stop) { Stop-Studio; exit 0 }

    # 1. Reuse a running VIVIM; wait for a live owner instead of starting a competing controller.
    $found = Find-Studio
    if (-not $found.Port -and $found.Owner -and -not $DryRun) {
        Say 'VIVIM is still starting. Waiting for it...'
        $deadline = [DateTime]::UtcNow.AddSeconds(30)
        while (-not $found.Port -and [DateTime]::UtcNow -lt $deadline -and (Test-Alive $found.Owner.pid)) {
            Start-Sleep -Milliseconds 500
            $found = Find-Studio
        }
    }
    if ($found.Port) {
        Say "VIVIM is already running. Reusing it; nothing new is started."
        Open-World $found
        if ($LanPair) {
            $pairing = $null
            $state = Read-Json $stateFile
            $owner = Get-Owner
            if ($state -and $owner -and [int]$state.pid -eq [int]$owner.pid -and $state.lanPair) { $pairing = Get-PairingUrl (Get-LaunchedLog) }
            if ($pairing) { Show-PhoneLink $pairing; Wait-Exit }
            else { Say 'No phone link is available from this launcher. Check the original VIVIM window for its link, or use "Stop VIVIM", then open "VIVIM phone pairing" again.' }
        }
        exit 0
    }
    if ($found.Owner) {
        if ($DryRun) { Preview "Would wait for the existing Studio on port $($found.Owner.studioPort), then open World. No second Studio or browser would start."; exit 0 }
        throw "VIVIM already owns the browser but is not ready. Check its window or log, or use Stop VIVIM before trying again. No second Studio or browser was started."
    }
    if ($found.Blocked.Count) {
        throw "Another app is using a VIVIM port ($($found.Blocked -join ', ')) and it is not VIVIM. Close that app, or start VIVIM with -StudioPort and a free port. Nothing was started."
    }

    # 2. The dedicated browser: reuse it when verified, otherwise open it with the same profile.
    if ($DryRun) {
        if (Test-Port $cdpPort) {
            & $node $helper verify $profileDir $cdpPort
            if ($LASTEXITCODE -ne 0) { throw 'Your browsers were left untouched. Check that VIVIM uses the same data folder as before (-DataDir). Never delete the VIVIM browser profile.' }
        } else { Preview "Would open the dedicated VIVIM browser: node bin\studio.mjs launch --port $cdpPort (profile $profileDir)" }
    } else {
        Say 'Opening the dedicated VIVIM browser...'
        Push-Location -LiteralPath $repo
        # Native launch can refuse when a second click won the owner lock after discovery.
        # Capture stderr without PowerShell 5.1 turning a native diagnostic into a terminating error.
        $savedPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            $launchOutput = @(& $node $cli launch --port $cdpPort 2>&1)
            $launched = $LASTEXITCODE -eq 0
        } finally { $ErrorActionPreference = $savedPreference; Pop-Location }
        $launchText = ($launchOutput | ForEach-Object { "$_" }) -join "`n"
        if ($launchText) { Say $launchText }
        if (-not $launched -and $launchText -match 'already running at http://127\.0\.0\.1:(\d+)') {
            $until = [DateTime]::UtcNow.AddSeconds(30)
            do {
                $found = Find-Studio
                if ($found.Port) { Say 'VIVIM was already running. Reusing it.'; Open-World $found; exit 0 }
                Start-Sleep -Milliseconds 500
            } while ([DateTime]::UtcNow -lt $until)
            throw 'The existing VIVIM is still starting. Open VIVIM again shortly. No second Studio was started.'
        }
        if (-not $launched) {
            throw 'The dedicated VIVIM browser could not open (see the message above). Your browsers and sign-ins were left untouched; check -DataDir if you used another data folder before.'
        }
    }

    # 3. Studio, hidden in the background so it survives this window.
    # Each attempt gets its own log: a racing second click must not truncate the owner's log.
    $studioLog = Join-Path $DataDir ("logs\vivim-studio-{0}.log" -f [Guid]::NewGuid().ToString('N'))
    $spawnArgs = @('spawn', $cli, "$cdpPort", "$StudioPort", $studioLog)
    $token = $env:CAPTURE_STUDIO_TOKEN
    if ($LanPair) {
        # Phone pairing uses the code stored in this data folder, so a restart keeps phones paired.
        # Only an explicit CAPTURE_STUDIO_TOKEN overrides it; the link is read back from the log.
        $spawnArgs += 'lan'
    }
    if ($DryRun) {
        $mode = ''
        if ($LanPair) { $mode = ' with phone pairing' }
        Preview "Would start VIVIM Studio in the background$mode on port $StudioPort (data folder $DataDir, log $studioLog)."
        Open-World ([pscustomobject]@{ Port = $StudioPort; Token = $null })
        if ($LanPair) { Preview 'Would show the phone link and QR code, and copy the link to the clipboard.' }
        Say 'To stop VIVIM later: use the "Stop VIVIM" shortcut (or .\VIVIM.ps1 -Stop).'
        exit 0
    }

    # Re-check: a second double-click may have started VIVIM while the browser opened.
    $found = Find-Studio
    if ($found.Port) { Open-World $found; exit 0 }
    if ($found.Owner -or $found.Blocked.Count) { throw 'VIVIM or another app started while the browser opened. Open VIVIM again to reuse it; no second Studio was started.' }

    $savedToken = $env:CAPTURE_STUDIO_TOKEN
    if ($token) { $env:CAPTURE_STUDIO_TOKEN = $token }
    try { $spawned = (& $node $helper @spawnArgs) | ConvertFrom-Json }
    finally { if ($savedToken) { $env:CAPTURE_STUDIO_TOKEN = $savedToken } else { Remove-Item Env:\CAPTURE_STUDIO_TOKEN -ErrorAction SilentlyContinue } }
    if ($LASTEXITCODE -ne 0 -or -not $spawned.pid) { throw 'VIVIM could not start. Try again; if it keeps failing, run "node bin\studio.mjs doctor".' }
    Say 'Starting VIVIM in the background...'
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    while ([DateTime]::UtcNow -lt $deadline) {
        $probe = Get-Health $StudioPort $token
        if ($probe.State -eq 'ok') {
            $owner = Get-Owner
            if (-not $owner -or $owner.pid -ne $spawned.pid) {
                $found = Find-Studio
                if ($found.Port) { Say 'VIVIM was already running. Reusing it.'; Open-World $found; exit 0 }
                throw 'Another VIVIM answered while starting. Open VIVIM again to reuse its owner.'
            }
            $process = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$spawned.pid)"
            [IO.File]::WriteAllText($stateFile, (@{ pid = $spawned.pid; studioPort = $StudioPort; lanPair = [bool]$LanPair; logFile = $studioLog; processCreatedTicks = $process.CreationDate.ToUniversalTime().Ticks.ToString() } | ConvertTo-Json))
            Open-World ([pscustomobject]@{ Port = $StudioPort; Token = $token })
            if ($LanPair) {
                $pairing = $null
                $until = [DateTime]::UtcNow.AddSeconds(5)
                while (-not $pairing -and [DateTime]::UtcNow -lt $until) { $pairing = Get-PairingUrl (Get-LaunchedLog); if (-not $pairing) { Start-Sleep -Milliseconds 250 } }
                if ($pairing) { Show-PhoneLink $pairing } else { Say "Phone pairing is on, but the link was not found. It is in $studioLog." }
            }
            Say 'VIVIM keeps running after you close this window. To stop it, use the "Stop VIVIM" shortcut.'
            if ($LanPair) { Wait-Exit }
            exit 0
        }
        if (-not (Test-Alive $spawned.pid)) {
            $log = try { [IO.File]::ReadAllText($studioLog) } catch { '' }
            # The CDP owner lock refused a second Studio: reuse the owner instead of failing.
            $owned = [regex]::Match($log, 'already running at http://127\.0\.0\.1:(\d+)')
            if ($owned.Success) {
                Say 'VIVIM was already running. Reusing it.'
                $until = [DateTime]::UtcNow.AddSeconds(30)
                do {
                    $found = Find-Studio
                    if ($found.Port) { break }
                    Start-Sleep -Milliseconds 500
                } while ([DateTime]::UtcNow -lt $until)
                if (-not $found.Port) { throw 'The existing VIVIM is not ready yet. Open VIVIM again shortly; no duplicate was started.' }
                Open-World $found
                exit 0
            }
            $tail = (($log -split "`r?`n") | Where-Object { $_ -match '\S' } | Select-Object -Last 4) -join "`n"
            if ($log -match 'LAN pairing|no non-loopback IPv4') { throw "Phone pairing needs WiFi or a network connection. Connect, or open VIVIM without phone pairing.`n$tail" }
            throw "VIVIM stopped while starting. Details:`n$tail`nFull log: $studioLog"
        }
        Start-Sleep -Milliseconds 500
    }
    throw "VIVIM is taking longer than usual to start. It keeps starting in the background; open VIVIM again in a minute. Progress: $studioLog"
} catch {
    Write-Host ''
    Write-Host "VIVIM needs your attention: $($_.Exception.Message)" -ForegroundColor Yellow
    exit 1
}
