@echo off
rem Tailchat device to device: send messages straight to your other devices
rem over Tailscale. Double-click it, or run it from PowerShell. Needs Python 3.10+
rem (python.org) and the Tailscale app, signed in. Keep the window open.
setlocal
cd /d "%~dp0peer"
set PY=python
where py >nul 2>nul && set PY=py -3
%PY% tailchat_peer.py
if errorlevel 1 pause
