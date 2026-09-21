# GrandTour

Location-aware audio platform: GPS-triggered narration ("the world speaks to
you through the tracks you choose") with human-guide-first content. This repo
is the first slice — shared schema, API server, admin web, iOS app, and an AI
narration pipeline. Product intent lives in [PRD.md](PRD.md); setup detail in
[README.md](README.md). The object model is in
[docs/object-model.md](docs/object-model.md); how content reaches players
(content repositories → site and bucket → any server → apps) is
[docs/distribution.md](docs/distribution.md), built by plan 016.

## Commands

> `filo` is a pinned GitHub dependency ([mrjf/filo](https://github.com/mrjf/filo));
> `bun install` needs no sibling checkout.

| Purpose | Command | Notes |
|---------|---------|-------|
| Install | `bun install` | repo root; installs all workspaces |
| Database | `docker compose up -d db` | PostGIS 16 on :5432 |
| Migrate | `bun run db:migrate` | applies `server/db/*.sql`, forward-only |
| Server | `bun run dev:server` | :8787; loads repo-root `.env` via `--env-file`. Also a GrandTour *server* in the distribution sense: `GET /grandtour.json` + `GET /tours/<slug>.grandtour.json`, live |
| Admin | `bun run dev:admin` | :5180; Vite proxies `/api` → :8787 |
| Viewer | `bun run dev:viewer` | :5190; proxies `/api`, `/uploads`, `/grandtour.json` and `/tours` → :8787, so its own origin is a server |
| Site | `bun run dev:site` | :5181; `bun run site:build` → `site/dist/`; `bun run site:deploy` (wrangler, root `.env`). `SITE_CONTENT_DIR` names the content checkout (default `../../content`) |
| Typecheck | `bun run typecheck` | all workspaces, must exit 0 |
| Tests (shared) | `cd packages/shared && bun test` | pure, no DB |
| Tests (server) | `cd server && PORT=8899 bun test` | DB-backed files need `grandtour_test` (see below). Pass a free `PORT` when the dev server holds 8787 — otherwise the test app fails to boot and ~80 tests cascade into `Cannot access 'app' before initialization` |
| Tests (iOS) | `cd ios && xcodebuild test -project GrandTour.xcodeproj -scheme GrandTourTests -destination 'platform=iOS Simulator,name=iPhone 17'` | logic-only bundle (SpotScheduler + journey sims + trigger/poll logic); needs no watchOS platform — the `GrandTour` scheme does (it embeds the watch app); run `xcodegen generate` first if project.yml changed |
| Parity (Swift ↔ TS) | `sh scripts/scheduler-parity/run.sh` (also `trigger-parity`, `locator-parity`, `area-parity`) | compiles the phone's logic with `swiftc`, generates golden cases, replays them through the TypeScript ports; each must print N/N — anything less is a bug, not tolerance |
| Test DB setup | `docker compose exec db psql -U postgres -c 'CREATE DATABASE grandtour_test'` then `cd server && DATABASE_URL=postgres://postgres:postgres@localhost:5432/grandtour_test bun run db/migrate.ts` | once per machine |
| iOS | `cd ios && xcodegen generate` then open `GrandTour.xcodeproj` | needs `brew install xcodegen` + full Xcode |
| Content export | `cd server && bun run content:export --out ../../content-private --extra scripts/data/going-to-the-sun-road.grandtour.json --prune --stamp` | writes every tour track (held ones marked private) as `grandtour.json` + `tours/<slug>.grandtour.json` into the private content repo; audio named by public content-addressed URL, not copied; bundles are compact JSON with only the `audio` and `sentence` tiers (`slimDocuments` — the word tier is 80 % of a bundle and no client reads it); deterministic; plan 016 |
| Content publish | `cd server && bun run content:publish --from ../../content-private --to ../../content --upload` | public tracks only → the public content repo (and `--site <dir>`), recordings and bundles uploaded to the `R2_*` bucket; then commit/push and deploy |
| Release console | `bun run release:console` → http://localhost:8791/release (or `RELEASE_CONSOLE=true` on the dev server → `/release`) | the maintainer's page: every track's ship state and its hold/release gate; needs `ADMIN_TOKEN`. Not part of the generic admin |

Env vars are documented in [.env.example](.env.example) (`DATABASE_URL`,
`ADMIN_TOKEN`, `ALLOWED_ORIGINS`, `ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY`,
`ELEVENLABS_VOICE_ID`, `EXA_API_KEY`, `GEOCODIO_API_KEY`, `STORAGE_*`,
`R2_*`, `RELEASE_CONSOLE`). The
real `.env` at the repo root is gitignored — never read, print, or commit it.

## Architecture

- `packages/shared` — zod schemas + types: geo, content model, filo wire
  shapes, API DTOs, text-index helpers. Both server and admin import it.
- `server` — Bun + Hono. Public API (`/api/nearby`, `/api/tracks`), admin
  CRUD (`/api/admin/*`, bearer-token auth), creator API (`/api/creator/*`,
  the phone's walk-and-record write path — unauthenticated on the
  assumption the server is private; see `src/routes/creator.ts` before any
  public deployment), audio serving (`/uploads/*` with
  Range support), AI pipeline (`src/ai/`), PostGIS queries (`src/geo/`).
  **The admin is generic** — authoring for anyone's server, meant to be
  open-sourced as such. What *GrandTour* publishes is decided on the
  maintainer's **release console** (`src/routes/release.ts`, served at
  `/release` only when `RELEASE_CONSOLE=true`): per-track ship state and
  the hold/release gate (`tracks.visibility`); export, publish and deploy
  stay commands. Keep publisher-only concerns there, not in the admin.
- `admin` — Vite + React + MapLibre authoring UI (map spots, edit/generate
  narration, publish). Track-first, URL-addressable: `/` chooses a track,
  `/:trackSlug` is that track's workspace, `/:trackSlug/:spotSlug` edits a
  spot (spot slugs are server-generated, per-track unique, stable).
- `site` — grandtour.fyi: a static landing page that is also a GrandTour
  server. `src/build.ts` renders `content/en.md`, places the web app build at
  `/app/`, and copies the published content checkout
  (`SITE_CONTENT_DIR`, the `gtfyi/content` repo by default) through
  `publicIndex` to `/grandtour.json` + `/tours/`. Deployed as Cloudflare
  Workers static assets; `_headers` opens CORS on the index and bundles.
  **The deployed site names its bundles at `data.grandtour.fyi/tours/`**
  (`SITE_BUNDLE_BASE_URL` in the deploy script; `content:publish --upload`
  puts them there beside the audio) because Workers assets stop at 25 MiB
  per file and History & Geography is past that; a local `site:build`
  without the variable copies bundles in, so the site is self-contained for
  previews. The phone frame on the landing page is the app itself at
  `/app/?simulate=<demo_track>`: the one web implementation, driving that
  track's route as a simulated trip.
- `packages/tour-viewer` — the web app (`AppView`), the one web
  implementation: `/app/` on the site, `/` on `bun run dev:viewer`. It is
  the phone app in a browser: several tracks at once, real GPS
  (`useGeolocation`), `computeNearby` as the client-side mirror of
  `findNearby`, `TourPlayback` running the phone's `decideWander` over the
  shared `SpotScheduler` port (`packages/shared/src/scheduler.ts`, with
  `narration.ts` and `activityMode.ts`) and a persistent `playHistory` with
  the phone's replay rules (6 h evergreen cooldown, series never
  auto-replay, play counts, 180-day retention), Media Session lock-screen
  controls, and a screen wake lock —
  iOS stops delivering location to a page once the screen locks, and there is
  no background mode to ask for. It **reads a server** (`src/server.ts`):
  any base URL that serves `grandtour.json` and the bundles it names —
  `?server=` for a visit, a saved choice, else the page's own origin (the site
  serves its own index; in development Vite proxies the authoring server's
  live one). `indexUrl` in `@grandtour/shared` maps `grandtour.fyi`,
  `github.com/org/repo` or `http://host:port` to the index; first-run track
  selection is by area cell (`tracksInAreas(index, areasAround(pos))`).
  The Tracks sheet's Server section is the phone's server list. No API is
  needed. `?at=lat,lng` stands somewhere without GPS (shown as "Simulated
  position"). A **demo** — the Tracks sheet's Demo button, on the web and
  on the phone alike, or `?simulate=<slug>` (optional `&mph=`) on the web —
  travels one track's route as a simulated trip (`src/simulate.ts`;
  `ios/Sources/DemoDrive.swift`): the bundle's authored `routePath`, else
  roads through every spot (nearest first, the public OSRM router, straight
  lines when it is unreachable), at a pace from the explicit activity mode
  or else the track's size (a village tour walks, a park road drives). A
  demo is the stories, not the miles between: the car keeps its pace but
  waits at the next stop while a story plays, and once the player has been
  idle for the story spacing it jumps to just before the next unheard stop
  and drives in (`demoStep`, line for line `DemoRoute.step` on the phone);
  Next jumps to the next stop at once; the next two stops' recordings are
  fetched ahead of their turn (`AudioPrefetch` on the web, the phone's
  `TourCache`) so a start is instant. Choosing a demo — the Tracks sheet's
  button or `?simulate=` — shows the whole tour on the smallest map that
  fits its points (ViewerMap's `fit`, built into the map's constructor for
  a `?simulate=` page so nothing flies in from the world; a region on the
  phone) with the car at its start, and waits for Start tour; Start zooms
  in on the car (zoom 15 driving / 17 walking; 1500 m / 500 m on the
  phone) and from then on the marker stays centered while the map scrolls
  underneath it, with a jump after a teleport,
  until a pan takes over, and the locate button brings it back. The web's
  traveler marker is always drawn; `following` is only the camera. The
  demo's track alone is on, the
  choice is not saved, its play history lives in memory so nothing counts
  as heard for real, the tour stops itself once the route is driven and
  the last story ends, and ending the demo restores what was on before.
  The landing page's phone frame is a demo, and its Fullscreen link is the
  same address (`{{frame}}` in `content/en.md`).
  `TourView` (one bundle as a simulated drive, with a scrubber and
  prev/next stop) survives only as the admin's Try-me-out preview
  (`admin/src/DriveMode.tsx`); it has no page of its own. Real GPS needs a
  secure context: `https://` or `localhost` — a tailnet IP over plain http
  will not get a fix on a phone.
  **The web app and the iOS app are meant to be as alike as possible**: the
  Tracks sheet is `TrackSheet` in `ios/Sources/ContentView.swift` section for
  section (full screen, "N of M tracks on", All on / All off, a switch and
  Only this track per row, Done), tapping a pin plays that story in the card
  below the map rather than opening anything, and manual taps always play.
  When the phone's behaviour changes, change the web app's to match.
