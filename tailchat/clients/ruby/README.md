# Tailchat for Ruby

A Tailchat client and bot framework (the tailnet's answer to WhatsApp bot
accounts) in plain Ruby 3.3: only the standard library (`openssl`, `net/http`,
`json`, `socket`), including its own small WebSocket client. No gems.

It implements [`PROTOCOL.md`](../../PROTOCOL.md) and interoperates with the web
app's `public/crypto.js`: ECDH P-256, HKDF-SHA256, AES-KW and AES-256-GCM
envelopes, and chunked file encryption.

## A bot in ten lines

```ruby
require_relative 'lib/tailchat'

bot = Tailchat::Bot.new(server: 'https://chat.example.ts.net', state: '~/.tailchat/weather.json', name: 'Weather bot')
bot.command('/weather', description: 'Forecast for a city') { |msg, args| msg.reply("Sunny in #{args}") }
bot.on_message { |msg| msg.reply('Try /help') }               # anything that isn't a command
bot.on_file { |msg, file| file.save('inbox') }                # decrypts while downloading
bot.command('/later') { |msg, _| bot.after(60) { msg.reply('a minute later') } }  # timers: #at / #after
bot.run                                                       # Ctrl-C to stop
```

- Handlers run one at a time on one thread, timers included.
- Every incoming message is marked delivered and read as soon as it is
  decrypted. Messages that arrived while the bot was offline are handled when
  it connects. The bot reconnects with backoff if the connection drops.
- `/help` is built in. It lists your commands and their descriptions.
- Tagged devices have no Tailscale identity, so a bot runs as a real user. By
  default it ignores that user's own messages except in their
  "message yourself" chat, which makes that chat the owner's console. Pass
  `handle_own: true` to answer the owner everywhere, or `false` to never answer.

## Examples

```sh
export TAILCHAT_SERVER=https://chat.example.ts.net      # the server's tailscale serve URL
ruby examples/echo_bot.rb                               # echoes texts and files
ruby examples/reminder_bot.rb                           # /remind 10m take a break, /reminders, /cancel
ARCHIVE_DIR=~/archive ruby examples/file_archiver_bot.rb  # saves every file it gets
```

Each bot keeps its device in `~/.tailchat/<bot>.json`, or in `TAILCHAT_STATE`
if you set it. In dev mode, add `TAILCHAT_DEV_USER=echobot` and point
`TAILCHAT_SERVER` at `http://127.0.0.1:<port>`.

## Client

```ruby
client = Tailchat::Client.new(server: url, state: 'me.json')   # dev_user: 'alice' for dev mode only
chat = client.direct_chat('bob@example.com')
client.send_text(chat['id'], 'hi', reply_to: some_message)
client.send_file(chat['id'], 'photo.jpg', mime: 'image/jpeg', caption: 'look')
client.history(chat['id']).each { |m| puts m.error ? "(unreadable: #{m.error.message})" : m.text }
client.listen { |event| p event }                              # WebSocket events, until client.stop
```

The first call registers the device. It creates a P-256 key pair and saves the
private key and token to the state file with mode 0600. Later runs reuse that
file.

Received messages are checked like this:

- A message decrypts only if its envelope is bound to its chat and message id.
- The device that sealed it must belong to the user the server names as the
  sender.
- A file must match its chunked SHA-256, and a truncated file fails to decrypt.

`Attachment#save` strips paths and control characters from the sender's file
name and never overwrites an existing file. Use `client.security_code(user_id)`
to get a contact's security code for comparing in person.

## Tests

```sh
cd tailchat/clients/ruby
ruby test/run.rb           # or: rake test
```

The tests start a real dev-mode server on a free port. They use
`TAILCHAT_SERVER_CMD` if you set it (a shell command run from `tailchat/`).
Otherwise they use `python3 -m tailchat_server` if `tailchat/tailchat_server/`
exists, and fall back to the Node server if it doesn't.

The interop tests drive a second device through `test/js/peer.mjs`, which uses
`public/crypto.js`. They therefore need `node`, and run `npm install` in
`tailchat/` if `ws` is missing.

Set `VERBOSE=1` to see the bots' logs.
