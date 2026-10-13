# Tailchat C# client

A .NET 8 class library and command-line client for [Tailchat](../../PROTOCOL.md), interoperable
byte-for-byte with the web app's `public/crypto.js`. No third-party runtime packages: only
`System.Net.Http`, `System.Net.WebSockets.ClientWebSocket`, `System.Security.Cryptography` and
`System.Text.Json`.

```
Tailchat.sln
src/Tailchat.Client/   library: crypto, REST API, WebSocket, high-level TailchatClient
src/Tailchat.Cli/      the `tailchat` console app
tests/Tailchat.Tests/  xunit tests: unit tests + interop against a real server and a JS peer
```

## Build and test

Needs the .NET 8 SDK (`apt-get install dotnet-sdk-8.0` on Ubuntu 24.04). The interop tests also need
`python3` (to run the server) and `node` 22+ (to run the JavaScript peer).

```sh
cd tailchat/clients/csharp
dotnet build
dotnet test
dotnet run --project src/Tailchat.Cli -- --help
```

The tests start the real server in dev mode on a free loopback port with a throwaway data directory.
Which server is decided in one place (`ServerCommand` in `tests/Tailchat.Tests/TestServer.cs`):

1. `TAILCHAT_SERVER_CMD`, if set, run with `/bin/sh -c` in `tailchat/` (it gets `TAILCHAT_AUTH=dev`,
   `TAILCHAT_HOST`, `TAILCHAT_PORT` and `TAILCHAT_DATA` in its environment);
2. otherwise `python3 -m tailchat_server` when `tailchat/tailchat_server/__main__.py` exists;
3. otherwise the Node server, `node server/index.js` (after `npm install` if `node_modules` is missing).

`TAILCHAT_ROOT` overrides where the `tailchat/` directory is (found by walking up from the test binary).

The interop tests drive `tests/Tailchat.Tests/interop/peer.mjs`, a small device built on the web app's
own `public/crypto.js`, and check both directions: text messages and files (empty, exactly 1 MiB and
2.5 MiB + 123 bytes) sealed in C# open in JavaScript and the other way round, plus multi-device
reading, live WebSocket delivery with receipts, security codes, tamper detection and the CLI itself.

## Using the CLI

```sh
tailchat --server https://box.your-tailnet.ts.net whoami     # first run registers this device
tailchat users
tailchat chats
tailchat send alice@example.com "lunch?"                      # chat id, group name, user id or name
tailchat send-file "Weekend" ./photo.jpg --caption "view"     # --kind/--mime override detection
tailchat history alice@example.com --limit 20
tailchat download <MESSAGE_ID> ./downloads                    # decrypts and verifies the checksum
tailchat listen                                               # live messages; Ctrl+C to stop
tailchat security-code alice@example.com                      # compare in person
```

Text starting with `-` can be passed after `--` (`tailchat send bob -- "-1 from me"`).

On first use the client generates a P-256 key pair, registers it with `POST /api/devices` and saves the
private key (as a JWK) and the device token to a state file, readable only by you (mode 0600):
`--state PATH`, else `$TAILCHAT_STATE`, else `~/.config/tailchat-csharp/state.json`
(`state-dev-NAME.json` with `--dev-user NAME`). Anyone who can read that file can read your messages.
Later runs take the server from the state file, so `--server` is only needed once.

### Dev mode

Against a server started with `TAILCHAT_AUTH=dev` (loopback only), `--dev-user NAME` sends
`X-Dev-User: NAME` on every request and on the WebSocket upgrade, so you can play several users on one
machine:

```sh
(cd tailchat && TAILCHAT_AUTH=dev TAILCHAT_PORT=8443 python3 -m tailchat_server) &
tailchat --server http://127.0.0.1:8443 --dev-user alice whoami
tailchat --server http://127.0.0.1:8443 --dev-user bob listen &
tailchat --dev-user alice send bob@dev "hi bob"
```

Real servers ignore the header: identity always comes from Tailscale.

## Library

```csharp
using var client = await TailchatClient.OpenAsync(new ClientOptions { Server = "https://box.ts.net" });
var chat = await client.ResolveChatAsync("alice@example.com");
await client.SendTextAsync(chat.Id, "hello");
await client.SendFileAsync(chat.Id, "report.pdf", caption: "Q3");
foreach (var m in await client.HistoryAsync(chat.Id))
    Console.WriteLine(m.Error ?? m.Content?.ToJsonString());
await client.ListenAsync(evt => { /* evt.Message is decrypted */ return Task.CompletedTask; }, ct: ct);
```

Lower level pieces follow PROTOCOL.md directly:

| Type | Protocol |
|---|---|
| `Base64Url` | §2 base64url without padding |
| `DeviceKey` | §2 ECDH P-256 (`DeriveRawSecretAgreement` = the 32-byte shared x) |
| `KeyRing` | §2 wrap key (HKDF-SHA256, salt `tailchat/v1/wrap`, info `S.id|R.id`), §3 envelope seal/open |
| `AesKeyWrap` | RFC 3394 AES-KW on top of AES-ECB (RFC test vectors in the tests) |
| `Aad` | `tailchat/v1|chat:<chatId>|msg:<messageId>`, `tailchat/v1|status:<userId>`, `tailchat/v1|file|<i>|<0/1>` |
| `FileCrypto` | §5 1 MiB chunks, IV `prefix || uint32_be(i)`, chunked SHA-256; streams, no temp copies |
| `SecurityCode` | §3 security code |
| `TailchatApi` / `RealtimeConnection` | §7 REST and §6 WebSocket |

Beyond what `crypto.js` does, the client also rejects a message whose envelope `from` device does not
belong to the message's `senderId`, refuses a server that changes a known device's public key, and
only writes a downloaded file under its final name once every chunk and the checksum have verified
(the sender's file name is sanitised and never overwrites an existing file).
