# Tailchat

A messenger for your Tailscale tailnet, with end-to-end
encrypted chats, file sharing, status updates and calls.

Everything is in [`tailchat/`](tailchat/): start with
[tailchat/README.md](tailchat/README.md) for running it on Docker, and
[tailchat/PROTOCOL.md](tailchat/PROTOCOL.md) for how the encryption works.

## Setup

Tailchat runs on Docker. On the computer that will host it:

1. Install [Docker](https://docs.docker.com/get-docker/) (Docker Desktop on
   Windows and macOS).
2. In the [Tailscale admin console](https://login.tailscale.com/admin/dns),
   turn on **MagicDNS** and **HTTPS certificates**, then create a one-off,
   pre-approved auth key under **Settings > Keys**.
3. Get the code (green **Code** button > **Download ZIP**, or `git clone`),
   then start it:

   ```sh
   cd tailchat
   echo "TS_AUTHKEY=tskey-auth-..." > .env
   docker compose up -d --build
   ```

4. Open `https://tailchat.<your-tailnet>.ts.net` on any device signed in to
   your tailnet, including phones.

The full guide, with settings and hardening, is in
[tailchat/README.md](tailchat/README.md).
