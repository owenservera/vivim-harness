@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0VIVIM.ps1" %*
if errorlevel 1 (
  echo.
  echo VIVIM could not open. Read the next step above, then try again.
  pause
  exit /b 1
)
