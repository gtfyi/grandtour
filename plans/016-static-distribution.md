# 016 — Static distribution: tours repository, data CDN, one monorepo

Status: IN PROGRESS · Priority: P1 · Effort: L · Depends on: 015

Prepared 2026-09-19; revised the same day for D7–D9. The tree is landed
(015 B4, done 2026-09-19). Phases 1 and 2 are built and verified (below);
Phases 3–5 are executor-ready. Each phase ends with a STOP naming what only the
maintainer can do.

## Decisions (maintainer, 2026-09-19)

| # | Decision |
|---|----------|
| D1 | **One monorepo for all code**: server, admin, shared, tour-viewer, iOS, watch, CarPlay, and the site. grandtour.fyi moves in as a workspace. |
| D2 | **Content lives in `gtfyi/tours`** — the location of record, not a CDN. Bundles, catalog, and audio. |
| D3 | **Cloudflare R2 is the distribution.** On every change to `gtfyi/tours`, the files are pushed to R2 behind a cached custom domain. |
| D4 | **The public surface is completely static.** No API server on the public path. The client computes its own position, knows the shared set of areas, decides which areas it wants, and predownloads or fetches the tracks for them. |
| D5 | **A client's GPS coordinates never leave the device.** It only requests files. |
| D6 | Everything simplified and made function- and schema-based; concise docs explaining the object model ([docs/object-model.md](../docs/object-model.md)). |
| D7 | **No Git LFS.** Audio lives in Cloudflare R2 and the metadata points at its public URLs. |
| D8 | **Metadata is versioned in `gtfyi/content-private`** (every track, held ones marked). Publishing carries public tracks to **`gtfyi/content`** and to the default server, **grandtour.fyi**, and uploads their audio. |
| D9 | **A server is a base URL.** Clients can point at any of them — a website, a GitHub repository, a laptop. The convention: `<base>/grandtour.json` is the index; the index says where the tours live; the tours say where the data lives. That is all it takes to be a GrandTour server. |

## Design

### A server is a base URL

```
<base>/grandtour.json                Index: one IndexTrack per track, each with its bundle's URL
<base>/tours/<slug>.grandtour.json   TrackExport, voiced spots only, formatVersion 1, deterministic
```

`indexUrl(server)` maps a user's spelling of a server to its index:
`grandtour.fyi` → `https://grandtour.fyi/grandtour.json`;
`github.com/gtfyi/content` → the raw file on `main`; `http://localhost:8787`
→ the authoring server, which serves the same two shapes live
(`server/src/routes/distribution.ts`) with locally stored recordings rehosted
to the requesting origin. Track URLs resolve against the index's URL, so a
checkout, a repository and a website are interchangeable. Audio URLs are
absolute and never rewritten: ours are `${AUDIO_PUBLIC_BASE_URL}/audio/<sha256>.<ext>`
in the R2 bucket behind `data.grandtour.fyi`; a park service's stay theirs.

### Repositories and the flow

```
database ──content:export──▶ content-private (every track; held ones marked)
                                   │
                            content:publish (public tracks only)
                                   ├──▶ gtfyi/content (public repository)
                                   ├──▶ site static root (grandtour.fyi/grandtour.json, /tours/…)
                                   └──▶ R2: audio/<sha256>.<ext> (only what public bundles name)
```

Export is naming; publish is materialisation. A held track's bundle in the
private repository already carries its final audio URLs, but the bytes are
not uploaded until it is public, so those URLs 404 until release. The
recordings of record stay in `server/uploads` (back it up) and in the bucket.

### Areas

An area is a geohash cell at precision 4 (`AREA_PRECISION`; ≈39 km × 20 km
at the equator). Both sides know the function, so the "shared set of
areas" needs no list, no polygons and no sync. `areasOf` records every cell
a track's triggers can fire in; `areasAround(pos)` is the cell plus its
eight neighbours. Human region names, if wanted, are a label on the index
entry, not the partition key. Swift mirror `AreaId`; `scripts/area-parity`
replays 500 golden cases.

