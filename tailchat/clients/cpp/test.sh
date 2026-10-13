#!/bin/sh
# Build tailchat-cpp and run the unit tests plus the interop test against a
# real dev-mode Tailchat server (see test/interop.mjs for server selection).
set -eu
cd "$(dirname "$0")"
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j"$(nproc 2>/dev/null || echo 4)"
ctest --test-dir build --output-on-failure "$@"
