# Bring the owner's Chrome window to the foreground.
#
# Why this exists: a background browser tab is `document.visibilityState === "hidden"`, and Chrome
# does not deliver synthetic key input to a hidden tab. `Page.bringToFront` cannot help, because
# it only switches tabs INSIDE the browser: if the browser window itself is not the foreground
# window, the tab stays hidden and every keystroke is silently dropped. Measured on this machine:
# with the window in the background, `Input.insertText` still wrote to the composer while
# `Input.dispatchKeyEvent` did nothing.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\focus-chrome.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\focus-chrome.ps1 -Title "chatgpt"
#
# Exit 0 when a window was focused, 1 when no Chrome window could be found.
param(
  [int]$ProcessId = 0,
  [string]$Title = ''
)

$ErrorActionPreference = 'SilentlyContinue'

if (-not ('AionWin32' -as [type])) {
  Add-Type @'
using System;
using System.Runtime.InteropServices;
public class AionWin32 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
}
'@
}

$candidates = @()
if ($ProcessId -gt 0) {
  $candidates = @(Get-Process -Id $ProcessId)
} else {
  $candidates = @(Get-Process chrome | Where-Object { $_.MainWindowHandle -ne 0 })
}

if ($Title) {
  $candidates = @($candidates | Where-Object { $_.MainWindowTitle -like "*$Title*" })
}
if (-not $candidates.Count) {
  Write-Output "focus-chrome: no Chrome window found"
  exit 1
}

$target = $candidates[0]
$hwnd = $target.MainWindowHandle

# A window that is minimized or behind others must be restored and raised before it can take
# focus. SetForegroundWindow is refused when the calling process is not foreground, so the input
# queues are attached for the call.
$SW_RESTORE = 9
[void][AionWin32]::ShowWindow($hwnd, $SW_RESTORE)
[void][AionWin32]::BringWindowToTop($hwnd)

$fg = [AionWin32]::GetForegroundWindow()
$fgThread = [uint32]0
[void][AionWin32]::GetWindowThreadProcessId($fg, [ref]$fgThread)
$curThread = [AionWin32]::GetCurrentThreadId()
[void][AionWin32]::AttachThreadInput($curThread, $fgThread, $true)
$ok = [AionWin32]::SetForegroundWindow($hwnd)
[void][AionWin32]::AttachThreadInput($curThread, $fgThread, $false)

Start-Sleep -Milliseconds 350
$now = [AionWin32]::GetForegroundWindow()
Write-Output ("focus-chrome: pid={0} focused={1} foreground={2} title='{3}'" -f $target.Id, $ok, ($now -eq $hwnd), $target.MainWindowTitle)
if ($now -ne $hwnd) { exit 1 }
exit 0