### The client's loop (web, iOS, watch — identical)

1. Fetch `indexUrl(server)` (position-independent; ~10 KB).
2. `wanted = tracksInAreas(index, areasAround(pos))` — computed on the device.
3. Fetch each wanted bundle whole via `resolveTrackUrl`: ahead of a trip, or
   on entering its area. Cache by `hash`.
4. Evaluate triggers locally on every fix (`computeNearby` / `TriggerEvaluator`), schedule, play.
5. Play audio from the URL the bundle names; cache on the device.

The index is small enough to fetch whole for a long time. If it ever is
not, the export can also write `areas/<cell>.json` (the index filtered per
cell) and step 1 becomes "fetch my cells' indexes" — the objects do not
change.

**What a server can observe, stated precisely:** which files a client
fetched. No coordinate is ever sent. Fetching the index reveals nothing;
fetching a bundle reveals interest in a track; fetching audio reveals which
stories were played. Prefetching whole bundles rather than requesting spots
on the fly is what keeps the observable grain coarse — do not add a
per-spot fetch path.

### Determinism

`exportedAt` is the newest `updatedAt` a bundle carries; bundles are
re-parsed through the schema (canonical key order) and pretty-printed; the
index's `generatedAt` is the newest bundle's `exportedAt`; the exporting
commit is recorded only with `--stamp`. Two exports of unchanged content are
byte-identical (verified), so the content repository's history shows only
real content changes.

### What the server becomes

The Bun/Hono server is the **authoring** server: admin, creator API, AI
pipeline, PostGIS for authoring queries, the exporter — and a GrandTour
server in its own right via the live distribution routes, so a creator
hears a take on the next fetch. It is what creators run (tailnet or
localhost) and what plan 015 B7 already decided never faces the internet.
`/api/nearby` and `/api/route-nearby` remain for now (decision E4).

Invariants in CLAUDE.md change at Phase 3: "PostGIS owns geo math" becomes
authoring-time only; runtime trigger evaluation lives in `computeNearby`
(TS) and `TriggerEvaluator` (Swift), parity-tested; the release gate is
`tracks.visibility`, applied by export and publish; audio is addressed by
absolute URL, never rewritten by host.

## Phase 1 — shared objects, exporter, live routes (DONE 2026-09-19)

Additive only; nothing existing changed behaviour.

