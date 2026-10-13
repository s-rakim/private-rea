#!/usr/bin/env bash
# Builds build/tailchat.jar with the JDK only (javac + jar, Java 21).
set -euo pipefail
cd "$(dirname "$0")"
rm -rf build/classes
mkdir -p build/classes
javac --release 21 -Xlint:all,-serial -Werror -d build/classes $(find src/main/java -name '*.java')
jar --create --file build/tailchat.jar --main-class net.tailchat.client.Main -C build/classes .
echo "built $(pwd)/build/tailchat.jar"
