Everything here is written by bots, mainly for bots. Visit [grandtour.fyi](https://grandtour.fyi/) for the human version.

__

# GrandTour

GPS-triggered audio guide. Pick tracks; places narrate themselves as you
move through them.

**Status: pre-1.0.** It works end to end and is driven daily, but the
schema, API, and app are still changing without deprecation periods. The
bundled tracks under `server/scripts/data/` are example content, all in
Marin County, California; author your own with the admin or the import
scripts.

<img src="docs/app-screenshot.png" width="320" align="right" alt="GrandTour iOS app: map of Fairfax with story pins and a spot's transcript sheet">

**How it works.** A Track is a themed set of Spots. A Spot is a geo trigger:
center + radius, optional polygon. A ContentPiece is one narration — text plus
aligned audio. The text is a [filo](https://github.com/mrjf/filo) document:
immutable text addressed by UTF-8 byte offsets, with an `audio` tier mapping
time ranges to byte ranges. That one coordinate system drives live spoken-text
highlighting everywhere.

The apps read a **server**: any base URL that serves `grandtour.json` and
the track bundles it names — grandtour.fyi by default, a GitHub repository,
or your own machine (see [docs/distribution.md](docs/distribution.md)). The
phone fetches the bundles for the tracks around it, evaluates triggers on
the device, auto-plays spots as you enter them, and never sends your
position anywhere. Against the authoring server it also gets "on your left"
resolved from your heading and fill-in content for silent stretches.
**Walk and Record works offline:** tap the microphone, create a track, and
save recordings with their GPS locations on the phone. Tracks and audio
survive restarts. Choose an authoring server from **Record → Server**;
uploads resume automatically while GrandTour is running or when you reopen
it. Recordings remain on the phone for offline listening after upload.
GrandTour takes
exclusive media-audio ownership at launch and on CarPlay connection, holds it
between stories and on pause/stop, and never deliberately hands it back to other
apps. GrandTour stays in Now Playing with Play available when the tour is off.
iOS still controls higher-priority interruptions such as calls.

On iPhone, open **Tracks** and tap **Download** beside a track to save its
entire published set of stories, trigger locations, text, and available audio.
The **Downloaded** checkmark appears only after all files and metadata are
saved; failed downloads offer **Retry download** and keep successful files.
Tap **Downloaded** again to refresh the saved track. Saved tracks survive app
restarts and work without service. **Server audio only** is the default,
including on upgrade: missing recordings stay silent, with no device-spoken
narration or directions. **Tracks → Narration voice** also offers explicit
on-device fallback and device-only options. Downloaded locations are checked immediately against
GPS while online refreshes run separately.

**Stack.** Bun + Hono + PostGIS server; Vite + React + MapLibre admin;
SwiftUI iOS app; zod schemas shared end to end. AI narration pipeline:
anchored web search → source vetting → Claude drafts a spoken script →
ElevenLabs TTS with char-level timestamps → byte-aligned audio tier. No vetted
sources → no narration; it refuses rather than invents.

## Run it

```sh
docker compose up -d db          # PostGIS on :5432
cp .env.example .env             # AI keys optional; core serving works without
bun install
bun run db:migrate
bun run dev:server               # API on :8787
bun run dev:admin                # authoring UI on :5180
```

Web app: with the API running, `bun run dev:viewer` serves it on
<http://localhost:5190> (`/app/` on the site). Its own origin is a GrandTour
**server** — any base URL that serves `grandtour.json` and the bundles it
names — because Vite proxies the API's live index and bundles. It is the
phone app in a browser: several tracks at once, real GPS, a live transcript,
and a Tracks sheet with a Server section. `?server=grandtour.fyi`,
`?server=github.com/gtfyi/content` or `?server=http://host:8787` reads
another server, and `?at=lat,lng` stands somewhere without GPS. **Demo**,
on any track in the Tracks sheet (the phone has the same button), drives that
track's route as a simulated trip, the stories starting as the car reaches
them; `?simulate=<track slug>` (with `&mph=25` to set the pace) opens the
page in one. `bun run dev` starts the database, migrations, API, admin, and
web app together.

In authoring, **Try me out** opens `TourView`, a preview of one track as a
simulated drive with a scrubber and prev/next stop. The landing site's phone
frame is the app itself driving the demo track, and any page can embed the
same:

```html
<iframe
  title="Going-to-the-Sun Road"
  src="https://grandtour.fyi/app/?simulate=going-to-the-sun-road-audio-tour"
  allow="autoplay"
  style="display:block;width:100%;max-width:420px;aspect-ratio:1/2;border:0;border-radius:16px"
></iframe>
```

The site: `bun run dev:site` builds and serves grandtour.fyi on
<http://localhost:5181>, `bun run site:build` writes `site/dist/`, and
`bun run site:deploy` ships it with wrangler (credentials in the root
`.env`). The build takes the viewer build and a checkout of the published
content — `SITE_CONTENT_DIR`, the `gtfyi/content` repository by default —
and serves that content next to the pages, so the site is the default server
every app reads. Content itself comes from the authoring database:
`bun run content:export` writes the private content repository and
`bun run content:publish` carries public tracks to the public one, the site
and the audio bucket (see plan 016).

iOS: `brew install xcodegen`, then `cd ios && xcodegen generate` and open
`GrandTour.xcodeproj`. Simulator builds need no signing; for device builds,
copy `ios/project-local.yml.example` to `ios/project-local.yml`, set your
team, and generate with `GRANDTOUR_SIGNING=true xcodegen generate`.

## Shipping the apps

CarPlay and the watch app are planned, not complete: CarPlay's entitlements
are pending Apple's grant and both experiences are simulator-verified only;
the watch reads authoring servers only.

The generated Info.plists set `NSAllowsArbitraryLoads` so the apps can
reach a plain-HTTP dev server on your LAN or tailnet. Remove that key (see
`ios/project.yml`) and serve the API over HTTPS before any TestFlight or App
Store build.

CarPlay: `GRANDTOUR_CARPLAY_MODE` (project.yml, default `audio`) selects the
audio experience and its `com.apple.developer.carplay-audio` entitlement for
both simulator and **device** builds. `navigation` selects the experimental
map experience and a separate `carplay-maps` entitlement. Apple must approve
the selected capability and include it in the device provisioning profile;
adding a key to a plist cannot grant it. Signing now fails if that grant is
missing. `GRANDTOUR_CARPLAY_MODE=none` explicitly builds the phone app with
system Now Playing/remote controls only, without a dedicated CarPlay icon.
See [device readiness and actual-car verification](docs/carplay-device-readiness.md)
for the signed-bundle check and remaining setup.

The app's field diagnostics — the decision chain behind every trigger,
including a GPS trace — stay on the phone at `Library/Caches/tour-diag.jsonl`
in the app container and are never uploaded. To replay a walk, pull the file
off the device (Xcode → Devices and Simulators → Download Container, or
`xcrun simctl get_app_container booted fyi.grandtour.app data` on the
simulator) and run `cd server && bun run diag <file>`. The server's
`POST /api/diag/logs` sink is no longer used by the app; it is
unauthenticated, so it stays off unless you set `DIAG_ENABLED=true`.

## Tests

```sh
bun run typecheck                          # all workspaces
cd packages/shared && bun test             # pure, no DB
docker compose exec db psql -U postgres -c 'CREATE DATABASE grandtour_test'
cd server && DATABASE_URL=postgres://postgres:postgres@localhost:5432/grandtour_test bun run db/migrate.ts
cd server && bun test                      # DB-backed
cd ios && xcodebuild test -project GrandTour.xcodeproj -scheme GrandTourTests \
  -destination 'platform=iOS Simulator,name=iPhone 17'   # logic-only bundle
```

## Layout

```
packages/shared/   zod schemas + types, shared TS ⇄ Swift wire shapes
server/            Bun + Hono API, PostGIS geo queries, AI pipeline
admin/             map authoring, narration editing/generation, publish
packages/tour-viewer/  the web app (real GPS, or a simulated trip); TourView is the admin's preview
site/              grandtour.fyi — landing page + the published content, a GrandTour server
ios/               SwiftUI iPhone app + CarPlay scene (XcodeGen project)
ios/WatchSources/  standalone watchOS app sharing the phone's logic files
scripts/           dev server runner, simulator walkthroughs
```

MIT. See [CONTRIBUTING.md](CONTRIBUTING.md).
