@echo off
rem Double-click to stop VIVIM. The VIVIM browser and your sign-ins stay.
setlocal
set "VIVIM_PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%VIVIM_PS%" set "VIVIM_PS=powershell.exe"
"%VIVIM_PS%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0VIVIM.ps1" -Stop %*
set "VIVIM_RESULT=%ERRORLEVEL%"
echo.
pause
exit /b %VIVIM_RESULT%
