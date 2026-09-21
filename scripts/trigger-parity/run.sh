#!/bin/sh
# TS↔Swift trigger parity: golden cases from the web's evaluator, replayed
# through the phone's TriggerEvaluator.
set -e
cd "$(dirname "$0")/../.."
GOLDEN=$(mktemp /tmp/trigger-golden.XXXXXX.json)
BIN=$(mktemp /tmp/trigger-parity.XXXXXX)
bun run scripts/trigger-parity/gen.ts > "$GOLDEN"
swiftc -O ios/Sources/TriggerEvaluator.swift ios/Sources/Models.swift ios/Sources/Geo.swift scripts/trigger-parity/main.swift -o "$BIN"
"$BIN" "$GOLDEN"
rm -f "$GOLDEN" "$BIN"
