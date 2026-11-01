# Tailchat

A messenger for your Tailscale tailnet, with end-to-end
encrypted chats, file sharing, status updates and calls.

Everything is in [`tailchat/`](tailchat/): the server, the browser app, the
Windows app (`tailchat/desktop`), the Android app (`tailchat/mobile`) and the
command-line clients. [tailchat/PROTOCOL.md](tailchat/PROTOCOL.md) explains
how the encryption works.

## Install

The [step-by-step install guide](tailchat/README.md#install) walks through
all of it:

1. Set up Tailscale and turn on MagicDNS and HTTPS certificates.
2. Install Docker on the computer that will be the server.
3. Download this repository.
4. Start the server with `docker compose up -d --build`.
5. Install the Windows app (from the **Tailchat for Windows** release).
6. Install the Android app (from the **Tailchat for Android** release).
7. Open Tailchat on any other device in a browser.
