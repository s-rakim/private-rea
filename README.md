# Tailchat

A messenger for your Tailscale tailnet, with end-to-end
encrypted chats, file sharing, status updates and calls.

Everything is in [`tailchat/`](tailchat/): start with
[tailchat/README.md](tailchat/README.md) for running it on Docker, and
[tailchat/PROTOCOL.md](tailchat/PROTOCOL.md) for how the encryption works.

## Setup: messages device to device, no Docker

Messages go straight from one of your devices to another over Tailscale, the
way Taildrop sends files. There is no server and no Docker. Tailscale encrypts
everything between devices end to end, and nothing is stored anywhere but on
the two devices.

Do this on every computer you want to chat from (Windows, macOS or Linux):

1. **Install Tailscale** from <https://tailscale.com/download>, open it and
   sign in. Use the same tailnet on every device. Check it says *Connected*.
2. **Install Python 3.10 or newer** from <https://www.python.org/downloads/>.
   On Windows, tick **Add python.exe to PATH** in the installer.
3. **Get the code**: download this repository (green **Code** button >
   **Download ZIP**, then unzip it) or `git clone` it.
4. **Start Tailchat**:
   * Windows: open the `tailchat` folder and double-click
     `start-tailchat-peer.cmd`.
   * macOS and Linux: run `tailchat/start-tailchat-peer.sh` in a terminal.
5. **Allow it through the firewall** if Windows asks. Tailchat only listens on
   the device's Tailscale address, so nothing outside your tailnet can reach it.
6. Your chats open in the browser (`http://127.0.0.1:8765`, with a key in the
   link). Your other tailnet devices are listed on the left; a green dot means
   online. Pick one and type.

Keep the Tailchat window open on each device to send and receive. A message to
a device that is off or not running Tailchat shows 🕓 and is sent once that
device is back; ✓ means it arrived. Chats are kept in `tailchat/peer/data/`.

If your tailnet has its own access rules, allow your devices to reach each
other on TCP port 8766.

Phones can't run this yet. For phones and browsers on other devices, run the
full Tailchat server instead: double-click `tailchat/start-tailchat.cmd` on one
computer (see "Without Docker" in [tailchat/README.md](tailchat/README.md)).
