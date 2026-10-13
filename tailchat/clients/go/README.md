# Tailchat for Go

Two programs that speak [PROTOCOL.md](../../PROTOCOL.md):

* **`tailchat-gateway`** puts a Tailchat server on your tailnet without
  installing `tailscaled`. It joins the tailnet itself (tsnet), serves HTTPS
  on :443 with the node's `*.ts.net` certificate and proxies to the server on
  loopback, HTTP and WebSocket. For every request it asks the tailnet who the
  peer is (WhoIs), refuses tagged nodes and unknown peers with 403, deletes any
  `Tailscale-*`, `X-Dev-User` or `tailchat_dev_user` cookie the client sent, and
  sets `Tailscale-User-Login` / `-Name` / `-Profile-Pic` the way
  `tailscale serve` does (non-ASCII names RFC 2047 encoded). It never enables
  Funnel, and `--funnel` is refused: Tailchat is tailnet-only.
* **`tailchat`** is a command-line client: end-to-end encrypted text and
  files (streamed in 1 MiB AES-256-GCM chunks), history, downloads and live
  messages. It interoperates with the web app (`public/crypto.js`).

Go 1.24.4 or newer. `tailchat` itself only depends on `github.com/coder/websocket`.

```sh
go build ./cmd/...            # ./tailchat and ./tailchat-gateway
```

## Gateway

```sh
# 1. The Tailchat server in serve mode, on loopback (from the tailchat/ directory)
TAILCHAT_AUTH=serve TAILCHAT_HOST=127.0.0.1 TAILCHAT_PORT=8443 python3 -m tailchat_server

# 2. The gateway (first run: open the login URL it prints, or pass an auth key)
TS_AUTHKEY=tskey-auth-... ./tailchat-gateway --hostname tailchat --state-dir /var/lib/tailchat-gateway
```

Then open `https://tailchat.<your-tailnet>.ts.net`. Turn on MagicDNS and HTTPS
certificates in the Tailscale admin console first. Flags: `--hostname`
(default `tailchat`), `--state-dir` (tailnet state: keep it private),
`--upstream` (default `http://127.0.0.1:8443`), `--redirect-http` (default on:
:80 on the tailnet redirects to https), `--verbose`. The gateway refuses to
start if the upstream is in dev mode.

## CLI

```sh
export TAILCHAT_SERVER=https://tailchat.example.ts.net
tailchat whoami                         # registers this device on first use
tailchat chats
tailchat send alice@example.com "Hi Alice"
tailchat send-file --caption "slides" alice@example.com talk.pdf
tailchat history alice@example.com
tailchat download MESSAGE_ID ~/Downloads
tailchat listen
tailchat code alice@example.com         # security code to compare in person
```

A chat is named by its id, a group name, or a user id (their direct chat).
The device key and token live in a mode-0600 state file under your config
directory (one per server; `--state` to choose). Against a local dev-mode
server, `--server http://127.0.0.1:8443 --dev-user alice` picks the user.

Downloads verify every chunk and the file's checksum, never overwrite an
existing file and strip path components from the sender's file name. Text
from other people is printed with control characters replaced, so a message
can't drive your terminal.

## Tests

```sh
go test ./...
```

The tests start a real Tailchat server (`TAILCHAT_AUTH=dev` and `serve`, on a
free loopback port with a temporary data directory): `python3 -m
tailchat_server` when `tailchat_server/__main__.py` exists, else `node
server/index.js`; set `TAILCHAT_SERVER_CMD` to run something else (it runs
with `sh -c` in `tailchat/`). They prove interop both ways with
`public/crypto.js` through `node` (text, multi-chunk files, files at every
chunk boundary, security codes), run the CLI end to end, and put the
gateway handler in front of a serve-mode server with a fake WhoIs. Tests
that need a missing runtime are skipped. Joining a real tailnet is not tested.
