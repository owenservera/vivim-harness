# Create VIVIM shortcuts for this Windows user (no administrator access needed).
#   Desktop:     VIVIM
#   Start Menu:  VIVIM, VIVIM phone pairing, Stop VIVIM
# Running it again refreshes them. Keep the VIVIM folder where it is afterwards.
# ASCII-only on purpose (Windows PowerShell 5.1 reads BOM-less files as ANSI).
[CmdletBinding()]
param([switch]$DryRun)
$ErrorActionPreference = 'Stop'
try {
    $launcher = Join-Path $PSScriptRoot 'VIVIM.cmd'
    $stopper = Join-Path $PSScriptRoot 'Stop-VIVIM.cmd'
    foreach ($file in @($launcher, $stopper, (Join-Path $PSScriptRoot 'VIVIM.ps1'), (Join-Path $PSScriptRoot 'launcher-helper.mjs'))) {
        if (-not (Test-Path -LiteralPath $file)) { throw "$(Split-Path -Leaf $file) is missing. Keep this installer in scripts\windows inside your VIVIM folder." }
    }
    $repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
    $desktop = [Environment]::GetFolderPath('DesktopDirectory')
    $programs = [Environment]::GetFolderPath('Programs')
    $items = @(
        @{ Path = (Join-Path $desktop 'VIVIM.lnk'); Target = $launcher; Arguments = ''; Description = 'Open your local VIVIM World' },
        @{ Path = (Join-Path $programs 'VIVIM.lnk'); Target = $launcher; Arguments = ''; Description = 'Open your local VIVIM World' },
        @{ Path = (Join-Path $programs 'VIVIM phone pairing.lnk'); Target = $launcher; Arguments = '-LanPair'; Description = 'Open VIVIM and show a link for your phone on the same WiFi' },
        @{ Path = (Join-Path $programs 'Stop VIVIM.lnk'); Target = $stopper; Arguments = ''; Description = 'Stop VIVIM (the VIVIM browser and sign-ins stay)' }
    )
    if (-not $DryRun) {
        # Downloaded files carry a "from the internet" mark that makes Windows ask every time.
        Get-ChildItem -LiteralPath $PSScriptRoot -File | Unblock-File -ErrorAction SilentlyContinue
    }
    $shell = $null
    foreach ($item in $items) {
        $preview = "$($item.Path) -> $($item.Target) $($item.Arguments)".TrimEnd()
        if ($DryRun) { Write-Host "[Preview] Would create shortcut: $preview" -ForegroundColor Cyan; continue }
        if (-not $shell) { $shell = New-Object -ComObject WScript.Shell }
        $shortcut = $shell.CreateShortcut($item.Path)
        $shortcut.TargetPath = $item.Target
        $shortcut.Arguments = $item.Arguments
        $shortcut.WorkingDirectory = $repo
        $shortcut.Description = $item.Description
        $shortcut.Save()
        Write-Host "Created: $($item.Path)"
    }
    if ($DryRun) { Write-Host 'Preview only: no shortcuts were created.' }
    else { Write-Host 'VIVIM shortcuts are ready. Keep your VIVIM folder in its current location.' }
} catch {
    Write-Host "Could not create shortcuts: $($_.Exception.Message)" -ForegroundColor Yellow
    exit 1
}
