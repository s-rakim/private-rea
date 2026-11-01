# Tailchat

A messenger that runs on your own server and is only reachable
from your [Tailscale](https://tailscale.com) tailnet. Messages, files, voice
notes, status updates and calls are end-to-end encrypted, and Tailscale tells
the server who everyone is, so there are no phone numbers or passwords.

The server is Python (aiohttp and SQLite). The main client is the browser app
in `public/`, and `clients/` has command-line clients, a file-drop tool, a bot
framework in other languages.

## Install

Tailchat has two parts:

* **The server**: one computer that stays switched on and runs Tailchat in
  Docker. It can be a Windows PC, a Mac, a Linux box or a small cloud server.
* **The apps**: the Windows app, the Android app, or any browser, on every
  device you chat from.

[Tailscale](https://tailscale.com) connects them. Every device, including the
server, joins your private network (your *tailnet*), and Tailchat can only be
reached from inside it. Follow the steps in order the first time; after that,
adding a device is just steps 5 to 7.

### Step 1: Set up Tailscale

1. Go to [tailscale.com](https://tailscale.com) and click **Get started**.
   Sign in with a Google, Microsoft, GitHub or Apple account. This creates
   your tailnet; the account you use here is your Tailchat account too.
2. Open the [DNS page of the admin console](https://login.tailscale.com/admin/dns).
   * Under **MagicDNS**, click **Enable MagicDNS** if it isn't on already.
   * Under **HTTPS Certificates**, click **Enable HTTPS** and confirm.
   * Note your **tailnet name** at the top of the page, for example
     `tail1234.ts.net`. Your Tailchat address will be
     `https://tailchat.tail1234.ts.net`.
3. Open [Settings > Keys](https://login.tailscale.com/admin/settings/keys)
   and click **Generate auth key**. Leave **Reusable** off, turn
   **Pre-approved** on, and click **Generate key**. Copy the key (it starts
   with `tskey-auth-`) somewhere safe for a few minutes; it is only shown
   once. If your tailnet uses tags, also turn on **Tags** and pick one such
   as `tag:tailchat`.

### Step 2: Install Docker on the server computer

* **Windows 10 or 11**: download [Docker
  Desktop](https://www.docker.com/products/docker-desktop/) and run the
  installer with **Use WSL 2** ticked. Restart when it asks. Open Docker
  Desktop once, accept the terms, and in **Settings > General** tick **Start
  Docker Desktop when you sign in to your computer**, so Tailchat comes back
  after a reboot. In Windows **Settings > System > Power**, set sleep to
  **Never** while plugged in, or the server goes offline when the PC sleeps.
* **macOS**: install Docker Desktop the same way and turn on starting at
  login. Keep the Mac from sleeping in **System Settings > Energy**.
* **Linux**: run `curl -fsSL https://get.docker.com | sudo sh`, then
  `sudo usermod -aG docker $USER` and log out and back in.

Check it works by opening a terminal (PowerShell on Windows) and running:

```sh
docker compose version
```

It should print a version number such as `Docker Compose version v2.x`.

### Step 3: Download Tailchat

The repository is private, so sign in to GitHub with an account that can see
it. Either:

* **Without git**: on the repository page click **Code > Download ZIP**,
  then unzip it, for example to `C:\Tailchat` or your home folder; or
* **With git**: `git clone https://github.com/s-rakim/private-rea.git`
  (Git asks you to sign in to GitHub the first time).

The server lives in the `tailchat` folder inside it.

### Step 4: Start the server

1. Open a terminal in the `tailchat` folder:

   ```powershell
   cd C:\Tailchat\private-rea\tailchat     # Windows: wherever you unzipped it
   ```

   ```sh
   cd ~/private-rea/tailchat               # macOS or Linux
   ```

2. Save your auth key from step 1 in a file called `.env` in that folder.
   Replace the example key with yours:

   ```powershell
   Set-Content -Path .env -Value "TS_AUTHKEY=tskey-auth-xxxxxxxx" -Encoding ascii   # Windows PowerShell
   ```

   ```sh
   echo "TS_AUTHKEY=tskey-auth-xxxxxxxx" > .env                                       # macOS or Linux
   ```

   On Windows, don't use `echo ... > .env` in PowerShell: it saves the file
   in an encoding Docker can't read.
3. Build and start the three containers. The first build downloads a few
   hundred megabytes and takes a few minutes:

   ```sh
   docker compose up -d --build
   ```

4. Check they are running with `docker compose ps`: `tailscale`, `tailchat`
   and `calls` should all say `running` (or `healthy`). If one keeps
   restarting, `docker compose logs tailscale` or `docker compose logs
   tailchat` says why.
5. In the [Machines page](https://login.tailscale.com/admin/machines) a new
   machine called `tailchat` appears. Open `https://tailchat.<your tailnet
   name>` in a browser on any device that is on your tailnet (Step 5 sets up
   your PC). The very first visit can take up to a minute while Tailscale gets
   the HTTPS certificate.
6. Open `.env` again and delete the key (leave the file empty or remove it).
   The machine keeps its identity in a Docker volume and doesn't need the key
   again.

The server restarts by itself when Docker starts, so it keeps running after a
reboot as long as Docker Desktop opens at sign-in.

### Step 5: Install the Windows app

1. **Install Tailscale on the PC** from
   [tailscale.com/download/windows](https://tailscale.com/download/windows).
   Click the Tailscale icon by the clock, choose **Log in**, and sign in with
   the same account as in step 1 (or the account a friend's Tailchat was
   shared with; see [Adding people and devices](#adding-people-and-devices)).
   The icon shows **Connected**. Do this on the server PC too if you chat
   from it: the server's Tailscale runs inside Docker and doesn't connect
   the PC itself.
2. **Download the app.** On the repository's **Releases** page, open the
   newest **Tailchat for Windows** release and download
   **Tailchat-Setup-<version>.exe** under *Assets*. (There is also
   **Tailchat-<version>-portable.exe**, which runs without installing, for
   example from a USB stick.)
3. **Run the installer.** The app isn't code-signed, so Windows shows
   *Windows protected your PC*. Click **More info**, then **Run anyway**.
   Choose **Only for me**, keep or change the folder, and click **Install**,
   then **Finish**. Tailchat is now in the Start menu and on the desktop.
4. **Connect.** The first time it opens, Tailchat asks for your server
   address. Type `https://tailchat.<your tailnet name>` (or just
   `tailchat.<your tailnet name>`) and click **Connect**. Your chats open,
   signed in with your Tailscale account.
5. **Turn on notifications** from the banner above the chat list, or in
   **Settings > Notifications**.

Good to know:

* Closing the window keeps Tailchat running in the system tray by the clock,
  so messages still arrive and notify you. Click the tray icon to open it
  again; right-click it and choose **Quit Tailchat** to stop it.
* The taskbar button flashes and shows a red dot when chats are unread.
* Press **Alt** to show the menu bar. **Tailchat > Change server...** points
  the app at a different address, and **Reload** (Ctrl+R) reloads it.
* Saving a file asks where to put it. Links to other websites open in your
  normal browser. **Share screen** in a call asks which screen or window to
  share.
* If the app can't reach the server it says so, with **Try again** and
  **Change server** buttons. Check that Tailscale says Connected.
* To update, download the newer installer and run it; your settings and
  chats stay. To remove it, use Windows **Settings > Apps > Installed apps >
  Tailchat > Uninstall**.

### Step 6: Install the Android app

1. **Install Tailscale** from the Play Store, open it, sign in with the same
   account, and allow the VPN connection when Android asks. Leave it switched
   on.
2. **Download the app.** On the phone, open the repository's **Releases**
   page in Chrome (sign in to GitHub), open the newest **Tailchat for
   Android** release and tap **tailchat-mobile-v<version>.apk** under
   *Assets*.
3. **Install it.** Open the downloaded file. If Android says installing from
   this source isn't allowed, tap **Settings**, turn on **Allow from this
   source** for Chrome, and go back. Tap **Install**. If Play Protect warns
   that it doesn't recognise the app, tap **More details > Install anyway**.
4. **Connect.** Open Tailchat, enter `tailchat.<your tailnet name>` (the
   `https://` is added for you) and tap **Connect**. Android asks for the
   camera and microphone the first time you start a call, and for location
   the first time you share one.

The Android app can't show notifications, because Android's in-app browser
doesn't support them. If you want notifications on the phone, use Tailchat
installed from Chrome instead (see step 7), or alongside it.

The Android app is a device of its own: when it first opens, your other
devices can share your chat history with it (see the next section). To update,
install the newer APK over the old one.

### Step 7: Other devices and people

* **A Mac, a Linux PC, or any computer without the Windows app**: install
  Tailscale, sign in, and open your Tailchat address in Chrome or Edge. To
  give it its own window and icon, in Chrome click the install icon at the
  right of the address bar (or **⋮ > Cast, save and share > Install page as
  app**); in Edge choose **⋯ > Apps > Install this site as an app**.
* **An iPhone or iPad**: install Tailscale from the App Store and sign in,
  open the address in Safari, then **Share > Add to Home Screen**.
* **An Android phone without the APK**: open the address in Chrome, then
  **⋮ > Add to Home screen > Install**.
* **Friends and family**: share the Tailchat machine with them as described
  in [Adding people and devices](#adding-people-and-devices). The Releases
  page is only visible to people with access to the repository, so send them
  the installer or APK file yourself (by email, a USB stick or a Tailchat
  message).

An app installed from a browser is the same device as that browser's tab: it
shares its key and its chats. The Windows and Android apps are devices of
their own.

### Updating the server

In the `tailchat` folder, get the new code (`git pull`, or download and unzip
a fresh ZIP over the old folder, keeping `.env`), then run:

```sh
docker compose up -d --build
```

Messages, files and the machine's identity live in Docker volumes, so they
survive updates. Don't run `docker compose down -v`: `-v` deletes them.

### Troubleshooting

* **The app or browser can't reach Tailchat**: check that Tailscale says
  Connected on that device, that the `tailchat` machine shows as online on
  the [Machines page](https://login.tailscale.com/admin/machines), and that
  `docker compose ps` on the server shows all three containers running.
* **"Server not found"**: MagicDNS is off (step 1), or the address has a typo.
  The tailnet name is on the DNS page of the admin console.
* **A certificate warning, or the first load hangs**: HTTPS certificates are
  off (step 1), or the certificate is still being issued; wait a minute and
  try again.
* **The `tailscale` container keeps restarting with an auth error**: the key
  was used, expired or mistyped. Make a new one (step 1), put it in `.env`
  and run `docker compose up -d` again.
* **Calls don't connect**: if your tailnet has its own access rules, allow
  port 3443 on the Tailchat machine as well as 443.
* **No notifications on Windows**: turn them on in Tailchat's settings, and
  check that Windows **Settings > System > Notifications** allows Tailchat.

## The server in detail

The compose file runs three containers. A Tailscale container joins your
tailnet as its own machine and serves `https://tailchat.<your-tailnet>.ts.net`
with a real certificate. The Tailchat container shares its network, so
`tailscale serve` reaches it on `127.0.0.1` and tells it who each visitor is.
The calls container runs [peer-calls](https://github.com/peer-calls/peer-calls)
for voice and video calls, served on port 3443 of the same name. Nothing is
published on the Docker host, and Funnel stays off.

Messages and files live in the `tailchat-data` volume and the node's identity
in `tailscale-state`. Set `TAILCHAT_HOSTNAME` in `.env` to use a machine name
other than `tailchat`, and `TAILCHAT_MAX_UPLOAD_MB` to change the 2 GB file
limit.

All three containers run with a read-only root filesystem, no Linux
capabilities and `no-new-privileges`, and the Tailchat and calls ones as
unprivileged users.
Tailscale uses userspace networking, so it needs no tun device and nothing
but `tailscale serve` is reachable on the node.

To list each of your machines as a chat, Tailchat asks the Tailscale
container which machines are on the tailnet and which one each visitor uses.
The two containers share tailscaled's socket through the in-memory
`tailscale-socket` volume. Because Tailchat runs as an unprivileged user,
tailscaled only lets it read that information; it can't change any Tailscale
setting. Set `TAILCHAT_TAILNET=off` in `.env` to turn the machine list off.

### Calls

Calling a chat, or one of your devices from the Calls tab, rings the other
side in Tailchat. Each device that picks up joins the call's room on
peer-calls, which opens inside the app. The first time on each device the room
asks for a name to show and which camera and microphone to use, then remembers
them. The link button above the call opens the room in its own window.

peer-calls only passes call setup between the browsers. The audio and video go
device to device over WebRTC on your tailnet addresses, and no public STUN or
TURN server is used. The room runs on its own port, so it is a separate site
from Tailchat and can't read Tailchat's keys or messages. Each call gets a
random room that only the devices that were rung know.

Set `TAILCHAT_CALLS_PORT=0` in `.env` to use the calls built into Tailchat
instead. Those seal call setup end to end, but have a simpler call screen. If
your access rules limit ports on the Tailchat node, allow 3443 as well as 443.

To harden it further:

* Limit who can reach the node with [Tailscale access
  rules](https://tailscale.com/kb/1018/acls): for example, allow your users
  only port 443 on `tag:tailchat`. The Tailchat node then only sees the
  machines allowed to reach it, so only those are listed as chats.
* Pin the images to digests (`image: tailscale/tailscale@sha256:…`) so an
  update only happens when you choose it.

### Settings

Put these in `.env` next to `docker-compose.yml`:

| Setting | Default | Meaning |
|---|---|---|
| `TS_AUTHKEY` | | auth key for the first start (see above) |
| `TAILCHAT_HOSTNAME` | `tailchat` | the node's machine name on your tailnet |
| `TAILCHAT_MAX_UPLOAD_MB` | `2048` | largest file |
| `TAILCHAT_TAILNET` | `localapi` | `off` turns the list of your machines off |
| `TS_EXTRA_ARGS` | | extra flags for `tailscale up` in the tailscale container |

The Tailchat server itself also reads these, which you can add under
`environment:` for the `tailchat` service in `docker-compose.yml`:

| Setting | Default | Meaning |
|---|---|---|
| `TAILCHAT_ALLOWED_HOSTS` | | extra host names people may use to reach it; `*.ts.net`, tailnet addresses and `localhost` always work |
| `TAILCHAT_STATUS_HOURS` | `24` | how long status updates last |
| `TAILCHAT_EDIT_WINDOW_S`, `TAILCHAT_DELETE_WINDOW_S` | 15 minutes, 2 days | edit and "delete for everyone" windows |
| `TAILCHAT_LIST_SELF` | off | list the Tailchat node itself as one of your machines |

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
  Every machine signed in to your Tailscale account is listed as its own chat,
  named after the machine: on `holysukuns` you see a chat for your phone, your
  laptop and every other machine of yours. A machine that hasn't opened
  Tailchat yet shows the address to open on it once; after that its chat sends
  messages and files to just that device, end-to-end encrypted. **Message
  yourself** reaches all of them. To reach just some of them, make a
  **device group**: tap the new chat button, then **New device group**, pick
  two or more devices and name the group. Messages in it are encrypted for
  those devices only, it shows under the **Groups** filter, and you can add or
  remove devices under **Group info**. Two browsers on one machine are told apart
  by browser, and you can rename any device under **Linked devices**. Tagged
  machines (servers) and machines shared with you by other people aren't
  listed.
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
  You can also call any of your own devices, or ring all of them at once from
  the Calls tab.
* **Privacy and devices**: last seen, read receipts, blocking, security codes
  to compare in person, linked devices you can rename or log out remotely, a
  chat with each of your other devices, and chat history sent end-to-end
  encrypted to a device you link later.
* **Settings**: profile name, about and photo, enter is send, and
  notifications for new messages (on phones and the installed app too, where
  the app icon also shows how many chats are unread). Turn them on in
  Settings > Notifications or from the banner above the chat list.
* **Layout**: on a computer, a rail down the left (Chats, Updates,
  Communities, Calls, Starred, Devices, Settings and your profile) beside the
  chat list and the open chat; on a phone, one screen at a time with those
  sections in a tab bar along the bottom. Green dots show who is online.
* **Themes**: Tailscale (the default), Ocean, Forest, Sunset, Grape, Rose and
  Graphite, each with light and dark colours that follow your system or stay
  fixed. Any theme can be edited: Tailchat makes your own copy, shows the
  colours live as you pick them, warns about text that would be hard to read,
  and gives each theme a code you can paste on another device.
* **Chat wallpapers**: give any chat a photo or a colour, dimmed as much as you
  like. Everyone in the chat sees the same wallpaper on every device (both
  devices of a device chat, every member of a group), in place of their
  theme's chat background. It's end-to-end encrypted like the messages, so
  the server never sees the photo. In groups where only admins edit the
  group info, only admins change it.

Not included: payments, business tools, live location and a sticker store.

## Security

Each device (browser or client) makes its own P-256 key pair and keeps the
private key to itself. A message is sealed with a fresh AES-256-GCM key, which
is wrapped for every device of every member. Files are encrypted in 1 MiB
chunks before upload. With the built-in calls, call setup is sealed the same
way, so the server can't put itself in the middle of a call. Calls through
peer-calls (the Docker default) set up through your own peer-calls container
instead, on your tailnet only. The full design is in
[PROTOCOL.md](PROTOCOL.md).

Every device key the app sees is pinned to its owner. When someone you talk to
links a new device, their chats with you say their security code changed, and
a new device on your own account gets a warning banner, so a device added
behind your back doesn't go unnoticed.

What the server can see: who is in which chat, when messages are sent and
how big they are, reactions, poll vote positions, receipts, profile names and
photos, and who called whom. It can't read messages, files, status updates or
call audio and video. Calls go device to device over WebRTC inside your
tailnet, encrypted by WebRTC and again by WireGuard.

Things to know:

* **Channel posts aren't end-to-end encrypted**: anyone can follow, so the
  server stores posts as they are. The app
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
  shared it with.
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
| `clients/go` | command-line client |
| `clients/rust` | `tailchat-drop`: send, receive and watch folders of files |
| `clients/ruby` | bot framework with example bots |

## Building the apps

### Windows app

`desktop/` is an [Electron](https://www.electronjs.org) app that opens your
server's web app in its own window. It remembers the server address, keeps
running in the tray, flashes the taskbar for unread chats, and only lets
pages on the Tailchat machine use the camera, microphone, notifications and
screen sharing; other links open in your browser.

The **Windows desktop app** workflow builds the installer and the portable
`.exe` on a Windows runner. On a pull request that changes `desktop/`, both
files are attached to the run (under *Artifacts* on its page). To publish a
release, run the workflow from the Actions tab, or push a `desktop-v*` tag;
bump `version` in `desktop/package.json` first. To build or try it by hand
on Windows:

```sh
cd desktop
npm ci
npm start          # run it
npm run dist       # installer and portable .exe in desktop/dist
```

### Android app

`mobile/` is an Expo app that opens your server's web app in a full-screen
WebView, with camera, microphone and location for calls and sharing, and the
share sheet for saving files.

The **Android APK** workflow builds it on [EAS](https://expo.dev) and publishes
a release with the APK. Add an `EXPO_TOKEN` repository secret (an access token
from expo.dev account settings), then run the workflow from the Actions tab or
push a `mobile-v*` tag. To build by hand: `cd mobile && npm ci && npx eas-cli
build --platform android --profile apk`.

## Development

```sh
cd tailchat
pip install -r requirements.txt
TAILCHAT_AUTH=dev python3 -m tailchat_server   # then open http://127.0.0.1:8443/dev/login
```

Dev mode lets you pick any user name and only listens on loopback. To try the
machine list, point `TAILCHAT_DEV_TAILNET` at a file in the format of
`tailscale status --json` (dev users are `<name>@dev`) and sign in at
`/dev/login?user=<name>&machine=<machine>`. Tests:

```sh
python3 -m unittest discover -s tests -t .     # server unit tests
npm install && npm test                        # API contract tests (Node 22+), driving the server with the web app's crypto
```

Each client folder has its own build and test instructions.
