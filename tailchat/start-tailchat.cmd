@echo off
rem Start Tailchat on this PC without Docker. Double-click it, or run it from
rem PowerShell. Needs Python 3.10+ (python.org) and the Tailscale app, signed in.
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo Setting up Tailchat the first time...
  where py >nul 2>nul && (py -3 -m venv .venv) || (python -m venv .venv)
  if not exist ".venv\Scripts\python.exe" (
    echo Python 3 was not found. Install it from https://www.python.org/downloads/ and run this again.
    pause
    exit /b 1
  )
)
".venv\Scripts\python.exe" -m pip install --quiet --disable-pip-version-check -r requirements.txt || (pause & exit /b 1)
".venv\Scripts\python.exe" -m tailchat_server --tailscale
if errorlevel 1 pause
