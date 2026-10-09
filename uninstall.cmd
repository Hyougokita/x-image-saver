@echo off
setlocal
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0native\Uninstall.ps1"
if errorlevel 1 echo Uninstallation failed. See the message above.
pause
