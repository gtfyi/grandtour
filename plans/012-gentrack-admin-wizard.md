# Plan 012: Generate-track wizard in the admin

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 2ca0d3d..HEAD -- admin/src`
> Plan 011 must be DONE (its API is this UI's backend). Compare the
> "Current state" excerpts against the live code; on a mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW (admin-only UI over plan 011's API)
- **Depends on**: plans/011-gentrack-pipeline.md (DONE required)
- **Category**: direction / feature
- **Planned at**: commit `2ca0d3d`, 2026-07-06

## Why this matters

Plan 011 ships the pipeline as an API. This plan gives it the human loop the
product flow requires: pick two endpoints on the map, **choose between route
alternatives**, describe categories, **review/edit the proposed stops before
money is spent**, watch fill progress per stop, and land in the generated
track's workspace. Every wizard state is URL-addressable, matching the
admin's routing philosophy.

## Current state (verified at 2ca0d3d)

- Admin routing is hand-rolled in `admin/src/App.tsx` (`usePath()`,
  `history.pushState`, popstate): `/` chooser, `/:trackSlug`,
  `/:trackSlug/:spotSlug`. New top-level segments must not collide with
  track slugs — reserve the literal path prefix `generate` (checked BEFORE
  track resolution in the path parsing).
- `admin/src/MapView.tsx` already renders: spot markers, a draggable
  crosshair (`onDraftMove`), a route polyline (`routePath` prop, orange
  line), a traveler icon (`traveler` prop), `centerRef`, `frameKey` framing,
  and jump-not-fly camera semantics (`jumpTo`/`fitBounds` with
  `animate:false` — keep that; no animations).
- `admin/src/api.ts` — thin typed fetch wrapper (`req<T>()`) with bearer
  token from localStorage; one method per endpoint.
- `admin/src/DriveMode.tsx` + `useDriveSim.ts` — the drive simulator;
  pattern precedent for a panel component that feeds map overlays up via
  callbacks (`onRoute`, `onTraveler`).
- Styling: `admin/src/styles.css` — `.card`, `.field`, `.toolbar`,
  `.spot-list`/`.spot-row`, `.pill`, `.crumbs`, `.empty`. Reuse; no new CSS
  framework.
- Plan 011's API (verify live before building): `POST /api/admin/genruns`,
  `GET /:id` (run + steps), `POST /:id/route`, `POST /:id/stops`,
  `PATCH /:id/stops`, `POST /:id/fill`, `POST /:id/materialize`,
  `POST /:id/resume`.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Typecheck | `bun run typecheck` (root) | exit 0 |
| Run servers | `bun run dev:server` / `bun run dev:admin` | :8787 / :5180 |
| Server tests | `cd server && bun test` | pass (regression check only) |

## Scope

**In scope**:
- `admin/src/GenerateWizard.tsx` (create), `admin/src/api.ts` (genruns
  methods), `admin/src/App.tsx` (route segment + entry button),
  `admin/src/MapView.tsx` (only if a small prop addition is unavoidable —
  prefer reusing `routePath`/`traveler`/`onMapClick`), `admin/src/styles.css`.

**Out of scope**:
- Any server change (011 owns the API; if the API is missing something,
  STOP and report — don't patch the server from this plan).
- Forward geocoding / address search for endpoints (v1 places endpoints by
  clicking the map; note as follow-up).
- Editing generated narration inside the wizard — that's the existing spot
  editor's job after materialize.

## URL scheme

- `/generate` — new wizard (no run yet)
- `/generate/:runId` — an existing run, rendered at whatever stage its
  status indicates (copy-pasteable; survives reload; this is how you get
  back to a long fill in progress)

## Implementation steps

### Step 1: API client methods

`api.ts`: `createGenRun`, `getGenRun`, `chooseRoute`, `findStops`
(`POST /:id/stops`), `updateStops` (PATCH), `fill`, `materialize`, `resume`,
typed with the shared gentrack schemas (`RouteCandidate`, `BareStop`,
`GenRunStatus` — import from `@grandtour/shared`).

**Verify**: `bun run typecheck` exit 0.

### Step 2: Wizard shell + routing

- App path parsing: if the first segment is `generate`, render
  `<GenerateWizard runId={second segment ?? null} />` instead of track
  resolution. Add a `✨ Generate track` button on the track chooser card
  (`/`), navigating to `/generate`.
- `GenerateWizard` owns: run state (poll `GET /:id` every 2s while status is
  `filling`, otherwise on demand), and pushes map overlays up through the
  same props App already passes to MapView (App lifts `routePath` +
  wizard-specific markers the same way DriveMode lifts its overlays — follow
  that pattern).
- On mount with a `runId`, load the run and render its current stage; on
  create, `navigate(\`/generate/${run.id}\`)`.

**Verify**: manual — `/generate` shows step 1; a bogus `/generate/xyz` shows
a "run not found" error with a link back.

### Step 3: Stage panels (one component per run status)

1. **Endpoints** (`no run yet`): two placement buttons — "Set start at map
   center", "Set end at map center" (crosshair-style markers on the map;
   clicking the map sets whichever is armed); mode select
   (walking/driving/cycling). "Find routes" → `createGenRun` → status
   `route-generated`.
