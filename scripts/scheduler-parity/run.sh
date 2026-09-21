#!/bin/sh
# TS↔Swift scheduler parity: the phone's SpotScheduler generates golden
# decisions and simulated journeys; the TypeScript port must reproduce them.
set -e
cd "$(dirname "$0")/../.."
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
swiftc -O ios/Sources/SpotScheduler.swift ios/Sources/Models.swift ios/Sources/Geo.swift ios/Sources/TriggerEvaluator.swift \
  ios/Sources/NarrationDuration.swift ios/Sources/PlayHistory.swift ios/Sources/SpotLocator.swift \
  ios/Tests/JourneySimulator.swift scripts/scheduler-parity/main.swift -o "$WORK/gen"
"$WORK/gen" > "$WORK/golden.json"
bun run scripts/scheduler-parity/check.ts "$WORK/golden.json"