- `ios` — SwiftUI app: CoreLocation → nearby → auto-play with a live
  highlighted transcript. A **server is a base URL** (`ServerPreference`:
  the build's own server if it names one, then `grandtour.fyi`, then
  user-added; `Distribution.indexURL` mirrors `indexUrl`). `GrandTourAPI`
  probes it once (`/health` → *live* authoring server with `/api/*`,
  fill-ins, manifests and recording; otherwise *static*: the index is the
  catalog, bundles are fetched for the enabled tracks in the area cells
  around the phone (`TourCache.ensureBundle`, evaluation-only snapshots
  whose audio streams until the user taps Download), and triggers are
  evaluated on the device). Audio URLs are absolute and never rewritten,
  except `localhost` ones cached from a dev server. What plays and when is specified in
  [docs/scheduler.md](docs/scheduler.md): two tour styles, **wander**
  (`SpotScheduler` predicts the path and targets the least-heard spot
  ahead — no queue, no pool) and **guided** (`GuidedTourPlanner`: one
  track as a walking tour with spoken directions). Project generated by XcodeGen. CarPlay scene
  with two experiences chosen at build time by `GRANDTOUR_CARPLAY_MODE`
  (`audio`, the default: `CarPlayAudioController` tab bar + system Now
  Playing, entitlement `carplay-audio`; `navigation`: `CarPlayController`
  map + turn-by-turn, entitlement `carplay-maps`) — the selected entitlement
  is required for device signing too. Apple approval and a matching profile
  are mandatory. `none` explicitly builds phone/system Now Playing only.
  **Demo** (`DemoDrive`, `TourViewModel.startDemo`/`endDemo`): the Tracks
  sheet's Demo button drives a track's route as a simulated trip — one
  synthetic fix a second through `locationDidUpdate(_:synthetic:)`, real
  fixes held aside meanwhile, an in-memory `PlayHistory`, the track alone
  enabled without persisting, no series completion — with the route and
  the car on the map and a banner to end it. `DemoRoute.step` is the
  driver (story to story; `skipDemoToNextStop` is Next), the web's
  `demoStep` line for line. The web app's Demo button is the same feature;
  keep the two alike. `GRANDTOUR_SILENT=1` (simulator
  launch env) mutes every output for headless runs on a shared machine.
  Check a device bundle with `scripts/check-carplay.py`; see
  [docs/carplay-device-readiness.md](docs/carplay-device-readiness.md).
  **CarPlay is planned, not complete**: both entitlements are pending
  Apple's grant and the experiences are simulator-verified only. Includes a
  standalone watchOS app (`ios/WatchSources`, target `GrandTourWatch`),
  **also planned, not complete**: its own GPS + `/nearby` loop + audio,
  sharing the pure logic files
  (Models/SpotScheduler/SpotLocator/TriggerEvaluator/…) by recompilation.
  It reads authoring servers only — it has no bundle store, so a static
  server gives it tracks but no spots; teaching it the phone's static path
  (fetch bundles for the cells around it, evaluate locally, keep spot
  geometry and one narration per spot rather than whole transcripts) is
  the open item.
  Watch audio adapts the ears invariant: same `.playback`/`.longFormAudio`,
  never deactivated, but activation is the async watchOS long-form flow
  (Bluetooth headphones only — the watch speaker can't play long-form), and
  the tour runs inside an HKWorkoutSession for background GPS (discarded on
  end, never saved to Health).
  **Walk and Record** (`RecordModeView` + `RecorderViewModel` +
  `RecordingEngine` + `CreatorAPI`): a separate creator mode — entering it
  stops the tour; the mic records via `AVAudioEngine`'s input tap (NOT
  `AVAudioRecorder` — its AudioQueue start deadlocks on the iOS 26
  simulator), the session swaps to `.playAndRecord` only while a take is
  open (`AudioSession.beginRecordSession`/`endRecordSession`), and saved
  takes save locally before any upload. `RecordingLibrary` atomically stores
  track identities, GPS metadata and upload receipts in
  `Documents/recordings/library.json`, beside the retained audio. It imports
  legacy sidecars; old takes without a server identity wait for a matching
  catalog track. `RecordingSync` retries on network/server changes, app
  activation and every 30 seconds while running. New local tracks bind to
  the selected authoring server before their first POST; existing queues
  never switch hosts. `/api/creator/capabilities` advertises durable retries;
  `clientId` on track/spot POSTs maps to transactional `creator_uploads`
  receipts (migration 009). The microphone is always available; static
  servers allow local creation and recording but cannot receive uploads.

