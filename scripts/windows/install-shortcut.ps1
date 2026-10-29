[CmdletBinding()]
param([switch]$DryRun)
$ErrorActionPreference = 'Stop'
try {
    $launcher = Join-Path $PSScriptRoot 'VIVIM.cmd'
    if (-not (Test-Path -LiteralPath $launcher)) { throw 'VIVIM.cmd is missing. Keep this installer in scripts/windows inside VIVIM.' }
    $destinations = @(
        (Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'VIVIM.lnk'),
        (Join-Path ([Environment]::GetFolderPath('Programs')) 'VIVIM.lnk')
    )
    foreach ($destination in $destinations) {
        if ($DryRun) { Write-Host "[Dry run] Would create shortcut: $destination -> $launcher"; continue }
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($destination)
        $shortcut.TargetPath = $launcher
        $shortcut.WorkingDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
        $shortcut.Description = 'Open your local VIVIM World'
        $shortcut.Save()
    }
    Write-Host 'VIVIM shortcuts are ready (or previewed). Keep your VIVIM folder in its current location.'
} catch {
    Write-Host "Could not create shortcuts: $($_.Exception.Message)" -ForegroundColor Yellow
    exit 1
}
