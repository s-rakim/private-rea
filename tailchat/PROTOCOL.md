# Tailchat protocol

Everything a client needs to talk to a Tailchat server: the web app, and the
Python, Java, C# and C++ clients in `clients/`, all implement this document.

## 1. Transport and identity

The server is only reachable on your tailnet. There are no passwords:

| Mode (`TAILCHAT_AUTH`) | How the server learns who you are |
|---|---|
| `serve` (default) | `tailscale serve` terminates HTTPS with the machine's `*.ts.net` certificate and forwards to the server on loopback with `Tailscale-User-Login` / `Tailscale-User-Name` / `Tailscale-User-Profile-Pic` headers. Requests that do not come from loopback are refused. |
| `direct` | The server listens on its Tailscale IP and asks the local `tailscaled` (LocalAPI `whois`) which user owns the connecting address. Requests from outside `100.64.0.0/10` / `fd7a:115c:a1e0::/48` are refused. |
| `dev` | Local testing only, loopback only. The user comes from the `tailchat_dev_user` cookie (set at `/dev/login`) or an `X-Dev-User` header. |

Your Tailscale login name (`alice@example.com`) is your user id. Tagged
devices have no user identity and cannot use Tailchat.

Each browser or client is a **device**. A device registers a public key once
and gets a bearer token:

```
POST /api/devices  {"name": "Alice's laptop", "publicKey": {"kty":"EC","crv":"P-256","x":"…","y":"…"}}
-> {"device": {...}, "token": "<deviceId>.<secret>"}
```

Every other API call sends `Authorization: Bearer <token>`, and the token must
belong to the tailnet user making the request. Bodies are `application/json`
(uploads are `application/octet-stream`); the server answers no CORS
preflights, so other websites can't call the API from your browser.

## 2. Keys

* Each device has one **ECDH P-256** key pair. The private key never leaves the
  device (the web app keeps it as a non-extractable WebCrypto key in IndexedDB).
* Public keys are JWKs with base64url `x` and `y` (32 bytes each).
* `b64u` below is base64url **without padding**.

**Wrap key** between a sender device `S` and a recipient device `R`:

```
Z        = ECDH(S.private, R.public)                       # 32-byte shared x coordinate
wrapKey  = HKDF-SHA256(ikm = Z, salt = "tailchat/v1/wrap", info = S.id + "|" + R.id, length = 32)
```

The recipient computes the same `Z` as `ECDH(R.private, S.public)`. A device
also wraps for itself (`S == R`), so a sender can read its own messages.

## 3. Message envelope

A message's `payload` is this JSON object, serialised to a string:

```json
{
  "v": 1,
  "from": "<sender device id>",
  "iv": "<b64u, 12 bytes>",
  "ct": "<b64u, AES-256-GCM ciphertext followed by the 16-byte tag>",
  "keys": { "<device id>": "<b64u, RFC 3394 AES-KW of the 32-byte content key, 40 bytes>" }
}
```

* `contentKey` is 32 random bytes, fresh for every message (and every edit).
* `ct = AES-256-GCM(contentKey, iv, plaintext = UTF-8 JSON of the content, aad)`.
* `aad` binds the ciphertext to where it belongs, so the server can't move it:
  * chat message: `tailchat/v1|chat:<chatId>|msg:<messageId>` — the client
    picks `messageId` (16-32 base64url characters) and sends it as `id` when posting.
  * status update: `tailchat/v1|status:<userId>`
