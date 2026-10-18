# Tailchat

A WhatsApp-style messenger that runs on your own server and is only reachable
from your [Tailscale](https://tailscale.com) tailnet. Messages, files, voice
notes, status updates and calls are end-to-end encrypted, and Tailscale tells
the server who everyone is, so there are no phone numbers or passwords.

The server is Python (aiohttp and SQLite). The main client is the browser app
in `public/`, and `clients/` has command-line clients, a file-drop tool, a bot
framework and a tailnet gateway in other languages.

## Run it with Docker

The compose file runs two containers. A Tailscale container joins your tailnet
as its own machine and serves `https://tailchat.<your-tailnet>.ts.net` with a
real certificate. The Tailchat container shares its network, so `tailscale
serve` reaches it on `127.0.0.1` and tells it who each visitor is. Nothing is
published on the Docker host, and Funnel stays off.

1. In the [Tailscale admin console](https://login.tailscale.com/admin/dns),
   turn on **MagicDNS** and **HTTPS certificates**.
2. Create an auth key under **Settings > Keys**. Make it one-off (not
   reusable) and pre-approved, and give it a tag such as `tag:tailchat` if
   your tailnet uses tags.
3. Start it:

   ```sh
   cd tailchat
   echo "TS_AUTHKEY=tskey-auth-..." > .env
   docker compose up -d --build
   ```

4. Open `https://tailchat.<your-tailnet>.ts.net` on any device signed in to your
   tailnet. Each person's Tailscale login becomes their account the first time
   they visit.
5. Delete the key from `.env`. The node keeps its identity in the
   `tailscale-state` volume and doesn't need the key again.

Messages and files live in the `tailchat-data` volume and the node's identity
in `tailscale-state`. Set `TAILCHAT_HOSTNAME` in `.env` to use a machine name
other than `tailchat`, and `TAILCHAT_MAX_UPLOAD_MB` to change the 2 GB file
limit. To update, pull the new code and run `docker compose up -d --build`
again.

Both containers run with a read-only root filesystem, no Linux capabilities
and `no-new-privileges`, and the Tailchat one as an unprivileged user.
Tailscale uses userspace networking, so it needs no tun device and nothing
but `tailscale serve` is reachable on the node.

To harden it further:

* Limit who can reach the node with [Tailscale access
  rules](https://tailscale.com/kb/1018/acls): for example, allow your users
  only port 443 on `tag:tailchat`.
* Pin the images to digests (`image: tailscale/tailscale@sha256:…`) so an
  update only happens when you choose it.

### Without Docker

For text messages sent device to device with no server at all, see the setup
steps in the [main README](../README.md). The full app can also run as an ordinary program on a computer that has the
Tailscale app installed and signed in, such as your own PC. Turn on **MagicDNS**
and **HTTPS certificates** in the [admin
console](https://login.tailscale.com/admin/dns) first, and install
[Python](https://www.python.org/downloads/) 3.10 or newer.

* **Windows**: double-click `start-tailchat.cmd`, or run `.\start-tailchat.cmd`
  in PowerShell.
* **Linux and macOS**: run `./start-tailchat.sh`.

The first run sets up Python packages in `.venv`. It then checks that Tailscale
is connected, runs `tailscale serve` for you and prints the address to open,
`https://<this-computer>.<your-tailnet>.ts.net`. Leave the window open while
you use Tailchat; closing it or pressing Ctrl+C stops the server and turns
`tailscale serve` off again. Messages and files are kept in `data/`. The first
time, Tailscale may print a link to allow Serve on your tailnet; open it,
approve, and the start carries on.

Without Docker, any program on the same computer could connect to the server
on `127.0.0.1` and claim to be anyone. To stop that, the start script makes a
random secret (kept in `data/serve-secret`) and has `tailscale serve` add it to
the front of every request's path. The server answers nothing else, and it
never reaches a browser. Someone who can run `tailscale serve status` or read
your files on that computer could still find it, so run Tailchat under an
account no one else uses.

To run the steps yourself, use `python -m tailchat_server --tailscale`, or set
`TAILCHAT_SERVE_SECRET` and point `tailscale serve --bg --https=443` at
`http://127.0.0.1:8443/<secret>` (never use `tailscale funnel`). If you'd
rather not install the Tailscale app, the Go gateway in `clients/go` joins the
tailnet by itself (tsnet) and does the same job as `tailscale serve`.

| Setting | Default | Meaning |
|---|---|---|
| `TAILCHAT_AUTH` | `serve` | `serve` (behind `tailscale serve`), `direct` (listen on the Tailscale IP and ask tailscaled who connects; needs `TAILCHAT_TLS_CERT`/`_KEY` from `tailscale cert`), or `dev` (local testing, loopback only) |
| `TAILCHAT_HOST`, `TAILCHAT_PORT` | `127.0.0.1`, `8443` | where the server listens |
| `TAILCHAT_SERVE_SECRET` | | `serve` mode only: answer only paths that start with `/<secret>/`, which `tailscale serve` adds (the start scripts set this) |
| `TAILCHAT_ALLOWED_HOSTS` | | extra host names people may use to reach it; `*.ts.net`, tailnet addresses and `localhost` always work |
| `TAILCHAT_DATA` | `./data` | database and encrypted files |
| `TAILCHAT_MAX_UPLOAD_MB` | `2048` | largest file |
| `TAILCHAT_STATUS_HOURS` | `24` | how long status updates last |
| `TAILCHAT_EDIT_WINDOW_S`, `TAILCHAT_DELETE_WINDOW_S` | 15 minutes, 2 days | edit and "delete for everyone" windows |

## Adding people and devices

Tailchat only answers inside your tailnet, so everyone you chat with needs
Tailscale. People show up under **New chat** once they have opened Tailchat;
**New chat > Invite people to Tailchat** walks through this in the app.

* **Someone outside your tailnet**: in the [admin
  console](https://login.tailscale.com/admin/machines), open the Tailchat
  machine's ⋯ menu and choose **Share**, then send them the link. They install
  Tailscale (free), accept the share and open your Tailchat address. They can
  reach that one machine and nothing else on your tailnet, but inside Tailchat
  they are a user like anyone else: they see everyone's names, photos and
  status updates and can message anyone. Only a Tailscale admin can share the
  machine. If your tailnet has its own access rules, let `autogroup:shared`
  reach port 443 on the Tailchat machine. To add someone to your whole tailnet
  instead, use **Users > Invite users**.
* **Your own devices** are one account, since they are all signed in as you.
  Each other device you have opened Tailchat on gets its own chat, for sending
  a message or file to just that device; **Message yourself** reaches all of
  them. Rename devices under **Linked devices** so the chats are easy to tell
  apart.
* **Another device of yours, anywhere in the world**: install Tailscale on it,
  sign in with the same account and open the Tailchat address. Tailscale
  connects it over the internet from any country, with nothing to set up on
  your router. The new device then asks your other devices for your chat
  history: on one of them tap **Review and share**, after checking that the
  code it shows matches the one on the new device.

## What's in it

* **Chats**: one-to-one chats, groups of up to 1024 people, message yourself,
  broadcast lists, drafts, pinned, archived, muted and unread chats, filters
  and search across chats, contacts and messages.
* **Messages**: replies, forwarding ("Forwarded many times"), edits, delete for
  me or everyone, reactions, stars, pinned messages, @mentions, polls,
  locations, contacts, voice notes with waveforms, photos, videos, documents up
  to 2 GB, view once, disappearing messages, blue ticks, message info,
  typing and recording indicators, and export chat (a text file, or a zip
  with the media).
* **Groups**: admins, "only admins send" and "only admins edit info", invite
  links, descriptions and photos.
* **Communities**: related groups under one community with an announcements
  group. Members join the groups they want; admins add new or existing
  groups.
* **Channels**: one-way broadcasts anyone on your tailnet can find and follow.
  Followers react and vote but can't post or see each other.
* **Status**: text, photo and video updates that disappear after 24 hours,
  with a viewer list and replies.
* **Calls**: voice and video, one-to-one and groups of up to 8, with a call log.
* **Privacy and devices**: last seen, read receipts, blocking, security codes
  to compare in person, linked devices you can rename or log out remotely, a
  chat with each of your other devices, and chat history sent end-to-end
  encrypted to a device you link later.
* **Settings**: profile name, about and photo, light and dark themes, enter is
  send, desktop notifications.

Not included: payments, business tools, live location and a sticker store.

## Security

Each device (browser or client) makes its own P-256 key pair and keeps the
private key to itself. A message is sealed with a fresh AES-256-GCM key, which
is wrapped for every device of every member. Files are encrypted in 1 MiB
chunks before upload. Call setup is sealed the same way, so the server can't
put itself in the middle of a call. The full design is in
[PROTOCOL.md](PROTOCOL.md).

Every device key the app sees is pinned to its owner. When someone you talk to
links a new device, their chats with you say their security code changed, and
a new device on your own account gets a warning banner, so a device added
behind your back doesn't go unnoticed.

What the server can see: who is in which chat, when messages are sent and
how big they are, reactions, poll vote positions, receipts, profile names and
photos, and who called whom. It can't read messages, files, status updates or
call audio and video. Calls go device to device over WebRTC inside your
tailnet.

Things to know:

* **Channel posts aren't end-to-end encrypted**, the same as WhatsApp
  channels: anyone can follow, so the server stores posts as they are. The app
  says so in every channel.
* The web app's code comes from your server. Someone who controls the server
  could serve a modified app, as with any web-based messenger. Comparing
  security codes catches swapped keys, and the command-line clients don't
  depend on the server for their code.
* Keys are long-lived device keys, so there is no forward secrecy: someone who
  steals a device's private key and has kept copies of the server's data can
  read what was sent to that device. Log out lost devices from **Linked
  devices**.
* In a group, a member working together with whoever runs the server could
  make a message look like it came from another member. Messages aren't
  signed, which is a trade-off for keeping one shared key per message.
* Someone who runs the server could hold back messages, replay an old status
  or roll back an edit. They can't read or change what's inside.
* Status updates go to everyone who uses your Tailchat, including people you
  shared it with, like
  WhatsApp's "My contacts" setting.
* Broadcast lists are saved in the browser that made them.
* A device linked after a message was sent can't read it until another of
  your devices shares your chat history with it, which you approve on that
  other device after comparing codes. That device re-encrypts each message's
  key for the new one; the server stores those keys and still can't read
  anything. The device that shares vouches for who sent each message, so only
  approve devices you linked yourself. The codes are worked out from the keys
  each device actually uses, so a server that swaps a key makes them differ.
  Logging out the old device afterwards keeps the history on the new one.
* **Export chat** writes an ordinary, unencrypted file. Anyone you give it to
  can read it.

## Clients

All of them implement [PROTOCOL.md](PROTOCOL.md) and interoperate with the web
app. They handle direct chats and groups, including groups inside
communities. Channels and community management are in the web app.

| Folder | What it is |
|---|---|
| `clients/python` | `tailchat` command line: send, receive, history, files, security codes |
| `clients/java` | Java 21 library and command line, JDK only |
| `clients/csharp` | .NET 8 library and command line |
| `clients/cpp` | C++20 streaming file transfer with flat memory use |
| `clients/go` | `tailchat-gateway` (tsnet) and a command-line client |
| `clients/rust` | `tailchat-drop`: send, receive and watch folders of files |
| `clients/ruby` | bot framework with example bots |

## Development

```sh
cd tailchat
pip install -r requirements.txt
TAILCHAT_AUTH=dev python3 -m tailchat_server   # then open http://127.0.0.1:8443/dev/login
```

Dev mode lets you pick any user name and only listens on loopback. Tests:

```sh
python3 -m unittest discover -s tests -t .     # server unit tests
npm install && npm test                        # API contract tests (Node 22+), driving the server with the web app's crypto
```

Each client folder has its own build and test instructions.

Tailchat is an independent project based on WhatsApp's publicly known
features. It contains no WhatsApp code or assets and isn't affiliated with
WhatsApp or Meta.