Domain model: `Track ──< Spot ──< ContentPiece`. A Track is a named set of Spots; users can enable several at once. A Spot's trigger has a
**kind** that encodes scheduling semantics, not just geometry: `point`
(center + radius, optional precise polygon boundary — "you have arrived",
plays promptly with locating audio) or `area` (a polygon fence — playable
anywhere inside it, but only scheduled into narration gaps, ahead of
fill-ins; no locating, `distance_m` measured to the fence). A third kind,
`anywhere`, is reserved in the schema but rejected at write time. Area spots
are never a `SpotScheduler` target — `TourViewModel`'s gap planner owns
them. A Spot may carry a `sequence` `{key, index}`: parts sharing a key
within a track auto-play strictly in index order (client-enforced against
play history; a later part is held, not dropped, until earlier parts are
heard). A Track has a **lifecycle**: `evergreen` (replayable after cooldown,
freshness-ranked — the default) or `series` (podcast model: units never
auto-replay once heard; when all are heard the app records completion,
auto-disables the track, and offers re-enable/"start over").
`/api/track-manifest` serves each track's published narratable unit ids
(+ sequence slots) — sequence eligibility and completion math need the whole
track, which `/nearby` can't see. Attribution travels with content as a **`SourceRef`** (`@grandtour/shared`):
`{name, url?, description?, publisher?, license?, attribution?, date?,
retrievedAt?, clearance?}`. It is used for `provenance.sources` (works a
script drew on), `provenance.origin` (the work imported content *is*), and
the fill-in payloads' `source`. `clearance` is a **list** because rights
differ per asset — an NPS script can be federal work product while the audio
file it ships with blends in a third party's field recordings, so each entry
carries a `scope` of `all`/`text`/`audio` and a status of
`confirmed`/`probable`/`unclear`/`not-cleared`. A `license` string records a
claim; `clearance` records that someone verified it. Legacy `{title, url}`
entries still parse — `title` is read as `name` — so the rows written before
this shape stay valid. A ContentPiece's
text is a **filo document**: immutable text addressed by UTF-8 byte offsets,
with annotation tiers; the `audio` tier maps time ranges to byte ranges —
that shared coordinate system drives spoken-text highlighting everywhere.
A Track with `kind: "fillin"` holds `FillInItem`s instead of Spots — content
with **no geometry** (vocab practice, etc.) that iOS inserts when narration
has been silent past a threshold; such tracks never appear in `/nearby` or
`/route-nearby`, and their items are served by `/api/fillin-items`
(see plans/014-fillin-content.md).

