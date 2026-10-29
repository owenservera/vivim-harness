@echo off
rem Double-click to open VIVIM. Extra options pass through, e.g.  VIVIM.cmd -LanPair  or  -DryRun
setlocal
set "VIVIM_PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%VIVIM_PS%" set "VIVIM_PS=powershell.exe"
"%VIVIM_PS%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0VIVIM.ps1" %*
if errorlevel 1 (
  echo.
  echo VIVIM could not open. Read the message above, then try again.
  pause
  exit /b 1
)
exit /b 0
