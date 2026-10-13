# Tailchat Python client

A command line client for Tailchat that implements [`PROTOCOL.md`](../../PROTOCOL.md).
Messages and files are end-to-end encrypted on this machine and interoperate
with the web app (`public/crypto.js`). The only dependency is `cryptography`.
HTTP and WebSockets use the standard library.

## Install

```sh
cd tailchat/clients/python
pip install .          # installs the `tailchat` command
# or, without installing:
PYTHONPATH=. python -m tailchat --help
```

Requires Python 3.10+.

## Usage

The first command registers this machine as a new **device**. It generates an
ECDH P-256 key pair, registers the public key, and saves the private key and
bearer token to `~/.config/tailchat/state.json` with mode 0600. You can
override the path with `--state` or `$TAILCHAT_STATE`. Your identity is your
Tailscale login, so there is no password.

```sh
tailchat --server https://chat.tail1234.ts.net --name "build box" register
tailchat whoami                       # user, device and your security code
tailchat users
tailchat chats                        # with decrypted previews
tailchat send bob@example.com "hello over the tailnet"     # opens the direct chat
tailchat send Uh0IT3yNgGRumWXgdCzMhA "to a group, by chat id"
echo "from stdin" | tailchat send bob@example.com -
tailchat send-file bob@example.com ./holiday.jpg --caption "beach"
tailchat history bob@example.com --limit 20 [--mark-read]
tailchat download 5MO5i-tG-J8nB1wEzVuPug ~/Downloads   # decrypts and verifies the sha256
tailchat code bob@example.com         # compare this in person with Bob
tailchat listen --save-files ~/Downloads/tailchat      # prints new messages, sends delivered receipts
```

* A target can be a chat id, a user id (`bob@example.com`), or the part of a
  user id before the `@` when that part is unique.
* `--json` prints machine-readable output. `listen --json` prints one event
  per line.
* `listen` reconnects on its own and catches up on any chats it saw messages
  in. `--count N` makes it exit after N messages.
* Each state file is one device. Use another `--state` to act as a second
  device or user.

### Dev-mode servers

A server started with `TAILCHAT_AUTH=dev` on loopback takes the user from an
`X-Dev-User` header:

```sh
tailchat --state /tmp/alice.json --server http://127.0.0.1:8443 --dev-user alice register
```

Never use `--dev-user` against a real server. It only works in dev mode.

## Tests

The tests start a real dev-mode server. They use `$TAILCHAT_SERVER_CMD` if it
is set, otherwise `python -m tailchat_server` if that package exists, otherwise
`node server/index.js`. They also check interop both ways against
`public/crypto.js`, so Node 22+ is required:

```sh
cd tailchat/clients/python
python -m unittest discover -s tests -t . -v
```
