#!/bin/sh
# Start Tailchat on this machine without Docker (Linux and macOS).
# Needs Python 3.10+ and Tailscale, signed in.
set -e
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
  echo "Setting up Tailchat the first time..."
  python3 -m venv .venv
fi
.venv/bin/python -m pip install --quiet --disable-pip-version-check -r requirements.txt
exec .venv/bin/python -m tailchat_server --tailscale
