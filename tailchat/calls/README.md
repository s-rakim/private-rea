# Tailchat calls

Tailchat's call service. This is the source of
[peer-calls](https://github.com/peer-calls/peer-calls) v4.2.7 (commit
`d43abf6`, by Jerko Steiner and contributors, Apache License 2.0, see
[LICENSE](LICENSE)), kept here so the calls container is built from code in
this repository rather than pulled as someone else's image. The original
README is [README.upstream.md](README.upstream.md).

`docker compose up -d --build` in `tailchat/` builds it with the
[Dockerfile](Dockerfile) and runs it as the `calls` container, reachable only
through `tailscale serve` on port 3443. It runs in mesh mode: it passes call
setup between the browsers in a call, and the audio and video go directly
between the devices over the tailnet. Nothing about a call goes anywhere else.

## Changes from peer-calls 4.2.7

* `server/configread.go`: no ICE servers by default. peer-calls used to send
  every browser Google's and Twilio's public STUN servers.
* `server/iceauth.go`: an empty ICE server list reaches the browser as `[]`.
  It used to be `null`, which made every call fail.
* `src/client/reducers/nicknames.ts`: the name box starts with the name in
  the link's fragment (`#name=…`), so Tailchat can fill in the device's name.
* `Dockerfile`: builds on Node 22 and Go 1.24 and runs as an unprivileged
  user.
* The tests for the first two changes are updated, and upstream's CI,
  Kubernetes, Redis compose and example certificate files are left out.
