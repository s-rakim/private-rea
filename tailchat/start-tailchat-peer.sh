#!/bin/sh
# Tailchat device to device (Linux and macOS): send messages straight to your
# other devices over Tailscale. Needs Python 3.10+ and Tailscale, signed in.
exec python3 "$(dirname "$0")/peer/tailchat_peer.py"
