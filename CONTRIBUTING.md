# Contributing

## Setup

Bun ≥ 1.3, Docker, and (for iOS) Xcode + `brew install xcodegen`. Then the
"Run it" steps in [README.md](README.md). No sibling checkouts needed.

## Rules

- Strict TypeScript, 2-space indent. No lint config yet — match surrounding
  style.
- zod `safeParse` at every route boundary; `{ error, detail }` JSON with real
  status codes.
- Repo functions take `sql` first and return DTOs; routes never touch rows.
- PostGIS owns geo math. No haversine in JS.
- Never index UTF-8 bytes by UTF-16 code units — use `byteToStringIndex`
  (TS) / `TranscriptView.stringRange` (Swift).
- The public API serves published content only.
- DB migrations (`server/db/*.sql`) are forward-only, numbered, never edited
  after merge.

## Before a PR

```sh
bun run typecheck
cd packages/shared && bun test
cd server && bun test        # needs grandtour_test DB, see README
cd ios && xcodebuild test -project GrandTour.xcodeproj -scheme GrandTourTests \
  -destination 'platform=iOS Simulator,name=iPhone 17'   # after xcodegen generate
```

CI runs these plus the admin build, an iOS simulator build, the iOS logic
tests, and a secret scan; all checks must pass to merge.
