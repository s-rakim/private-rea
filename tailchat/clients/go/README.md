# Tailchat for Go

A command-line client that speaks [PROTOCOL.md](../../PROTOCOL.md):
end-to-end encrypted text and files (streamed in 1 MiB AES-256-GCM chunks),
history, downloads and live messages. It interoperates with the web app
(`public/crypto.js`) and talks to the Tailchat server you run with Docker.

Go 1.24.4 or newer. It only depends on `github.com/coder/websocket`.

```sh
go build ./cmd/...            # ./tailchat
```

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
chunk boundary, security codes), and run the CLI end to end. Tests that need a missing
runtime are skipped.