- `packages/shared/src/area.ts` — `areaId`, `areaBounds`, `areaCenter`, `areaNeighbors`, `areasAround`, `ringAreas`, `triggerAreas`, `areasOf`; `AreaId` schema.
- `packages/shared/src/distribution.ts` — `Index`/`IndexTrack`, `INDEX_FILE`, `TOURS_DIR`, `FORMAT_VERSION`, `indexUrl`, `resolveTrackUrl`, `voicedOnly`, `stableExportedAt`, `summarizeTrack`, `buildIndex`, `publicIndex`, `tracksInAreas`, `audioRefsOf`, `mapAudioRefs`.
- `packages/shared/src/api.ts` — `TrackExport.formatVersion` (optional).
- `server/src/content/distribution.ts` — `buildIndexFromDb`, a thin database wrapper over the shared functions (`export-app-catalog.ts` still works for the viewer's dev data).
- `server/src/routes/distribution.ts` — `GET /grandtour.json` and `GET /tours/:slug.grandtour.json`, served live.
- `server/scripts/export-content.ts` — `bun run content:export --out ../../content-private [--extra …] [--prune] [--allow-missing] [--stamp]`.
- `server/scripts/publish-content.ts` — `bun run content:publish --from … --to … [--site …] [--upload] [--prune]`.
- `AUDIO_PUBLIC_BASE_URL` (default `https://data.grandtour.fyi`) in `env.ts` and `.env.example`.
- `ios/Sources/AreaId.swift`, `scripts/area-parity/` — Swift mirror and golden parity.
- Tests: `packages/shared/tests/{area,distribution}.test.ts`, `server/tests/distribution{,-routes}.test.ts`.

Verified: typecheck 4/4 (TypeScript 7.0.2); shared 86, viewer 57, server
136, iOS logic bundle 148, all passing; parity 500/500; the live export
twice → identical bytes; the 25 Glacier clips stay external (`www.nps.gov`)
until that tour is imported properly (015).

## Phase 2 — the content repositories and the bucket (DONE 2026-09-19)

- `gtfyi/content-private` holds the first export: every tour track, held
  ones marked `visibility: "private"`, audio named under
  `https://data.grandtour.fyi/audio/`, plus `audio-manifest.json` (public
  URL → local recording) and a README describing the layout and the flow.
- `gtfyi/content` (public, exists) stays empty until the curation in 015
  (C1–C3, C9, B6, B8) is done and `content:publish` runs.
- **Bucket `grandtour-data`** (created in the dashboard) with custom domain
  `data.grandtour.fyi` (connected through the R2 API), a CORS policy for
  `https://grandtour.fyi`, `https://www.grandtour.fyi` and the localhost
  dev origins (GET/HEAD, Range allowed, Content-Range exposed), and a zone
  cache rule: `data.grandtour.fyi/audio/*` cached one year at the edge and
  in browsers (safe: keys are content hashes). Verified with one uploaded
  public clip: a ranged cross-origin request answers `206` with
  `Content-Range`, `Access-Control-Allow-Origin` and
  `Cache-Control: max-age=31536000`.
- Credentials live in the repo-root `.env`: `CLOUDFLARE_API_TOKEN` +
  `CLOUDFLARE_ACCOUNT_ID` (account token: Workers Scripts, R2, Account
  Settings read; zone: Workers Routes, DNS, Zone read, Cache Rules) for
  wrangler and the API, and `R2_*` (an R2 API token scoped to the bucket)
  for uploads. Dashboard-only actions were minting those and creating the
  bucket.
- A dry run of `content:publish` shows 14 public tracks referencing 575
  recordings (669 MB, plus 25 external NPS clips). **The bulk upload is
  deliberately not run yet**: it is publication, and it waits for the 015
  curation like the public repository does. When ready:

  ```bash
  cd server && bun run content:publish --from ../../content-private --to ../../content --upload
  ```

  Objects are content-addressed, so the upload is idempotent; there is no
  bucket prune yet (an unpublished spot's clip would linger at its hash URL
  until one is added — E5).

## Phase 3 — every client reads a server; the site joins the monorepo

**Clients: DONE 2026-09-19** (web app, viewer, iOS). Verified: the web app
and viewer against a private authoring instance and against
`github.com/gtfyi/content` (empty → a clean error with the picker); iOS
against a plain file server over `content-private` (index → bundles for
the cells around Fairfax → triggers on the device, no API call), by
`StaticServerTests` through the real view model and by the app in the
simulator. **Site fold-in: DONE 2026-09-19** (`site/`; verified the landing page,
`/app/` and a bare `/tour/` from the site's own origin). **Docs: DONE
2026-09-19** (`docs/distribution.md`, README, CLAUDE.md). The watch and
CarPlay are planned, not complete, and are recorded as such.
The watch still needs an authoring server (static-server support there is
a follow-up); journeys (`/api/route-nearby`) need one too; the server list
does not yet filter `visibility: "private"` entries from a private index
(the maintainer's own view — the public index never carries them).

- **Web app** (`packages/tour-viewer`): a *server* setting (default: the
  page's own origin on the site, `http://localhost:8787` in dev) → `indexUrl`
  → `Index`; selection by `tracksInAreas(index, areasAround(pos))` replaces
  the distance heuristic; bundles via `resolveTrackUrl`; delete
  `public/app/*.grandtour.json`, `public/*.grandtour.json` and
  `export-app-catalog.ts` (the live routes and the content repo supersede
  them). The viewer's "Server tracks" tab uses the same index.
- **Site**: move `~/projects/grandtour.fyi` to `site/` as a workspace;
  delete `vendor-tour-viewer.ts`, `check-vendored.ts`, `phone-vendor.ts`,
  `serve-site.ts`, the SVG demo (`demoMapSvg`, `demo.js`, `generate-demo-audio.ts`,
  `public/audio/`, the `spots:` frontmatter and its validation) and the FR
  locale; the landing iframe embeds
  `/tour/?bundle=/tours/going-to-the-sun-road-audio-tour.grandtour.json&embed=1`;
  bare `/tour/` opens that demo; `/app/` is the viewer build with the site
  as its server. The site build copies the published `grandtour.json` and
  `tours/` from `gtfyi/content` into its static root. `bun run site:build`
  and `bun run site:deploy` at the root; generated output ignored.
- **iOS + watch**: a server is a base URL (`ServerPreference` already holds
  one; the built-in default becomes `https://grandtour.fyi`). `GrandTourAPI`
  reads `grandtour.json` and `tours/<slug>.grandtour.json` — from a static
  host or the authoring server alike — and `nearby()` becomes the existing
  local evaluation (`offlineNearby` + `TriggerEvaluator`); manifests from
  bundles (`TrackDownloadBundle.manifest`); no fill-ins from static
  servers; creator mode only against an authoring server. Delete
  `resolveAudioURL`'s host rewrite (audio URLs are absolute; today the
  rewrite breaks externally hosted clips). Track selection by
  `AreaId.around`.
- **Docs**: `docs/distribution.md` (record → CDN → clients, the privacy
  statement above, how to ship content); CLAUDE.md invariants updated;
  README "Run it" and "Shipping" rewritten.

**STOP.** Deploying the site and flipping repositories public stay with
the maintainer (015).

## Phase 4 — parity and simplification

**Done 2026-09-19:** trigger parity harness (`scripts/trigger-parity`, 396
cases, area distance aligned to the phone); the web app's cheap parity
fixes (3 s gap and the phone's options, arrivals before ambient, ambient
order, sequence gate); one-off track scripts under `server/scripts/tracks/`;
the `SpotScheduler` port (`packages/shared/src/scheduler.ts`) driving the
web app's automatic starts, with `scripts/scheduler-parity` at 3500/3500
(3472 decisions, 16 journeys, 12 repeated-town visits) — which required
replacing `CLLocation.distance(from:)` in tour logic with the explicit
`Geo.localDistanceM`/`localDistanceM`, because CoreLocation's answer
depends on call history. **Open:** the live-API question (E4).

- Golden parity for trigger evaluation (`computeNearby` ↔ `TriggerEvaluator`)
  and replay rules, on the `scripts/*-parity` pattern.
- Port `SpotScheduler` to TypeScript in shared; export the
  `JourneySimulator` scenarios as golden JSON both suites replay; the web
  app adopts it (closes the area-spot, gap-default and sequence gaps).
- Decide whether `/api/nearby` and `/api/route-nearby` survive as an
  authoring convenience or go; if they go, "PostGIS owns geo math" is
  retired and `server/src/geo/` shrinks to authoring queries.

## Open decisions

| # | Decision | Blocks |
|---|----------|--------|
| E1 | ~~LFS~~ — decided: no LFS; recordings of record are `server/uploads` (back it up) plus the bucket | — |
| E2 | Bucket and domain names (`grandtour-data`, `data.grandtour.fyi` proposed) — and an R2-capable token | Phase 2 upload |
| E3 | Publish `@grandtour/shared` to npm so the content repositories can validate their own files in CI | later |
| E4 | Whether the live `/nearby` API survives after every client reads the CDN | Phase 4 |
| E5 | The History track spans six cells across two states (015 C2/C3); `areas` now makes that visible in the index | curation |
| E6 | Bucket prune: `content:publish` never deletes objects; add `--prune-bucket` (delete keys no public bundle names) before the first curation-driven unpublish | after first publish |