2. **Choose route** (`route-generated`): list the candidates
   (`{summary, distanceM→km, durationS→min}`); hovering/selecting a
   candidate shows its polyline via `routePath` (selected solid, others not
   shown — MapView has one route line; render only the selected/hovered
   one). "Use this route" → `chooseRoute`.
3. **Categories** (`route-chosen`): free-text categories (comma-split →
   array), numStops (default 8, max 25), corridor slider (100–2000 m,
   default 400). "Find stops" → busy state → `stops-found`.
4. **Review stops** (`stops-found`): list of `BareStop`s — title, category
   pill, rationale (muted), `offRouteM`/along-km; ✕ remove per row
   (PATCH), stop markers on the map numbered in route order. Fill options:
   target seconds, include-audio checkbox (default ON — maps to
   `synthesizeAudio`), optional brief. "Generate content (N stops)" →
   `fill` → `filling`.
5. **Filling** (`filling`): per-stop progress from the run's step rows —
   for each stop key show research/draft/synthesize as pending/ok/error
   chips; failed stops get a "retry" (→ `resume`). Poll every 2s. When
   `filled`: summary (succeeded/skipped-refused/failed).
6. **Materialize** (`filled`): track name input (default:
   `"<first category> · <start-locality> → <end-locality>"` if the run state
   carries locality labels, else the category). "Create track" →
   `materialize` → **navigate to `/:trackSlug`** — the normal workspace,
   where review/publish/drive-sim already exist. Show `skippedTitles` as a
   dismissible notice first.

All camera moves instant (`fitBounds`/`jumpTo` with `animate:false` —
repo-wide no-animation rule).

**Verify** (manual, against a dev server with keys): full happy path on two
points ~2 km apart in a city, categories "history", 4 stops,
include-audio OFF (fast, free of TTS cost) → lands in the new track's
workspace with draft spots. Then a second pass with audio ON for one stop
count ≤2 to confirm audio players appear in the spot editor.

### Step 4: Resilience details

- Reloading `/generate/:runId` mid-fill resumes polling (URL is the state).
- `stale: true` runs (server flagged) render a "Resume" button.
- Token-gate behavior matches the rest of the admin (401 → token prompt).
- Exiting the wizard (breadcrumb "tracks") leaves the run intact — it's
  listed nowhere yet in v1; note "runs list UI" as a follow-up.

**Verify**: reload during `filling` → progress continues; kill the dev
server mid-fill, restart, `resume` completes the run.

## Test plan

The admin has no test runner (deliberate, see plans/README rejected list);
verification is the manual matrix in Steps 2–4 plus typecheck. Server
regression: `cd server && bun test` stays green (this plan must not touch
the server).

## Done criteria

- [ ] `bun run typecheck` exit 0
- [ ] `git diff --stat` touches only `admin/src/**`
- [ ] Manual happy path (Step 3 verify) completed and described in your
      report with the resulting track slug
- [ ] Reload-mid-fill and resume-after-restart both verified
- [ ] `/generate` reachable from the track chooser; `/generate/:runId`
      copy-pasteable
- [ ] `plans/README.md` status row updated

## STOP conditions

- Plan 011 not DONE, or its API differs from the shapes listed here.
- You need a server change — report it as 011 feedback instead of patching.
- MapView needs more than an additive optional prop.

## Maintenance notes

- Follow-ups deliberately out of v1: address search for endpoints, a runs
  list/history page, editing stop titles inline (only removal ships),
  drive-sim preferring the stored `tracks.route`, cost display per run
  (usage is already persisted server-side).
- When the wizard grows, split stage panels into files; keep the
  DriveMode-style "panel feeds map overlays via lifted props" pattern.