* `keys` holds one wrapped content key for every device that may read it:
  `GET /api/chats/:id/devices` (all logged-in devices of all current members,
  including the sender's own) or `GET /api/status/devices` for a status.
* To decrypt: look up your device id in `keys`, fetch the sender's public key
  with `GET /api/keys?ids=<from>` (logged-out devices are still listed), derive
  the wrap key, unwrap, then open `ct`. A device that was linked after a
  message was sent has no entry and can't read it — the same as WhatsApp.
* Clients should show a contact's **security code** so people can compare it
  in person. For each device: `d = b64u(SHA-256(x || y))` over the raw 32-byte
  coordinates. Sort the `d` strings, join them with no separator, and hash:
  `h = SHA-256(UTF-8 of the joined string)`. Group `i` (0-11) is
  `((h[2i] << 16) | (h[2i+1] << 8) | h[24 + i mod 8]) mod 100000`, zero-padded to
  5 digits; the code is the 12 groups joined by spaces.

## 4. Content

The decrypted content is a JSON object with a `type`:

| `type` | Fields |
|---|---|
| `text` | `text` |
| `media` | `kind` (`image`, `video`, `audio`, `voice`, `document`, `sticker`, `gif`), `file` (see §5), `caption`?, `thumb`? (small JPEG data: URL), `width`?, `height`?, `duration`? (seconds), `waveform`? (array of 0-100) |
| `location` | `lat`, `lon`, `name`?, `accuracy`? |
| `contact` | `userId`, `name` |
| `poll` | `question`, `options` (2-12 strings), `multiple` (bool) |
| `call` | `video`, `duration` (call summaries, optional) |

Any content may also carry:

* `replyTo`: `{ "id": messageId, "senderId": userId, "preview": "short text" }`
* `forwarded`: `true` (and `forwardCount` for "Forwarded many times")
* `mentions`: list of user ids mentioned with `@`
* `linkPreview`: `{ "url", "title", "description" }` (generated by the sender, never fetched by the server)

Reactions, poll votes (option **indices** only), stars, receipts and
view-once opens are plain API calls, not encrypted content.

## 5. Files

Attachments are encrypted on the device before upload, in 1 MiB chunks:

```
fileKey   = 32 random bytes
prefix    = 8 random bytes
chunk i   = plaintext bytes [i*1048576, (i+1)*1048576)        # an empty file is one empty chunk
iv_i      = prefix || uint32_be(i)
aad_i     = "tailchat/v1|file|" + i + "|" + ("1" if last chunk else "0")
blob      = concat over i of AES-256-GCM(fileKey, iv_i, chunk_i, aad_i)   # each ct is len+16 bytes
```

`POST /api/files` with the blob as `application/octet-stream` returns
`{"id"}`. The message content's `file` object carries what the recipients
need: `{ "id", "key": b64u(fileKey), "prefix": b64u(prefix), "size": plaintextBytes, "name", "mime", "sha256" }`, where
`sha256 = b64u(SHA-256(SHA-256(chunk_0) || SHA-256(chunk_1) || …))` over the
plaintext chunks (a chunked digest, so clients can hash while streaming).
`GET /api/files/:id` returns the blob to anyone who can see a message (or
status) that references it. The "last chunk" flag in the AAD means a server
can't truncate a file without the decryption failing.

Profile and group photos are the exception: they are uploaded unencrypted with
`POST /api/files?public=1` and served from `/api/avatars/:id`.

## 6. Realtime

`wss://<host>/ws`. The first frame must be `{"type":"auth","token":"<token>"}`;
the server answers `{"type":"ready"}`. Server events:

| `type` | Meaning |
|---|---|
| `message` / `message-update` | `{message}` new, edited, deleted-for-everyone, reacted to, voted on |
| `message-gone` | `{chatId, id}` deleted for me, or disappeared |
| `chat` / `chat-removed` | a chat's settings, members, receipts or your preferences changed |
| `receipt` | `{chatId, member}` delivered/read sequence numbers |
| `typing` | `{chatId, userId, on, kind: "typing" or "recording"}` |
| `user` | profile or presence changed |
| `devices` | `{userId}` that user's device list changed: refresh before encrypting |
| `status` / `status-gone` | status updates |
| `call` | call signalling, see below |

Clients send `{"type":"typing","chatId","on","kind"}` and call frames.

### Calls

WebRTC, device to device across the tailnet (no STUN/TURN servers needed:
Tailscale addresses are directly reachable). Frames are
`{"type":"call","action",...}`:

* `ring {callId, chatId, video}` → others get `ring {callId, chatId, from, video}`
* `accept {callId}` → you get `joined {peers:[{deviceId,userId}]}` and send an
  SDP offer to each peer; existing peers get `peer-joined`
* `signal {callId, toDevice, data:{sdp}|{candidate}}` → relayed as `signal {fromDevice, from, data}`
* `decline`, `hangup` → `declined`, `peer-left`, `ended {reason}`

Group calls are a mesh of up to 8 people.

## 7. REST summary

| Method & path | Purpose |
|---|---|
| `GET /api/me`, `PATCH /api/me` | profile (`name`, `about`, `avatar`), privacy (`hideLastSeen`, `readReceipts`) |
| `GET/POST /api/devices`, `DELETE /api/devices/:id` | linked devices |
| `GET /api/keys?ids=` | device public keys |
| `GET /api/users`, `GET /api/users/:id/devices` | people on the tailnet |
| `POST /api/blocks`, `DELETE /api/blocks/:userId` | block / unblock |
| `GET /api/chats`, `GET /api/chats/:id` | chat list with unread counts and last message |
| `POST /api/chats/direct {userId}`, `POST /api/chats/group {name, members, description?, avatar?}` | start chats |
| `PATCH /api/chats/:id` | group name/description/photo, `disappearing` seconds, `adminsOnlySend`, `adminsOnlyEdit` |
| `PATCH /api/chats/:id/prefs` | `pinned`, `archived`, `mutedUntil`, `markedUnread` |
| `POST /api/chats/:id/clear`, `DELETE /api/chats/:id` | clear / delete chat |
| `POST /api/chats/:id/members`, `DELETE /api/chats/:id/members/:userId`, `POST /api/chats/:id/admins` | membership |
| `POST/DELETE /api/chats/:id/invite`, `GET /api/invite/:code`, `POST /api/invite/:code/join` | invite links |
| `GET /api/chats/:id/devices` | recipients' device keys |
| `GET /api/chats/:id/messages?before=&after=&limit=`, `POST /api/chats/:id/messages {id, payload, files, viewOnce}` | history, send |
| `PUT /api/messages/:id {payload}`, `DELETE /api/messages/:id?for=everyone\|me` | edit, delete |
| `POST /api/messages/:id/react {emoji\|null}`, `/star {starred}`, `/vote {options}`, `/opened` | message actions |
| `POST /api/chats/:id/pin {messageId\|null}`, `POST /api/chats/:id/receipts {delivered, read}` | pin, receipts |
| `GET /api/starred` | starred messages |
| `POST /api/files[?public=1]`, `GET /api/files/:id`, `GET /api/avatars/:id` | files |
| `GET/POST /api/status`, `DELETE /api/status/:id`, `POST /api/status/:id/view`, `GET /api/status/devices` | status updates |
| `GET /api/calls` | call history |
