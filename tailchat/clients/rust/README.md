# tailchat-drop

A fast, memory-safe command-line tool for sharing files over
[Tailchat](../../PROTOCOL.md). Files are end-to-end encrypted on your machine,
are never loaded into memory whole, and anyone in the chat can open them in the
web app or any other Tailchat client.

```sh
cargo build --release            # -> target/release/tailchat-drop (about 3 MB, no OpenSSL)
```

## Use

```sh
export TAILCHAT_SERVER=https://chat.your-tailnet.ts.net

tailchat-drop whoami                       # registers this device on first use
tailchat-drop send alice@example.com report.pdf holiday.jpg --caption "as promised"
tailchat-drop watch alice@example.com ~/Drop   # drop folder: new files are sent, then moved to ~/Drop/.sent/
tailchat-drop receive alice@example.com ~/Downloads/from-alice
tailchat-drop history "Weekend" --limit 20     # a group by name; --json for scripts
tailchat-drop chats
tailchat-drop text alice@example.com "sent you the files"
```

A chat is named by its id, a group name, or a user id (which opens the direct
chat). `send` picks `image`/`video`/`audio` from the file extension and
`document` for everything else (`--document` forces it). `watch` waits until a
file has stopped changing for `--settle` seconds (default 2), skips hidden and
partial files (`.part`, `.crdownload`, ...), retries failures with backoff,
and `--once` sends what is there and exits. `receive` verifies every chunk and
the file checksum, writes to a temporary file first, never overwrites
(`name (2).ext`), and skips files it already has.

## Security notes

* The device's P-256 private key and bearer token live in
  `~/.config/tailchat-drop/<server>.json` (or `--state PATH`), mode 0600.
  `register --force` replaces the device and logs the old one out.
* Crypto is RustCrypto (`p256`, `aes-gcm`, `aes-kw`, `hkdf`, `sha2`) and
  matches `public/crypto.js` byte for byte (PROTOCOL.md §2-5). Senders are
  checked: an envelope must come from a device of the message's sender.
* Names chosen by the sender are reduced to a plain file name before saving.
* HTTPS uses rustls with the Mozilla roots (Tailscale `*.ts.net` certificates
  are publicly trusted). HTTP proxies are ignored: the tailnet is reached directly.
* `--dev-user NAME` sends `X-Dev-User` and only works against a server running
  with `TAILCHAT_AUTH=dev` on loopback. Never use it for anything real.

## Tests

```sh
cargo test                       # unit tests + end-to-end tests against a real server
cargo clippy --all-targets -- -D warnings
```

The integration tests (`tests/interop.rs`) start a real server in dev mode on
a free port and drive a JavaScript peer built on `public/crypto.js`
(`tests/js/peer.mjs`, needs Node 22+), proving that text and multi-chunk files
go both ways. The server is `python3 -m tailchat_server` when
`tailchat/tailchat_server/` exists, otherwise the Node server; set
`TAILCHAT_SERVER_CMD` to run something else (a shell command, run in `tailchat/`).
