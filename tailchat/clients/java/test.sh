#!/usr/bin/env bash
# Builds the client, then runs the tests: known-answer vectors plus interop in both
# directions with tailchat/public/crypto.js through a real dev-mode server.
# Server choice (see TestServer.java): $TAILCHAT_SERVER_CMD, else `python3 -m tailchat_server`
# if tailchat/tailchat_server/__main__.py exists, else the Node server.
set -euo pipefail
cd "$(dirname "$0")"
here="$(pwd)"
tailchat="$(cd ../.. && pwd)"

./build.sh
if [ -z "${TAILCHAT_SERVER_CMD:-}" ] && [ ! -f "$tailchat/tailchat_server/__main__.py" ] && [ ! -d "$tailchat/node_modules" ]; then
  (cd "$tailchat" && npm install --no-audit --no-fund)
fi

rm -rf build/test-classes
mkdir -p build/test-classes
javac --release 21 -Xlint:all,-serial -Werror -cp build/classes -d build/test-classes $(find src/test/java -name '*.java')
exec java -cp build/classes:build/test-classes -Dtailchat.java.dir="$here" net.tailchat.client.InteropTest