## Invariants

- **Sheriff's calls are plain readings: date, town, original report.** No
  introduction, added explanation, editorializing, jokes, or conclusion.
  Keep source attribution in provenance, out of the spoken text. When a
  spot contains multiple calls, repeat date, town, report for each call.
  Editing these scripts requires replacing their recordings as well.
- **Never count UTF-8 bytes by UTF-16 code units.** Convert byte offsets to
  string indices only via `byteToStringIndex` (`@grandtour/shared`) in TS or
  `TranscriptView.stringRange` in Swift. Emoji broke this once already.
- **The public API only serves published content from public tracks.**
  `/nearby` filters `status='published'` for both spots and content; anything
  admin-shaped belongs under `/api/admin/*` behind the token middleware.
  `tracks.visibility` is a second, orthogonal gate: `private` withholds a
  whole track from every public surface without touching a single spot or
  content status, so a finished track can be held back and released later by
  one flip instead of a reconstruction. Editorial readiness is `status`;
  release gating is `visibility` — never overload one for the other. The gate
  must be applied in **every** public surface, and they must agree:
  `findNearby`, `nearbyDataVersion` (or the `unchanged` poll gate lies),
  the route-corridor query, `listTracks`, `listTrackManifests`,
  `listFillInItems`, and `/api/tracks/:id/bundle`. Admin surfaces and
  `exportTrack` deliberately ignore it — a held track must stay fully visible
  and editable to its author. A held row must carry `hold_reason` and
  `held_at` (a DB check enforces it), so it can always explain itself.
  The distribution files are public surfaces too: the live index
  (`buildIndexFromDb`) goes through `listTracks(sql)`, `content:export`
  marks held tracks `visibility: "private"`, and `content:publish` and the
  site build drop them through `publicIndex` — a held track never reaches a
  public server.
