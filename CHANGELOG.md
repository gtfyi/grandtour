# Changelog

## Unreleased

- The phone no longer uploads its field diagnostics. `TourDiagnostics` used
  to POST every GPS fix, trigger verdict and playback event to the selected
  server's `/api/diag/logs` for the whole of every tour — static servers
  included, where it only 404ed — with no setting and no debug gate. The
  journal now stays in the app's Caches (`tour-diag.jsonl`, one event per
  line, the newest 20 000 kept); pull it off the device and replay it with
  `bun run diag <file>`. Against a static server such as grandtour.fyi the
  app now sends nothing but requests for files.

- Offline Walk and Record: create tracks and save recordings immediately on
  the phone, even with no server or a read-only server selected. Local audio,
  GPS metadata and track selection survive restarts. Uploads resume on
  reconnect, server selection and foregrounding; each queue stays bound to
  its destination once uploading starts. Stable upload IDs and transactional
  server receipts prevent duplicate tracks or spots after lost responses.
  Uploaded recordings remain available for local preview. Requires database
  migration `009_creator_uploads.sql` on authoring servers.

- Demo, on the web and on the phone: every track in the Tracks sheet has a
  Demo button that plots a course through all its spots — the bundle's
  authored `routePath`, else roads through them from the public OSRM
  router, else straight lines — and drives it for you, the same scheduler
  starting the stories as the car reaches them, at a pace from the
  activity mode or the track's size. A demo is the stories, not the miles
  between them: the car waits at the next stop while one plays, and after
  the story spacing jumps to just before the next unheard stop and drives
  in; Next jumps to the next stop at once, and the next two stops'
  recordings are fetched ahead so it starts instantly. The web's
  you-are-here marker is always drawn now — it used to vanish on any map
  click or drag. The demo's track alone is on, the
  choice is not saved, its play history lives in memory (nothing counts as
  heard for real, no series completes), the tour stops itself once the
  route is driven and the last story ends, and End demo restores what was
  on before. On the phone the car's fixes go through the tour's own
  location path with real GPS held aside; the route and the car are drawn
  on the map (`DemoDrive`). On the web `?simulate=<slug>` (`&mph=` to set
  the pace) opens the page in a demo and the URL follows the demo. On both
  apps a demo opens on the smallest map around its spots with the car at
  the start of the route — no flight in from the world — whether the page
  opened in it or it was chosen from the Tracks sheet, which turns every
  other track off; Start tour sets off, the map zooms in on the car, and
  from then on the marker stays centered while the map scrolls, until a
  pan takes over and the locate button hands it back. Web following uses
  continuous camera animation so map tiles move smoothly between pixels.

- One web implementation. The landing page's phone frame is the app itself
  (`/app/?simulate=<demo_track>`), a demo of that track, and the page's
  Fullscreen link opens the same demo in the whole window. The viewer face is
  gone from the web: no `/tour/` on the site, no catalog page, no
  `embed=1`. `TourView` survives only as the admin's Try-me-out preview.
  Any page can embed `/app/?simulate=…` the way the site does.

- First publication (2026-09-20): `gtfyi/content` carries 12 tracks — the
  five Marin topic tracks (History & Geography, Parks and Trails, Shops and
  Restaurants, Real Estate, News, with the Marin route tracks folded into
  them), six National Park Service tours and Going-to-the-Sun Road — under
  MIT for GrandTour's own text and recordings, with third-party terms per
  piece in `provenance.origin`. Unvoiced spots are unpublished, every spot
  plays in any mode, and each change is logged in `curation_log` (plan 017).
  The deployed site names its bundles at `data.grandtour.fyi/tours/`
  (`content:publish --upload` puts them there beside the audio): Cloudflare
  Workers static assets stop at 25 MiB per file and the History bundle is
  past that. The server gains the maintainer's release console at
  `/release` (`RELEASE_CONSOLE=true`): every track's ship state and its
  hold/release gate, kept out of the generic admin on purpose. Bundles
  are now the distribution cut of a document — the `audio` and `sentence`
  tiers, compact JSON — which takes History & Geography from 28 MB to about
  2.5 MB; the word tier was four fifths of it and no player reads it.

