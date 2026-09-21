#!/bin/sh
# TS↔Swift locator parity: golden cases from the TS module, replayed in Swift.
set -e
cd "$(dirname "$0")/../.."
GOLDEN=$(mktemp /tmp/locator-golden.XXXXXX.json)
BIN=$(mktemp /tmp/locator-parity.XXXXXX)
bun run scripts/locator-parity/gen.ts > "$GOLDEN"
swiftc -O ios/Sources/SpotLocator.swift scripts/locator-parity/main.swift -o "$BIN"
"$BIN" "$GOLDEN"
rm -f "$GOLDEN" "$BIN"