- **PostGIS owns geo math on the authoring server.** `GEOGRAPHY` +
  `ST_DWithin`/`ST_Covers` with GiST indexes (see README "Geo: why PostGIS")
  for `findNearby`, the route corridor and locating bearings. Players
  evaluate triggers on the device against a static server, with the
  parity-tested evaluators below. **Tour logic measures distance with one
  function**: `Geo.localDistanceM` on iOS and `localDistanceM` in
  `@grandtour/shared` — the same arithmetic, the flat-ellipsoid distance at
  the observer's latitude. Never call `CLLocation.distance(from:)` from
  scheduling or trigger code: it is not a pure function of its two points
  (a cached local projection; the same pair measures differently by ~1e-5
  depending on earlier calls), which made golden parity impossible until it
  was replaced. `haversineM` stays for the locator (the phone's
  `SpotLocator` is spherical too) and for display; nothing else may grow
  its own distance.
- **The scheduler is one program in two languages.**
  `ios/Sources/SpotScheduler.swift` is canonical; `packages/shared/src/scheduler.ts`
  is its line-for-line port (with `narration.ts`, `activityMode.ts`, and
  the test-side `JourneySimulator`), and `TourPlayback` runs it the way
  `TourViewModel.decideWander` does. Change both sides together and run
  `scripts/scheduler-parity/run.sh`: it compiles the phone's scheduler,
  generates 3500 golden decisions and journeys, and replays them through
  the port. Anything under 100 % is a bug.
- **Trigger-kind evaluation lives in three places** and they must agree:
  `findNearby` in `server/src/geo/queries.ts` (whose range predicate must
  also stay identical to `nearbyDataVersion`'s, or the `unchanged` gate
  lies), `TriggerEvaluator.reevaluate` on-device (the phone's
  `unchanged`-poll path, `TourCache.offlineNearby` — which is the whole path
  against a static server — and the watch), and `computeNearby` in
  `packages/tour-viewer/src/nearby.ts` for the web app —
  `scripts/trigger-parity/run.sh` replays the web's cases through the
  phone's evaluator and must stay green. An area
  spot triggers by fence containment only — its `center` is a map/sort
  anchor (fence centroid, server-computed), never trigger math.
- **AI generation stays location-anchored.** reverse-geocode → anchored
  search → source vetting → **refuse** when nothing vets. Never remove the
  refusal path; misaligned TTS output must throw, not save. Fill-in modules
  (`src/ai/fillin/` — vocab and quiz) are a deliberate, separate exception:
  they make no place claims, so they have no vetting step (their guard is
  the payload's `source`; for quiz, the Wikidata queries in
  `server/scripts/build-geoquiz.ts` are template-generated with no LLM) and save
  audio **without** an alignment tier on purpose — the SSML pause makes
  provider char timing unmappable to the display text. Don't route them
  through the location pipeline or weaken that pipeline for them.
