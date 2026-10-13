# tailchat-cpp

A C++20 command-line client for [Tailchat](../../PROTOCOL.md), built for fast,
streaming, end-to-end encrypted **file transfer** across your tailnet (think
`tailchat-send`). It works with the web app and the other clients: files and
messages sent from here open in the browser and the other way round.

* Crypto is OpenSSL 3 EVP: P-256 ECDH, HKDF-SHA256, RFC 3394 AES key wrap and
  AES-256-GCM, exactly as `PROTOCOL.md` §2-5 and `public/crypto.js` do them.
* Files stream through in 1 MiB chunks. Uploads encrypt chunk by chunk while
  libcurl sends them, with `Content-Length = size + 16 × chunks`. Downloads
  decrypt and check each chunk as it arrives and verify the chunked SHA-256
  at the end. Memory use stays flat: sending or receiving a 64 MiB file peaks
  at about 16 MiB RSS.
* A download is written to a hidden `.part` file and renamed only after
  every chunk and the checksum pass. A truncated, reordered or tampered file
  never shows up under its real name.
* HTTP(S) goes through libcurl, which also keeps connections alive. Proxy
  environment variables are ignored on purpose, because tailnet peers are
  reached directly.
* JSON uses a small built-in reader and writer (`src/json.*`). Its output
  matches `JSON.stringify` byte for byte.

## Build

Requirements: a C++20 compiler (g++ 13 tested), CMake ≥ 3.20, and the
OpenSSL 3 and libcurl development headers. On Debian or Ubuntu:

```sh
sudo apt-get install build-essential cmake libssl-dev libcurl4-openssl-dev
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j
./build/tailchat-cpp --help
```

## Use

```sh
S=https://chat.your-tailnet.ts.net     # your Tailchat server (tailscale serve)

tailchat-cpp --server $S whoami                     # first run links this machine as a device
tailchat-cpp chats
tailchat-cpp send alice@example.com "hello from the terminal"
tailchat-cpp send-file alice@example.com ./video.mp4 --caption "the clip"
tailchat-cpp history alice@example.com              # or a chat id
tailchat-cpp download <message-id> ~/Downloads
```

`CHAT_OR_USER` is a chat id (see `chats`) or a user id. A user id contains `@`
and selects your direct chat with that person, creating it if needed.

| Option | |
|---|---|
| `--server URL` | server base URL (env `TAILCHAT_SERVER`). Can be left out when the state file knows only one server. |
| `--state PATH` | device state (env `TAILCHAT_STATE`; default `~/.config/tailchat/cpp-client.json`) |
| `--dev-user NAME` | dev mode only: sends `X-Dev-User: NAME` (env `TAILCHAT_DEV_USER`) |
| `--device-name NAME` | name shown under linked devices (default `tailchat-cpp on <hostname>`) |
| `--cacert FILE` | CA bundle for https |
| `--chat CHAT` | `download`: look only in this chat. Otherwise every chat is searched. |
| `--caption`, `--mime` | `send-file` extras |
| `--limit N` | `history`: number of messages (max 200) |
| `--json` | machine-readable output, one JSON object per line |
| `--stats` | time, throughput and peak RSS on stderr |
| `-q`, `-v` | no progress output / show HTTP traffic |

`register --force` links the machine again as a new device, for example after
it was logged out from another device.

### State file

On first use the client generates a P-256 key pair, registers the public half
with `POST /api/devices` and stores the key and the bearer token in the state
file. The file is written atomically with mode `0600` in a `0700` directory.
It holds one profile per server (and per dev user), so one file can serve
several servers. The private key never leaves the file. Anyone who can read
the file can read your messages, so treat it like an SSH key.

### Output and exit status

Commands exit 0 on success and 1 on any error, with the message on stderr.
With `--json`:

* `send` → `{"chatId","id","seq"}`
* `send-file` → `{"chatId","id","fileId","size","uploaded","sha256"}`
* `history` → one line per message: `{"id","chatId","seq","senderId","senderDevice","createdAt","content"}`. A message that can't be decrypted carries `"error"` in place of `content`.
* `download` → `{"path","name","size","sha256"}`

Files are sent as `media` content with `kind: "document"` and no thumbnail.
`download` never overwrites an existing file: it picks `name (1).ext`, and it
strips path components and control characters from the sender's file name.

## Tests

```sh
./test.sh            # = cmake configure + build + ctest
```

* **unit** (`test/unit_tests.cpp`, offline): RFC 3394 and RFC 5869 vectors,
  NIST GCM vectors, base64url, ECDH symmetry, rejection of off-curve points,
  JSON writer equal to `JSON.stringify`, and chunked file encryption with
  truncation, bit-flip, extension, wrong checksum and dropped last chunk.
* **interop** (`test/interop.mjs`, needs Node ≥ 20): starts a real dev-mode
  server on a free port with a temporary data directory and runs the web
  app's `public/crypto.js` as the other user:
  * C++ → JS: a text message (and the envelope serialises exactly as
    `JSON.stringify` would), plus files of 2.5 MiB + 123 B, 0 B, 1 MiB and
    2 MiB, checked with `decryptFile` and the JS chunked SHA-256
  * JS → C++: a text message through `history`, plus files of 3 MiB + 1 B,
    0 B and 1 MiB through `download`
  * a sender reading its own messages (self-wrapped key), the security code
    matching `securityCode()`, and a state file with mode 0600
  * tampered downloads: wrong checksum, dropped chunk, shortened size claim
    and a flipped bit all fail and leave no file behind
  * a 64 MiB C++ → C++ transfer whose peak RSS stays under 32 MiB on both
    ends

  The server command is chosen in one helper: `$TAILCHAT_SERVER_CMD` (a shell
  command run from `tailchat/`) if set, else `python3 -m tailchat_server` when
  `tailchat/tailchat_server/` exists, else
  `node --no-warnings=ExperimentalWarning server/index.js`. The test sets
  `TAILCHAT_AUTH=dev TAILCHAT_HOST=127.0.0.1 TAILCHAT_PORT=<free>
  TAILCHAT_DATA=<tmp>` for it.

## Not implemented

The realtime WebSocket (`listen`), groups, status updates, reactions and the
other plain REST actions are left out. This client focuses on encrypted
messages and file transfer, and the REST calls are easy to add on top of
`Client::http()`.
