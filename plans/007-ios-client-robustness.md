# Plan 007: iOS client robustness — configurable base URL, honest HTTP errors, no overlapping polls

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat $(grep -oE '[0-9a-f]{7,}' <(grep "Baseline commit" plans/README.md))..HEAD -- ios/Sources ios/project.yml`
> If any in-scope file changed since the baseline, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-vcs-baseline.md
- **Category**: bug
- **Planned at**: baseline commit from plan 001, 2026-07-05

## Why this matters

Three small defects make the iOS app dev-only and flaky on real networks:
(1) the API base URL is hardcoded to `http://localhost:8787`, so any build
not running against a simulator-local server silently fails; (2) `layers()`
decodes the response without checking the HTTP status, so a server error
surfaces as a cryptic `DecodingError` instead of a clear message; (3) the
`/nearby` poll is throttled by timestamp only — a response slower than the
4s window lets a second request start, and the slower (older) response can
overwrite the newer one, briefly showing stale spots and potentially
auto-playing from stale trigger state.

## Current state

- `ios/Sources/GrandTourAPI.swift` — the whole client (42 lines):
  - Line 7: `init(baseURL: URL = URL(string: "http://localhost:8787")!)`.
  - Lines 29–33 (`nearby`): guards `http.statusCode == 200`, throws
    `URLError(.badServerResponse)` — this is the convention to replicate.
  - Lines 36–41 (`layers`): `let (data, _) = try await URLSession.shared.data(from: url)`
    — status ignored.
- `ios/Sources/TourViewModel.swift` — `@MainActor` ObservableObject.
  Lines 38–54:

```swift
    func locationDidUpdate(_ loc: CLLocation) async {
        guard Date().timeIntervalSince(lastFetchAt) > 4 else { return }
        lastFetchAt = Date()
        do {
            let spots = try await api.nearby( ... )
            nearby = spots
            autoPlayIfTriggered()
        } catch { ... }
    }
```

  `private let api = GrandTourAPI()` at line 15 — the only construction site.
- `ios/Sources/GrandTourApp.swift` — 10-line `@main` App struct, plain
  `ContentView()`.
- `ios/project.yml` — XcodeGen spec; the project is generated with
  `xcodegen generate`. Read it before editing to see how Info.plist keys are
  declared (XcodeGen supports an `info:` block with `properties:`).
- Convention: no logging framework, no DI container — keep it that way.

## Commands you will need

| Purpose  | Command | Expected on success |
|----------|---------|---------------------|
| Regenerate project | `cd ios && xcodegen generate` | writes GrandTour.xcodeproj |
| Build | `cd ios && xcodebuild -project GrandTour.xcodeproj -scheme GrandTour -destination 'generic/platform=iOS Simulator' build` | BUILD SUCCEEDED |

If `xcodegen` or full Xcode is not installed, see STOP conditions.

## Scope

**In scope** (the only files you should modify):
- `ios/Sources/GrandTourAPI.swift`
- `ios/Sources/TourViewModel.swift`
- `ios/project.yml` (Info.plist key only)

**Out of scope** (do NOT touch):
- `AudioPlayer.swift`, `TranscriptView.swift` (plan 005 touches the latter),
  `LocationManager.swift`, `ContentView.swift`, `Models.swift`.
- Background-location entitlements, push, offline caching — separate work.
- Adding an XCTest target — desirable but a larger lift; deferred (see
  Maintenance notes).

## Git workflow

- Branch: `advisor/007-ios-client-robustness` off `main`.
- Commit per step, e.g. `Read API base URL from Info.plist`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Base URL from Info.plist with localhost fallback

In `ios/project.yml`, add an Info.plist property for the target (key
`GrandTourAPIBaseURL`, value `http://localhost:8787`) using XcodeGen's
`info.properties` mechanism — match the file's existing structure.

In `GrandTourAPI.swift`, replace the hardcoded default:

```swift
    init(baseURL: URL? = nil) {
        if let baseURL {
            self.baseURL = baseURL
        } else if let s = Bundle.main.object(forInfoDictionaryKey: "GrandTourAPIBaseURL") as? String,
                  let u = URL(string: s) {
            self.baseURL = u
        } else {
            self.baseURL = URL(string: "http://localhost:8787")!
        }
    }
```

Dev behavior is unchanged (same default); prod builds set the key.

**Verify**: `cd ios && xcodegen generate` succeeds; the generated
`GrandTour.xcodeproj` contains the key (`grep -r "GrandTourAPIBaseURL" ios/ --include='*.pbxproj' --include='*.plist' -l` → at least one match, or verify via the build in Step 3).

### Step 2: Status check in layers(); serialized polling in the view model

2a. In `GrandTourAPI.swift` `layers()`, mirror the `nearby()` guard exactly:
capture the response, `guard let http = resp as? HTTPURLResponse,
http.statusCode == 200 else { throw URLError(.badServerResponse) }`.

2b. In `TourViewModel.swift`, add `private var isFetching = false` and make
the poll single-flight and stale-proof:

```swift
    func locationDidUpdate(_ loc: CLLocation) async {
        guard !isFetching, Date().timeIntervalSince(lastFetchAt) > 4 else { return }
        isFetching = true
        lastFetchAt = Date()
        defer { isFetching = false }
        do {
            let spots = try await api.nearby( ... unchanged args ... )
            nearby = spots
            autoPlayIfTriggered()
        } catch {
            self.error = "Nearby fetch failed: \(error.localizedDescription)"
        }
    }
```

The class is `@MainActor`, so the flag is data-race-free; the guard makes
overlapping requests (and therefore out-of-order overwrites) impossible.

**Verify**: visual diff — `layers()` and `nearby()` now have identical
response-guard shapes; `locationDidUpdate` contains `guard !isFetching`.

### Step 3: Build

`cd ios && xcodegen generate && xcodebuild -project GrandTour.xcodeproj -scheme GrandTour -destination 'generic/platform=iOS Simulator' build`

**Verify**: `BUILD SUCCEEDED`.

## Test plan

No XCTest target exists and creating one is out of scope (deferred). The
verification gate is the simulator build plus, if a simulator and running
server are available, a manual smoke: launch the app, confirm layers load
and no behavioral change in the happy path.

## Done criteria

- [ ] `xcodebuild ... build` → BUILD SUCCEEDED (or the STOP condition about
      missing Xcode was reported instead)
- [ ] `grep -n "localhost:8787" ios/Sources/GrandTourAPI.swift` → appears
      only in the fallback branch (1 match)
- [ ] `layers()` contains an `HTTPURLResponse`/`statusCode == 200` guard
- [ ] `TourViewModel` contains the `isFetching` single-flight guard
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `xcodegen` or Xcode command-line tooling is not installed — make the
  Swift/YAML edits anyway, then report "changes made, build unverified —
  requires a machine with Xcode" rather than skipping or hacking around it.
- `project.yml`'s structure has no obvious place for Info.plist properties
  (i.e. it uses a checked-in Info.plist file instead) — put the key in that
  plist file instead and note the deviation.
- The build fails for reasons unrelated to your diff (pre-existing breakage)
  — report; do not fix unrelated build errors.

## Maintenance notes

- Deferred deliberately: an XCTest target (the view model is now
  single-flight and would be easy to test with a protocol-mocked API — do
  that when the first test target lands), retry/backoff on poll failures,
  and sending the device locale to `/nearby` (blocked on plan 009's server
  support; add `locale` to `nearby()`'s query items when 009 lands).
- Reviewer should scrutinize: the `defer` placement in `locationDidUpdate`
  (must reset `isFetching` on both success and throw paths).
