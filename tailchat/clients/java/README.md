# Tailchat Java client

A Java 21 library and command line client for Tailchat. It uses only the JDK:
`java.net.http` for HTTP and WebSocket, `javax.crypto` for ECDH P-256, AES-256-GCM and
RFC 3394 AES-KW, HKDF built on HMAC-SHA256, and a small JSON reader/writer of its own.
It follows [`PROTOCOL.md`](../../PROTOCOL.md) and works with the web app's
`public/crypto.js` in both directions.

## Build

```sh
./build.sh                      # -> build/tailchat.jar
alias tailchat='java -jar /path/to/tailchat/clients/java/build/tailchat.jar'
```

## Use

The first command registers this machine as a new device. It creates a P-256 key pair and
saves the private key, device id and token in the state file
(`~/.config/tailchat/java-client.json` by default, mode 0600). Later commands reuse that
file, so `--server` is only needed the first time.

```sh
tailchat --server https://chat.your-tailnet.ts.net whoami
tailchat users
tailchat chats
tailchat send alice@example.com "hello"        # a user id opens (or creates) the direct chat
tailchat send CHAT_ID "hello group"
echo "héllo" | tailchat send CHAT_ID -         # TEXT "-" reads UTF-8 from stdin
tailchat send-file alice@example.com ./photo.jpg --caption "look"
tailchat history CHAT_ID --limit 20            # prints message ids
tailchat download MESSAGE_ID ./downloads       # decrypts and verifies the chunked sha256
tailchat listen                                # live messages; posts delivered receipts
tailchat code alice@example.com                # security code, to compare in person
```

Options: `--server URL` (or `$TAILCHAT_SERVER`), `--state FILE` (or `$TAILCHAT_STATE`),
`--name DEVICE` (the device name used when registering), and `--json` (one JSON object per
line, for scripts). `--dev-user NAME` (or `$TAILCHAT_DEV_USER`) sends `X-Dev-User: NAME`. It
only works with a server started with `TAILCHAT_AUTH=dev` and is meant for local testing.
Use one state file per server and identity.

Output is always UTF-8. Under a non-UTF-8 locale (for example `LANG` unset), the JVM decodes
non-ASCII command-line arguments as `?`. In that case, set `LANG=C.UTF-8` or pipe the text in
with `send CHAT -`.

## Library

```java
TailchatClient c = TailchatClient.connect("http://127.0.0.1:8443", "alice", Path.of("alice.json"), null);
String chatId = c.resolveChat("bob@dev");
c.sendText(chatId, "hi");
c.sendFile(chatId, Path.of("report.pdf"), "caption");
for (Map<String, Object> m : c.messages(chatId, 50)) System.out.println(c.openMessage(m));
try (TailchatClient.Connection ws = c.listen(event -> System.out.println(event))) { ... }
```

The crypto primitives live in `Crypto`: `hkdf`, `aesKwWrap`, `encryptFile`/`decryptFile`
and `securityCode`. Envelopes are sealed and opened by `KeyRing`.

## Test

```sh
./test.sh
```

`test.sh` runs known-answer tests (RFC 5869 HKDF, RFC 3394 AES-KW, JWK coordinate padding,
file chunking). It then starts a real dev-mode server on a free port and checks interop in
both directions with `public/crypto.js`, through `src/test/js/js-peer.mjs`. The checks cover
text and multi-chunk files (empty, exactly 2 MiB, about 2.5 MiB and 3 MiB), AAD binding, a
device key whose x coordinate starts with `0x00`, WebSocket delivery with receipts, and
security codes.

The server is chosen in `TestServer.java`:

1. `$TAILCHAT_SERVER_CMD`, run with `sh -c` in `tailchat/`, if it is set.
2. Otherwise `python3 -m tailchat_server`, if `tailchat/tailchat_server/__main__.py` exists.
3. Otherwise the Node server. `test.sh` runs `npm install` first if `node_modules` is missing.

Node 22 or later is always needed for the JS side of the tests.