- The web app decides like the phone. `SpotScheduler` — what starts, when,
  and what "Up next" is — is ported line for line to `@grandtour/shared`
  (`scheduler.ts`, with `narration.ts` for durations and `activityMode.ts`
  for walking/driving inference), and `TourPlayback` now runs the phone's
  `decideWander`: lead windows before arrival, fillers that fit before a
  fresh target, the gap planner's ambient order (unheard, longest-forgotten,
  most specific fence), play counts and the phone's 180-day history
  retention, a poll between fixes, and a Travel setting (automatic, or an
  explicit mode). `scripts/scheduler-parity` replays the phone's golden
  decisions and simulated journeys through the port: 3500 cases (3472
  decisions, 16 journeys, 12 repeated-town visits) match exactly. Getting
  there exposed that `CLLocation.distance(from:)` is not a pure function of
  its two points — it measures with a cached local projection and drifts
  about 1e-5 with call history — so tour logic on every platform now
  measures with one explicit formula, the flat-ellipsoid distance at the
  observer's latitude (`Geo.localDistanceM` on iOS, `localDistanceM` in
  shared), which is what CoreLocation computes when its cache is fresh.
  Web triggers measure with it too.

- The web app follows the phone's scheduling defaults: a 3-second pause
  after a story (the phone's options, an old 15 s choice upgraded), arrivals
  before ambient area stories (an area you stand inside no longer outranks a
  point you just reached), ambient stories in the phone's order (unheard
  first, most specific fence), and a sequence's later parts held until the
  earlier parts are heard. Area-spot distance reads 0 inside the fence, as
  on the phone; `scripts/trigger-parity` pins the two evaluators together
  (396 cases). Per-track one-off scripts moved to `server/scripts/tracks/`.

- The site lives in the monorepo as `site/` and is itself a GrandTour
  server: its build takes the viewer build and a content checkout and
  serves `grandtour.json` + `tours/` beside the landing page and the app.
  The vendoring scripts, the deploy guard, the phone-testing scripts, the
  SVG demo with its generated audio, and the French locale are gone; the
  phone frame on the landing page plays a published track (`demo_track` in
  `content/en.md`).

- Both apps read any GrandTour server. The web app and viewer take
  `?server=`, a saved choice (Tracks → Server), or the page's own origin;
  the phone's server list gains `grandtour.fyi` as the conventional entry and
  accepts a site, a GitHub repository or an http(s) address. The phone
  probes a server once: an authoring server keeps the live API; a static
  one (the site, a repository) is read through its index, with bundles
  fetched for the enabled tracks in the area cells around the phone and
  triggers evaluated on the device. Recording needs an authoring server.
  The authoring server now serves its own recordings from the host each
  request arrived at, so clients no longer rewrite audio hosts (which broke
  externally hosted clips). The viewer's fill-in browser and the static
  `catalog.json` export are gone.

- Static distribution (plan 016): a GrandTour *server* is now any base URL
  that serves `grandtour.json` (an index of tracks with their bundle URLs)
  and the bundles it points to — a website, a GitHub repository served raw,
  or the authoring server, which serves the same files live at
  `/grandtour.json` and `/tours/<slug>.grandtour.json`. `@grandtour/shared`
  gains **areas** (geohash cells a client computes from its own position, so
  no coordinate leaves the device) and the **index** objects and builders
  (`indexUrl`, `summarizeTrack`, `buildIndex`, `publicIndex`,
  `tracksInAreas`). `bun run content:export` writes the private content
  repository (every track, held ones marked, audio named by public
  content-addressed URL); `bun run content:publish` carries public tracks
  to the public repository and the site and uploads their recordings to the
  bucket. `TrackExport` carries a `formatVersion`. Swift mirror `AreaId`
  with a golden parity check. Object model in `docs/object-model.md`.

- iOS build 2026.9.13 makes automatic narration more eager: the default
  pause drops from 15 to 3 seconds, unheard arrivals take priority over
  farther targets, and passing a point's center no longer discards it while
  still inside its trigger. Known triggers are evaluated on each GPS fix
  without waiting for the server. Area stories start without an initial
  delay and shorter candidates can fill gaps that longer ones cannot.

- Narration now defaults to **Server audio only**, including on upgrade.
  Missing recordings and failed downloads never fall back to device speech;
  dynamic locating and guided speech are muted too. Unvoiced stories are
  excluded from automatic playback. The previous fallback and device-only
  options remain available on iPhone and Apple Watch.

- iOS build 2026.9.12: newer nearby recordings take precedence over older
  downloaded track snapshots, including after relaunch. Re-downloading a
  track still supersedes older nearby responses. This prevents new voices
  from reverting to device speech during offline GPS evaluation.