- **Where-to-look lives in `spot.locating`, never in the narration.** The
  narration script is side-free (the drafting prompt enforces it). Locating
  templates may contain `{{side}}` (`SIDE_TOKEN` in `@grandtour/shared`);
  TTS renders only tiny left/right (or fixed) clips via
  `generateLocatingClips` — never re-synthesize the narration for direction
  changes. `/nearby` resolves the side from `courseDeg` vs the spot's
  PostGIS `ST_Azimuth` bearing and returns `locating: {text, audioUrl}`;
  a directional template with no known course resolves to null, never a
  guessed side. iOS queues the clip before the narration (AVQueuePlayer).
- **GrandTour owns the ears.** The app is a normal, primary audio app:
  plain non-mixable `.playback`, mode `.default`, routing policy
  `.longFormAudio`, claimed by `AudioSession.takeOver()` at launch, on
  CarPlay connection, and before every play, and held full-time — other audio pauses and the
  session is never deactivated between spots or on pause/stop. Don't
  reintroduce `.duckOthers`/`.mixWithOthers`-style options, duck-and-yield
  behavior, or mode `.spokenAudio`: both the mixable "prompt" path and
  spoken-audio-mode streams get gated/chopped by CarPlay and Bluetooth
  head units (field-verified); `.longFormAudio` rides the car's media lane
  like a podcast app. `setCategory` runs once; only re-activation is
  repeated (it's idempotent). This is the user's explicit full-takeover
  preference: Bluetooth compatibility must preserve this ownership policy.
  Never send `notifyOthersOnDeactivation`. Keep GrandTour's Now Playing
  metadata and Play command when the tour is off as well. iOS retains
  authority over calls/system interruptions; do not promise an OS-proof lock.
  **Keepalive is experimental and defaults
  off** (`carAudioKeepaliveEnabledV2`). The earlier continuous second-player
  mitigation was never proven to fix the reported wireless CarPlay cutouts.
  Leave it opt-in until tested on the affected car. When enabled,
  `AudioKeepalive` loops near-silence (−96 dBFS dither) while the tour is on
  and the route is Bluetooth/CarPlay/AirPlay/USB. Do not infer audible
  playback from an advancing player clock. `AudioPlayer` observes route changes (parks on
  `oldDeviceUnavailable`, resumes when a route returns), treats a
  system-cancelled utterance as finished, and measures speech progress by
  spoken ranges, not `isSpeaking`. Every route change, interruption,
  keepalive transition and non-finish stop is logged to `TourDiagnostics`
  (`bun run diag <file>` prints them under AUDIO) — keep it that way; the
  dropout hunt was blind without them. **The journal never leaves the
  phone.** It holds a GPS trace, so it stays in the app's Caches
  (`tour-diag.jsonl`, one event per line, newest 20 000 kept) for a
  developer to pull off the device and replay; the upload to
  `/api/diag/logs` was removed on 2026-09-21 because it sent every fix to
  whatever server was selected, static ones included, and it must not come
  back in any form. Against a static server the app sends nothing but
  requests for files.
- **GrandTour is the system Now Playing app.** `NowPlayingController`
  publishes `MPNowPlayingInfoCenter` on state changes only (never from the
  20 Hz time observer — head units glitch on high-rate metadata) and owns
  the `MPRemoteCommandCenter` handlers: a tour is not a playlist, so
  play/pause while idle start/stop the tour, next = skip, previous =
  replay. This needs no CarPlay entitlement and is what the car screen and
  steering wheel drive; the CarPlay templates reuse its actions.

## Conventions

- Strict TS, 2-space indent; zod `safeParse` at route boundaries returning
  `{ error, detail }` JSON with proper status codes.
- Repo functions (`server/src/content/repo.ts`) take `sql` as first arg and
  return mapped DTOs; routes never touch rows directly.
- Plain `console.*` logging; no logging framework.
- Tests are bun:test. Server tests that need the DB import
  `tests/helpers.ts` (seed builders + truncation guard); the pool is pointed
  at `grandtour_test` by `tests/preload.ts` — keep DB access out of the
  pure test files.
- No ESLint/Prettier yet (deliberate — see `plans/README.md`).

## Plans

`plans/` holds executor-ready implementation plans with status tracked in
[plans/README.md](plans/README.md) — read it before starting work there.
