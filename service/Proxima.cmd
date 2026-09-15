@echo off
rem The thing to click. Starts proximad if it is not already answering, then opens the
rem cockpit that proximad serves. Double-click this, or put a shortcut to it wherever
rem Proxima is expected to live.
pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0proxima.ps1" -Action ensure %*