- iOS: the activity mode is now persisted and defaults to **Auto**, which
  infers walking vs driving from sustained GPS speed (`ActivityModeDetector`,
  with hysteresis so a red light doesn't flip a driver back to walking). The
  mode filters `/nearby` server-side, and the old unpersisted "walking"
  default hid every driving-only spot for a whole afternoon's drive — 12k
  polls, 0 spots, nothing played. An empty list now says why (a mode-free
  probe: "N stories within 2 km are hidden by Walking mode", or which other
  tracks have stories here) instead of "Looking for stories nearby…", and
  diagnostics log the mode and enabled tracks (`tour_config`, `mode_changed`,
  `empty_nearby_probe`, and on every `fetch_ok`) so `bun run diag` can name
  this in one line.

- Walk and Record (PRD flagship): a creator mode in the iOS app, fully
  separate from touring. Pick or create a track, tap record, narrate where
  you stand, name the take (reverse-geocode suggested), listen back, and
  save — the spot publishes at the recorded GPS fix with the voice take as
  human-source content, playable on the very next `/nearby` poll. Takes
  recorded in dead zones queue on the phone ("On this phone only") and
  upload on demand; fumbled takes and spots can be deleted in place. New
  unauthenticated `/api/creator/*` endpoints (private-server assumption:
  create track, create spot from multipart audio + capture metadata, list,
  delete), `CreatorTrackInput`/`CreatorSpotMeta` shared schemas, and a
  `capture` block (course/speed/altitude/accuracy/time) on
  `GenerationProvenance`. Capture uses `AVAudioEngine`'s input tap (AAC
  via `AVAudioFile`) — `AVAudioRecorder`'s AudioQueue path deadlocks on
  the iOS 26 simulator — and the audio session swaps to `.playAndRecord`
  only while a take is open, restoring the full-time playback claim after.

- iOS build 2026.9.8: add a per-track Download button with verified progress,
  retry, and persistent offline snapshots of all published stories and audio.
  Whole-track bundles include uncapped fill-in content. Offline launch loads
  saved tracks immediately, and GPS trigger checks no longer wait for a
  network timeout when a downloaded track is available.
- iOS build 2026.9.7: preserve audio focus across gaps between stories, park
  narration after failed activation, retain explicit pauses through Siri and
  route changes, reject stale speech callbacks, and recreate speech after a
  media-services reset. Added 16 audio regression tests and richer route,
  activation-error, and player-state diagnostics. Tracks now has a reversible
  car-keepalive comparison control. Continuous wireless CarPlay chopping
  remains under investigation; see `docs/car-audio-diagnosis-2026-09-07.md`.
- iOS: add a mitigation for suspected audio-route idle delays. A
  route-gated near-silent keepalive (`AudioKeepalive`) runs by default for the
  whole tour on Bluetooth/CarPlay/AirPlay/USB routes. The player also
  handles route loss (park, resume when a route returns), media-server
  resets, system-cancelled speech, and detects wedged on-device speech by
  spoken-range progress instead of `isSpeaking`.
- iOS: GrandTour is now the system Now Playing app (`NowPlayingController`):
  lock screen, Control Center, CarPlay Now Playing and head-unit displays
  show the spot and track; steering-wheel play/pause/next/previous map to
  resume-or-start-tour, pause-or-stop-tour, skip, replay.
- iOS: CarPlay audio-app experience (`CarPlayAudioController`): Tour /
  Nearby / Tracks tabs and Now Playing buttons, selected by
  `GRANDTOUR_CARPLAY_MODE=audio` (default); the map/turn-by-turn scene
  remains available as `navigation`. Both CarPlay entitlements are still
  simulator-only pending Apple's grant.
- iOS: field diagnostics now record the audio route at tour start, every
  route change, interruption (with reason), keepalive transition, remote
  command, and the reason for every non-finish stop; `bun run diag`
  prints them under AUDIO.
- iOS: `GRANDTOUR_AUTOSTART_TOUR=1` and `GRANDTOUR_FORCE_KEEPALIVE=1`
  simulator launch switches for headless testing.

## 0.1.0 — 2026-09-02

First public release. A working slice of the platform, built and
field-tested around Fairfax, California.

- Shared zod schemas for tracks, spots, content, and the filo wire format.
- Bun + Hono API: `/api/nearby` and `/api/route-nearby` with course-aware
  "on your left" locating, track manifests, fill-in items, Range-capable
  audio serving, bearer-token admin CRUD, PostGIS geo queries.
- Trigger kinds: `point` (center + radius, optional polygon) and `area`
  (polygon fence scheduled into narration gaps).
- AI narration pipeline: reverse-geocode, anchored search, source vetting,
  scripted draft, ElevenLabs TTS with byte-aligned transcript timing, and a
  refusal path when nothing vets.
- Fill-in content with no geometry (vocabulary, geography quiz) for silent
  stretches.
- Admin web: MapLibre authoring, track workspaces, drive simulation,
  narration generation and publish.
- iOS app: CoreLocation polling, auto-play with live transcript
  highlighting, offline cache, play history, series/evergreen track
  lifecycles, CarPlay scene.
- watchOS app: standalone GPS + `/nearby` loop running inside a workout
  session, Bluetooth audio.
- Scripts: spot slate import, voiceover generation, simulator walkthroughs,
  field diagnostics replay.
