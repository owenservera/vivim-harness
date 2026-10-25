<#
.SYNOPSIS
  Install / remove / inspect the Capture Studio "always-on" scheduled task.

.DESCRIPTION
  Registers a per-user Scheduled Task named "CaptureStudio-AlwaysOn" that runs
  the always-on supervisor (scripts\always-on.mjs) at logon, hidden, with an
  unlimited execution time limit and automatic restarts.

  No administrator rights are required: the task runs in the current user's
  context (Interactive logon type, LeastPrivilege run level).

  This script never edits any file and never touches Chrome.

.PARAMETER Install
  Register (or replace) the scheduled task. This is the default action when no
  switch is given.

.PARAMETER Remove
  Unregister the scheduled task. No error if it does not exist.

.PARAMETER Status
  Show the task state, last run time and last result, and run
  "node scripts\always-on.mjs --status".

.PARAMETER Start
  Start the scheduled task now, then show the status.

.PARAMETER Stop
  Run "node scripts\always-on.mjs --stop", then stop the scheduled task.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Status
#>
[CmdletBinding()]
param(
  [switch]$Install,
  [switch]$Remove,
  [switch]$Status,
  [string]$ChromeProfile = (Join-Path $env:LOCALAPPDATA 'chrome-cdp-profile'),
  [switch]$Start,
  [switch]$Stop
)

$ErrorActionPreference = 'Stop'

$TaskName  = 'CaptureStudio-AlwaysOn'
$TaskPath  = '\'
$Root      = Split-Path -Parent $PSScriptRoot          # capture-studio root
$Script    = Join-Path $Root 'scripts\always-on.mjs'   # supervisor entry point

function Resolve-Node {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) {
    throw "node.exe was not found on PATH. Install Node.js (18 or newer) or add node.exe to PATH, then run this script again."
  }
  return $cmd.Source
}

function Get-AlwaysOnTask {
  try {
    return Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction Stop
  } catch {
    return $null
  }
}

function Get-TaskInfo {
  try {
    return Get-ScheduledTaskInfo -TaskName $TaskName -TaskPath $TaskPath -ErrorAction Stop
  } catch {
    return $null
  }
}

function Show-TaskStatus {
  Write-Host "Scheduled task : $TaskName"
  $task = Get-AlwaysOnTask
  if (-not $task) {
    Write-Host "  Installed    : no"
    Write-Host "  State        : (not registered)"
    return
  }
  Write-Host "  Installed    : yes"
  Write-Host "  State        : $($task.State)"
  $info = Get-TaskInfo
  if ($info) {
    Write-Host "  Last run     : $($info.LastRunTime)"
    Write-Host "  Last result  : $($info.LastTaskResult)"
    Write-Host "  Next run     : $($info.NextRunTime)"
  }
}

function Invoke-Supervisor {
  param([string[]]$SupervisorArgs)
  $node = Resolve-Node
  if (-not (Test-Path -LiteralPath $Script)) {
    Write-Host "Supervisor script not found: $Script"
    return
  }
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $out = ''
  try {
    $out = & $node $Script @SupervisorArgs 2>&1 | Out-String
  } catch {
    $out = $_.Exception.Message
  } finally {
    $ErrorActionPreference = $prev
  }
  if ($out) { Write-Host ($out.TrimEnd()) }
  if ($LASTEXITCODE -ne 0) { Write-Host "(exit code $LASTEXITCODE)" }
}

function Install-Task {
  $node = Resolve-Node
  if (-not (Test-Path -LiteralPath $Script)) {
    Write-Host "Warning: supervisor script not found yet: $Script"
    Write-Host "         The task will be registered anyway and will start working once the script exists."
  }
  $user = if ($env:USERDOMAIN) { "$env:USERDOMAIN\$env:USERNAME" } else { $env:USERNAME }

  # Always pass the Chrome profile used for capture, so the supervisor can relaunch the
  # owner's real browser with the DevTools port after Chrome is closed (--ensure-chrome).
  $argParts = @(('"{0}"' -f $Script), '--chrome-profile', ('"{0}"' -f $ChromeProfile))
  $argLine  = ($argParts -join ' ')
  $action = New-ScheduledTaskAction -Execute $node -Argument $argLine -WorkingDirectory $Root
  try {
    $action.Hidden = $true
  } catch {
    Write-Host "Note: this Windows version did not accept the hidden-window flag for the task action."
  }

  $trigger  = New-ScheduledTaskTrigger -AtLogOn -User $user
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet `
      -AllowStartIfOnBatteries `
      -DontStopIfGoingOnBatteries `
      -DontStopOnIdleEnd `
      -StartWhenAvailable `
      -MultipleInstances IgnoreNew `
      -RestartCount 999 `
      -RestartInterval (New-TimeSpan -Minutes 1) `
      -ExecutionTimeLimit ([TimeSpan]::Zero)

  Register-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -Action $action -Trigger $trigger `
      -Principal $principal -Settings $settings `
      -Description 'Capture Studio always-on supervisor (logs to the capture-studio data dir).' `
      -Force | Out-Null

  Write-Host "Registered scheduled task '$TaskName' for user $user."
  Write-Host "  Command      : `"$node`" $argLine"
  Write-Host "  Working dir  : $Root"
  Write-Host "  Hidden       : yes"
  Write-Host "  Time limit   : unlimited"
  Write-Host "  Restart      : 999 times, every 1 minute"
  Show-TaskStatus
}

function Remove-Task {
  if (Get-AlwaysOnTask) {
    Unregister-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -Confirm:$false
    Write-Host "Removed scheduled task '$TaskName'."
  } else {
    Write-Host "Scheduled task '$TaskName' is not installed; nothing to remove."
  }
}

function Start-Task {
  if (-not (Get-AlwaysOnTask)) {
    Write-Host "Scheduled task '$TaskName' is not installed. Run this script with -Install first."
    return
  }
  Start-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath
  Write-Host "Started scheduled task '$TaskName'."
  Start-Sleep -Seconds 2
  Show-TaskStatus
  Write-Host "--- node scripts\always-on.mjs --status ---"
  Invoke-Supervisor -SupervisorArgs @('--status')
}

function Stop-Task {
  Write-Host "--- node scripts\always-on.mjs --stop ---"
  Invoke-Supervisor -SupervisorArgs @('--stop')
  if (Get-AlwaysOnTask) {
    Stop-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath
    Write-Host "Stopped scheduled task '$TaskName'."
  } else {
    Write-Host "Scheduled task '$TaskName' is not installed."
  }
}

try {
  if ($Remove)        { Remove-Task }
  elseif ($Status)    { Show-TaskStatus; Write-Host "--- node scripts\always-on.mjs --status ---"; Invoke-Supervisor -SupervisorArgs @('--status') }
  elseif ($Start)     { Start-Task }
  elseif ($Stop)      { Stop-Task }
  else                { Install-Task }   # -Install or no switch
} catch {
  Write-Host "ERROR: $($_.Exception.Message)"
  exit 1
}
