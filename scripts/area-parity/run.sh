#!/bin/sh
# TS↔Swift area-cell parity: golden cases from the TS module, replayed in Swift.
set -e
cd "$(dirname "$0")/../.."
GOLDEN=$(mktemp /tmp/area-golden.XXXXXX.json)
BIN=$(mktemp /tmp/area-parity.XXXXXX)
bun run scripts/area-parity/gen.ts > "$GOLDEN"
swiftc -O ios/Sources/AreaId.swift scripts/area-parity/main.swift -o "$BIN"
"$BIN" "$GOLDEN"
rm -f "$GOLDEN" "$BIN"
