# Plan 011: AI track generation pipeline — staged, persisted, evalable

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 2ca0d3d..HEAD -- packages/shared/src server/src server/db`
> If in-scope files changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L (multi-day)
- **Risk**: MED (new subsystem; external providers; but zero changes to the
  public API or existing generation path)
- **Depends on**: none (plans 001–010 are DONE)
- **Category**: direction / feature
- **Planned at**: commit `2ca0d3d`, 2026-07-06

## Why this matters

Today a track is authored one spot at a time. The product wants: *give me
two endpoints, a route between them, and a theme ("revolutionary war
history", "art deco architecture") — and get back a full draft track:
well-chosen stops along the route, each deeply researched, scripted, and
voiced.*

The architectural requirement is as important as the feature: **every stage
is a separate function with schema-validated inputs and outputs, persisted
per run**, so that (a) any stage can be re-run in isolation, (b) a failed
run resumes instead of restarting, and (c) **evals can be written per
stage** against captured real inputs. The pipeline shape:

```
routeCandidates = generateRoute(start, end, mode)        // user picks one
bareStops       = findStops(route, categories, numStops) // user may edit
dossier         = researchStop(bareStop)                 // per stop, fan-out
script          = draftStop(dossier)                     // per stop
voiced          = synthesizeStop(script)                 // per stop
track           = materializeTrack(route, voiced[])      // DB writes, draft status
```

Stage boundaries are the eval contract. Internals of a stage can later be
upgraded (e.g. `findStops` from "gather + one selection call" to a full
tool-use agent loop) **without changing the contract or the evals**.

## Current state (verified at 2ca0d3d — reuse, don't rebuild)

- `server/src/ai/search.ts` — `reverseGeocode(lat, lng)` (Geocodio),
  `exaSearch(query, {numResults})`, `wikipediaNearby(lat, lng, {limit, radiusM})`
  (GeoSearch + extracts, returns `SourceDoc {title, url, text}`),
  `identifyPlace(lat, lng, {radiusM, limit})`.
- `server/src/ai/script.ts` — `vetSources(req)` (Claude drops wrong-place
  sources; returns surviving `SourceDoc[]`), `draftNarration(req)` (side-free
  narration rules live in its system prompt — the "never say left/right"
  invariant). Model: `claude-opus-4-8` via `@anthropic-ai/sdk`.
- `server/src/ai/generate.ts` — `synthesize` (via `./tts`, ElevenLabs
  with-timestamps), `charTimesByStringIndex` (validated char→index mapping;
  throws on mismatch upstream), `alignAudioToSentences`, `putAudio(key, ...)`
  (S3/R2 or local `./uploads`); `generateLocatingClips`.
- `packages/shared/src/geo.ts` — `haversineM`, `bearingDeg`, `lerpLngLat`,
  `cumulativeMeters`, `pointAlong`, `nearestNeighborOrder` (all tested in
  `packages/shared/tests/geo.test.ts`).
- `admin/src/route.ts` — OSRM demo-server client (client-side, for the drive
  simulator): precedent for URL shape
  `https://router.project-osrm.org/route/v1/driving/{lng,lat;...}?overview=full&geometries=geojson`.
  Leave it alone; the pipeline gets its own server-side client.
- Migrations `server/db/001–005`; **next is `006_*`**. Forward-only, applied
  by `bun run db:migrate`; the test DB is `grandtour_test`
  (`server/tests/preload.ts` points the pool there for `bun test`).
- Conventions: routes zod-`safeParse` → `{error, detail}` JSON; repo
  functions take `sql` first and return DTOs (`server/src/content/repo.ts`);
  `createTrack`, `createSpot`, `upsertContent` exist there. Admin API is
  bearer-token (`adminRouter.use("*")` middleware registered before routes).
  Env access via lazy fns in `server/src/env.ts` (`optional(name)` pattern).
- `GenerationProvenance` (`packages/shared/src/content.ts`) already has
  `warnings: string[]` (added additively before — same pattern for new
  fields).

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Typecheck | `bun run typecheck` (root) | all 3 workspaces exit 0 |
| Shared tests | `cd packages/shared && bun test` | pass |
| Server tests | `cd server && bun test` | pass (needs `grandtour_test` migrated) |
| Migrate dev | `bun run db:migrate` | applies `006_gentrack.sql` |
| Migrate test DB | `cd server && DATABASE_URL=postgres://postgres:postgres@localhost:5432/grandtour_test bun run db/migrate.ts` | applies 006 |
| Evals (new) | `cd server && bun run eval` | deterministic evals pass |

## Suggested executor toolkit

- Load the `claude-api` skill before writing the Claude selection/extraction
  calls (SDK usage, structured output patterns).
- Load `bun-hono-webservice` before the API routes.

## Scope

**In scope** (create/modify):
- `packages/shared/src/gentrack.ts` (create — all stage IO schemas), `src/index.ts` (export line), `src/geo.ts` (one helper), `src/content.ts` (one optional provenance field), tests for each
- `server/db/006_gentrack.sql` (create)
- `server/src/gentrack/**` (create: deps, steps/, orchestrator, repo, router)
- `server/src/routes/admin.ts` (mount the genruns router only)
- `server/src/env.ts`, `.env.example` (OSRM/Overpass base URLs, optional)
- `server/tests/gentrack/**` (create), `server/evals/**` (create)
- `server/package.json` (scripts: `eval`, `gentrack:capture`)
- `CLAUDE.md` (commands + one architecture line), `plans/README.md` (status)

**Out of scope** (do NOT touch):
- The existing per-spot generation path (`generateNarration`, its admin
  route) — it stays as-is for single-spot regeneration.
- The public API (`/api/nearby`, `/api/tracks`) — generated content is draft
  until a human publishes it; nothing public changes.
- Admin wizard UI — that is plan 012.
- iOS.
- Locating clips for generated spots — spots get the default `auto`
  locating; clips are generated later via the existing targeted endpoint.

## Git workflow

- Branch or commit-per-step on `main` (repo convention so far: sequential
  commits on main). Imperative messages, e.g. `Add gentrack stage schemas`.
- Do NOT push.

## Implementation steps

### Step 1: Stage IO schemas in shared

Create `packages/shared/src/gentrack.ts`. Every stage gets an `Input` and
`Output` zod schema — **these are the eval contract; put doc comments on
every field.** Shapes (adjust names only if a collision forces it):

```ts
export const TravelMode = z.enum(["walking", "driving", "cycling"]);

// generateRoute
export const GenerateRouteInput = z.object({
  start: LngLat, end: LngLat,
  mode: TravelMode.default("driving"),
  alternatives: z.number().int().min(1).max(3).default(3),
});
export const RouteCandidate = z.object({
  path: z.array(LngLat).min(2),   // dense polyline the route follows
  distanceM: z.number().positive(),
  durationS: z.number().positive(),
  summary: z.string().default(""), // road names, from the router
});
export const GenerateRouteOutput = z.object({
  candidates: z.array(RouteCandidate).min(1),
  provider: z.enum(["osrm", "straight-line"]), // fallback visibility for evals
});

// findStops
export const FindStopsInput = z.object({
  route: RouteCandidate,
  categories: z.array(z.string().min(1)).min(1), // free text, e.g. "civil war history"
  numStops: z.number().int().min(1).max(25),
  corridorM: z.number().positive().max(2000).default(400),
  locale: z.string().default("en"),
});
export const BareStop = z.object({
  title: z.string().min(1),
  center: LngLat,
  distanceAlongRouteM: z.number().nonnegative(), // ordering key
  offRouteM: z.number().nonnegative(),           // corridor check for evals
  category: z.string(),                          // which requested category it serves
  rationale: z.string(),                         // WHY the agent chose it (eval visibility)
  sourceHints: z.array(z.object({ title: z.string(), url: z.string() })).default([]),
  suggestedRadiusM: z.number().positive().default(120),
});
export const FindStopsOutput = z.object({
  stops: z.array(BareStop),
  candidatesConsidered: z.number().int().nonnegative(), // observability
  searchQueries: z.array(z.string()),                   // what was searched (evals)
});

// researchStop — research is DATA, refusal is a value, never a throw
export const ResearchStopInput = z.object({
  stop: BareStop, categories: z.array(z.string()), locale: z.string().default("en"),
});
export const StopDossier = z.object({
  stop: BareStop,
  placeLabel: z.string(),
  sources: z.array(z.object({ title: z.string(), url: z.string(), text: z.string() })),
  keyFacts: z.array(z.object({
    fact: z.string(),
    sourceUrls: z.array(z.string()).min(1), // every fact cites its sources
  })),
  confidence: z.enum(["strong", "thin", "refused"]),
  warnings: z.array(z.string()).default([]),
});

// draftStop
export const DraftStopInput = z.object({
  dossier: StopDossier,
  targetSeconds: z.number().positive().max(900).default(90),
  brief: z.string().optional(),
});
export const DraftStopOutput = z.object({
  text: z.string().min(1),
  usedSourceUrls: z.array(z.string()),
});

// synthesizeStop
export const SynthesizeStopInput = z.object({
  text: z.string().min(1),
  locale: z.string().default("en"),
  voiceId: z.string().optional(),
  storageKey: z.string().min(1), // e.g. genrun/<runId>/stop-03-en.mp3
});
export const SynthesizeStopOutput = z.object({
  document: FiloDocumentJson,
  audioUrl: z.string().url(),
  durationMs: z.number().nonnegative(),
});

// materializeTrack
export const MaterializeInput = z.object({
  trackName: z.string().min(1),
  trackSlug: z.string().regex(/^[a-z0-9-]+$/).optional(),
  route: RouteCandidate,
  locale: z.string().default("en"),
  stops: z.array(z.object({
    bare: BareStop,
    dossier: StopDossier,
    text: z.string().nullable(),      // null = stop was refused/skipped
    document: FiloDocumentJson.nullable(),
    audioUrl: z.string().url().nullable(),
    durationMs: z.number().nullable(),
  })),
});
export const MaterializeOutput = z.object({
  trackId: z.string().uuid(),
  trackSlug: z.string(),
  spotIds: z.array(z.string().uuid()),
  skippedTitles: z.array(z.string()), // refused stops, surfaced not hidden
});

// Run bookkeeping
export const GenRunStatus = z.enum([
  "route-generated", "route-chosen", "stops-found",
  "filling", "filled", "materialized", "failed",
]);
```

Also in this step:
- `packages/shared/src/geo.ts`: add `nearestPointOnPath(path, cum, point) →
  { distAlongM: number; offPathM: number }` (nearest-vertex approximation is
  fine — OSRM polylines are dense). Tests in `tests/geo.test.ts`: point at a
  vertex → offPath 0; point offset from the midpoint of a segment → distAlong
  between the vertices, offPath ≈ the offset.
- `packages/shared/src/content.ts`: add `genRunId: z.string().uuid().optional()`
  to `GenerationProvenance` (same additive pattern as `warnings`); extend the
  provenance round-trip test in `tests/schema.test.ts`.
- Export `* from "./gentrack"` in `src/index.ts`; schema-parse tests in
  `packages/shared/tests/gentrack.test.ts` (valid + one invalid case per
  schema minimum).

**Verify**: `bun run typecheck` exit 0; `cd packages/shared && bun test` all pass.

### Step 2: Migration 006

`server/db/006_gentrack.sql`:

```sql
-- AI track-generation pipeline runs. Every stage execution is persisted with
-- its full input/output so stages can be re-run, resumed, and evaled.

CREATE TABLE IF NOT EXISTS gentrack_runs (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status     TEXT NOT NULL,
  params     JSONB NOT NULL,           -- original user input (start/end/mode/…)
  state      JSONB NOT NULL DEFAULT '{}', -- accumulated: chosenRoute, stops, …
  track_id   UUID REFERENCES tracks(id) ON DELETE SET NULL,
  error      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gentrack_steps (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id      UUID NOT NULL REFERENCES gentrack_runs(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,           -- generateRoute | findStops | researchStop | …
  item_key    TEXT,                    -- fan-out key, e.g. stop index "03"; NULL for run-level
  seq         INT NOT NULL,            -- execution order within the run
  status      TEXT NOT NULL,           -- running | ok | error
  input       JSONB NOT NULL,
  output      JSONB,
  error       TEXT,
  model       TEXT,                    -- LLM used, when applicable
  usage       JSONB,                   -- tokens etc., when applicable
  duration_ms INT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gentrack_steps_run_idx ON gentrack_steps (run_id, seq);

-- The authored route a generated track was built along (drive sim can prefer it later).
ALTER TABLE tracks ADD COLUMN route JSONB;
```

**Verify**: `bun run db:migrate` applies 006; same against `grandtour_test`;
`docker compose exec db psql -U postgres -d grandtour -c '\d gentrack_steps'`
shows the columns.

### Step 3: Provider deps — the seam that makes stages testable

`server/src/gentrack/deps.ts`. Every stage receives a `Deps` object; **no
stage calls `fetch` or the Anthropic SDK directly.** This is what lets tests
and evals stub providers and replay recorded responses.

```ts
export interface Deps {
  osrmRoute(input: { coords: LngLat[]; mode: TravelMode; alternatives: number }):
    Promise<{ candidates: RouteCandidate[] } | null>;   // null = unreachable
  wikipediaNearby: typeof wikipediaNearby;               // reuse ai/search.ts
  wikipediaExtract(title: string): Promise<SourceDoc | null>; // full-article extract (new, small)
  overpassPOIs(input: { bbox: BBox; keywords: string[]; limit: number }):
    Promise<Array<{ title: string; center: LngLat; tags: Record<string, string> }>>;
  exaSearch: typeof exaSearch;
  reverseGeocode: typeof reverseGeocode;
  claude(req: { system: string; user: string; maxTokens: number }):
    Promise<{ text: string; model: string; usage?: unknown }>;
  synthesize: typeof synthesize;                         // reuse ai/tts.ts
  putAudio: typeof putAudio;                             // reuse ai/storage.ts
}
export function productionDeps(): Deps { … }
```

- `osrmRoute` reads `env.osrmBaseUrl()` (new in `env.ts`:
  `process.env.OSRM_BASE_URL || "https://router.project-osrm.org"`); mode
  maps to profile path (`driving|walking|cycling`). **Known limitation to
  note in a comment: the public demo serves car routing for all profiles;
  self-host OSRM for real walking routes.** Timeout ~10s; any failure → null.
- `overpassPOIs` reads `env.overpassUrl()` (default
  `https://overpass-api.de/api/interpreter`), queries name-tagged nodes/ways
  in the bbox whose `name`/`tourism`/`historic`/`amenity` tags match the
  keywords; best-effort — errors return `[]`, never throw.
- `claude` wraps the Anthropic SDK with the repo's existing model
  (`claude-opus-4-8`), returning raw text + usage. Structured output: caller
  parses with zod, and on parse failure retries ONCE appending the zod error
  to the prompt; second failure throws.
- Document `OSRM_BASE_URL` / `OVERPASS_URL` in `.env.example` (optional,
  with defaults).

**Verify**: `bun run typecheck` exit 0.

### Step 4: The six stage functions

`server/src/gentrack/steps/<name>.ts`, each exporting exactly
`async function <name>(input: <Name>Input, deps: Deps): Promise<<Name>Output>`
— pure with respect to `deps`, no DB access (materialize excepted), no
process env reads.

**generateRoute** — call `deps.osrmRoute` with `[start, end]`; on null,
return the straight-line fallback
(`{candidates: [{path: [start, end], distanceM: haversineM(...), durationS: dist/speed(mode)}], provider: "straight-line"}`).

**findStops** — internals (v1; the contract, not the internals, is stable):
1. Sample the route every `max(200, distanceM/50)` meters (≤60 samples) via
   `pointAlong`.
2. Candidates: `deps.wikipediaNearby` at each sample (radius `corridorM`,
   limit 5, dedupe by title) ∪ `deps.overpassPOIs` over the route bbox with
   keywords derived from the categories. Cap merged candidates at 120.
3. Enrich each candidate with `distanceAlongRouteM`/`offRouteM` via
   `nearestPointOnPath`; drop those beyond `corridorM`.
4. `deps.reverseGeocode` at 3 samples (start/mid/end) for locality names;
   record the exa/wiki queries used into `searchQueries`.
5. One `deps.claude` selection call: given the candidate table (title,
   coords, along/off distances, source hints) + categories + locality
   context, choose ≤ `numStops` stops, spaced along the route, each with
   `category` + `rationale`. Respond as JSON array; zod-parse (retry-once
   rule from Step 3).
6. Post-enforce in code (never trust the model for hard constraints): clamp
   to `numStops`, drop stops closer than
   `min(200, routeLen/numStops/3)` meters along-route to their predecessor
   (keep the first), sort by `distanceAlongRouteM`.

**researchStop** — `deps.wikipediaExtract` for the stop title (if wiki-
sourced) + `deps.exaSearch("<title> <category> in <placeLabel>")` →
`vetSources` (reuse; pass the stop's coords + placeLabel) → one
`deps.claude` extraction call producing `keyFacts` with `sourceUrls` drawn
ONLY from the vetted set (post-validate in code: drop facts citing unknown
URLs; if that empties the list, `confidence: "thin"`). No surviving sources →
`confidence: "refused"`, empty facts, warning recorded. **Refusal is a
returned value here, not a throw** — the run continues and the stop is
skipped at materialize.

**draftStop** — if `dossier.confidence === "refused"`, throw (the
orchestrator will not schedule it; a direct call is a programming error).
Otherwise add `draftFromDossier(req)` to `server/src/ai/script.ts` — same
system rules as `draftNarration` (grounded, spoken prose, and the
**side-free rule stays verbatim**), but the user prompt feeds `keyFacts` (+
source excerpts) instead of raw sources, and mentions the traveler is
passing by on a route. Return text + the source URLs actually used.

**synthesizeStop** — `deps.synthesize(text)` → `charTimesByStringIndex`
(reuse; **null mapping must throw** — misaligned audio is never saved, same
invariant as today) → filo doc + `alignAudioToSentences` →
`deps.putAudio(input.storageKey, …)`. Storage keys are
`genrun/<runId>/stop-<NN>-<locale>.mp3` (fits the `/uploads` allowlist
`[\w\-./]+`).

**materializeTrack** — the only stage that touches the DB
(`(input, deps, sql)`): `createTrack` (slug from `slugify(trackName)`,
dedupe with `-2` suffix if taken), `UPDATE tracks SET route = …`, then per
non-refused stop `createSpot` (trigger = center + `suggestedRadiusM`,
default auto locating, status `draft`) + `upsertContent` (document, audio,
`source: "ai"`, provenance `{model, ttsProvider, voiceId, sources: dossier
source list, warnings: dossier warnings, genRunId, generatedAt}`, status
`draft`). Refused stops → `skippedTitles`. Everything lands **draft**; a
human publishes via the existing flow.

**Verify** after each stage file: `bun run typecheck` exit 0, plus that
stage's unit test from Step 7 passing.

### Step 5: Orchestrator + run repo

`server/src/gentrack/repo.ts` (sql-first, DTO-returning, per repo
convention): `createRun`, `getRun` (with steps), `updateRun(status/state/error/trackId)`,
`insertStep`/`finishStep`, `listRuns(limit)`.

`server/src/gentrack/orchestrator.ts`:

```ts
async function runStage<I, O>(ctx, name, itemKey, inputSchema, outputSchema, fn, input): Promise<O>
```
— zod-parse input, insert step row (`running`), execute, zod-parse output,
finish row (`ok`, duration, model/usage when the stage reports it); on error
finish row (`error`) and rethrow. Fan-out helper `mapLimit(items, 2, fn)`
(hand-rolled ~10-line semaphore; no new dependency) for the per-stop stages;
one stop failing marks its steps `error` but siblings continue; the run ends
`filled` if ≥1 stop succeeded (failed stops reported), `failed` if none.
`resumeRun(runId)`: re-execute steps whose status is `error`/missing, using
their persisted inputs — possible precisely because inputs are persisted.

### Step 6: API routes

`server/src/gentrack/router.ts`, mounted in `admin.ts` via
`adminRouter.route("/genruns", genrunsRouter)` (inherits the bearer-token
middleware — verify with a 401 test). All bodies zod-`safeParse`d.

- `POST /` `{start, end, mode, alternatives?}` → creates run, executes
  `generateRoute` inline (fast), status `route-generated`, returns
  `{run}` including candidates.
- `GET /` → recent runs; `GET /:id` → run + steps (full IO — this is the
  debugging/eval surface).
- `POST /:id/route` `{candidateIndex}` → stores chosen route in `state`,
  status `route-chosen`.
- `POST /:id/stops` `{categories, numStops, corridorM?}` → executes
  `findStops` inline (seconds), status `stops-found`.
- `PATCH /:id/stops` `{stops: BareStop[]}` → replace the stop list (human
  edit: remove/rename/re-order before spending money), stays `stops-found`.
- `POST /:id/fill` `{targetSeconds?, synthesizeAudio?, voiceId?, brief?}` →
  409 unless `stops-found`; sets `filling`; **fire-and-poll**: kicks the
  fan-out (research → draft → synthesize per stop, concurrency 2) without
  awaiting it; client polls `GET /:id`. `synthesizeAudio: false` skips the
  TTS stage (cheap text-only runs).
- `POST /:id/materialize` `{trackName}` → 409 unless `filled`; runs
  `materializeTrack`; status `materialized`, `track_id` set; returns
  `{trackId, trackSlug, skippedTitles}`.
- `POST /:id/resume` → re-runs failed steps.

Server-restart orphans: on first `GET` of a run stuck in `filling` with no
step row updated in >10 min, report it as resumable in the response
(`stale: true`) — do NOT auto-resume.

**Verify**: integration tests (Step 7) + manual curl transcript in your
report: create run (two nearby points) → choose route → stops → fill with
`synthesizeAudio:false` → poll to `filled` → materialize → track visible at
`GET /api/admin/tracks`.

### Step 7: Tests (gate) — stubbed deps, no network, no cost

`server/tests/gentrack/*.test.ts`, running under plain `bun test`:

- `steps.test.ts` — every stage with hand-built stub deps:
  - generateRoute: OSRM stub → candidates parse, endpoints within 50m of
    path ends, cumulative length ≈ `distanceM` ±10%; OSRM null → straight-line
    fallback with `provider: "straight-line"`.
  - findStops: stubbed candidates (incl. some beyond corridor, some
    clustered, a claude stub returning a fixed selection) → output ≤
    numStops, all `offRouteM ≤ corridorM`, along-route sorted, spacing
    enforced, `searchQueries` non-empty.
  - researchStop: (a) happy path — every keyFact cites a vetted URL;
    (b) **planted wrong-place case** (sources about a different city; claude
    vet stub rejects all) → `confidence: "refused"`, no throw;
    (c) fact citing an unknown URL is dropped in post-validation.
  - draftStop: claude stub → non-empty prose; **assert side-free**: output
    matches none of `/\b(left|right)\b/i`, no markdown `#`/`*`; refused
    dossier → throws.
  - synthesizeStop: recorded-shape TTS stub (chars+times consistent) →
    document has audio tier, annotation count === sentence count, times
    monotonic; mismatched chars stub → throws (alignment invariant).
- `orchestrator.test.ts` (DB-backed, uses `tests/helpers.ts` builders): step
  rows persisted with IO; a stage that throws → step `error`, siblings
  complete; resume re-runs only the failed step (spy stub counts calls).
- `router.test.ts` (DB-backed): 401 without token; full pipeline through the
  API with all-stub deps injected — ends `materialized`, track + spots +
  draft content exist in `grandtour_test`, provenance carries `genRunId`.
  Deps injection for tests: `deps.ts` exports `getDeps()` reading a mutable
  module ref plus a test-only `__setDeps(partial)`; the router always calls
  `getDeps()`.

**Verify**: `cd server && bun test` all pass; suite still passes with
network disabled (no live provider calls — spot-check by running once with
Wi-Fi off or `OSRM_BASE_URL=http://127.0.0.1:1` set).

### Step 8: Eval harness (measure) — `server/evals/`

Tests gate correctness; **evals score quality on real captured data** and
may cost money. Structure:

```
server/evals/
  run.ts                 # bun run eval [stageName] [--judge]
  capture.ts             # bun run gentrack:capture <runId> [stage]
  score/<stage>.ts       # deterministic scorers + optional LLM judges
  fixtures/<stage>/<case>.json   # {input, output?, meta}
```

- `capture.ts` reads `gentrack_steps` for a run and writes each step's
  persisted `{input, output}` to a fixture file — **this is the payoff of
  step-boundary persistence**: every real run is eval corpus.
- `run.ts` loads fixtures for a stage; for each case either re-executes the
  stage live (`--live`, spends money) or scores the recorded output.
  Deterministic scorers (always run): the same invariants as Step 7 phrased
  as scores (corridor compliance %, spacing violations, citation coverage %,
  side-free, refused-rate). LLM judges (only with `--judge`): stop-relevance
  to category (0–2 per stop), fact-grounding (fact entailed by cited source
  excerpt, 0–1), script-faithfulness (no fact outside the dossier). Judges
  use `deps.claude` and print scores; they never gate.
- Output: per-case table + aggregates; exit non-zero only if a deterministic
  score is below its floor (floors in `score/<stage>.ts`, start permissive).
- Seed the corpus: 2 hand-written fixtures per stage now (reuse the Step 7
  stub data), grow via `capture`.
- `server/package.json`: `"eval": "bun run evals/run.ts"`,
  `"gentrack:capture": "bun run evals/capture.ts"`.

**Verify**: `cd server && bun run eval` runs all stages' deterministic
scorers on the seed fixtures and exits 0.

### Step 9: Docs

CLAUDE.md: add the eval commands to the table; one architecture bullet under
`server`: "AI track generation pipeline (`src/gentrack/`): staged
`generateRoute → findStops → researchStop → draftStop → synthesizeStop →
materializeTrack`, every stage a pure `(input, deps)` function with
zod-validated IO persisted per run in `gentrack_steps` — see
`server/evals/` for the per-stage eval harness." Update `.env.example`
(done in Step 3) and `plans/README.md` status row.

**Verify**: every command written into CLAUDE.md has been run and worked.

## Test plan

Covered by Steps 7–8 (that separation is deliberate: **tests gate, evals
measure**). Definition of done for coverage: every stage has ≥2 unit cases
(happy + failure/refusal), the orchestrator has persistence + resume cases,
the router has auth + full-pipeline cases, and `bun run eval` scores every
stage on ≥2 fixtures.

## Done criteria

- [ ] `bun run typecheck` exit 0 (all workspaces)
- [ ] `cd packages/shared && bun test` — gentrack schema + geo helper tests pass
- [ ] `cd server && bun test` — all pass with **zero live network calls**
- [ ] `cd server && bun run eval` exit 0 on seed fixtures
- [ ] Manual curl transcript: run created → route chosen → stops found →
      fill (`synthesizeAudio:false`) → `filled` → materialize → draft track
      + spots visible in the admin API, provenance has `genRunId`
- [ ] `gentrack_steps` rows for that run contain full input AND output JSON
      for every executed stage (`SELECT name, status, input IS NOT NULL,
      output IS NOT NULL FROM gentrack_steps WHERE run_id = …`)
- [ ] `bun run gentrack:capture <that run>` writes fixtures that
      `bun run eval` accepts
- [ ] Existing suites untouched and green; no changes under `server/src/ai/`
      except the added `draftFromDossier` and `wikipediaExtract`
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report (do not improvise) if:

- The "Current state" excerpts don't match the live code.
- `@anthropic-ai/sdk`'s current version in this repo can't express what
  Step 3's `claude()` wrapper needs — report rather than upgrading the
  dependency.
- OSRM/Overpass response shapes differ materially from what Steps 3–4
  assume (verify each with ONE live curl during development and paste the
  response into your report + the test stubs).
- You find yourself wanting a job-queue/worker dependency — fire-and-poll
  with persisted steps is the decided v1 scope.
- Any step would require touching the public API surface.

## Maintenance notes

- **The stage contracts are load-bearing.** Upgrading a stage's internals
  (e.g. findStops → agentic tool-use loop, research → multi-hop) must keep
  its Input/Output schema; version with `FindStopsOutputV2` + a migration
  note if a break is truly needed, and keep old fixtures runnable.
- The OSRM demo + Overpass public endpoints are rate-limited, keyless,
  not-for-production; both are isolated behind `Deps` + env base URLs.
- `tracks.route` is written but unread for now — a follow-up can make the
  drive simulator prefer it over regenerating (note in plan 012).
- Cost controls: `numStops ≤ 25`, fill concurrency 2, `synthesizeAudio`
  flag; per-step `usage` is persisted — a cost report per run is a cheap
  future addition.
- Reviewer scrutiny: refusal-as-data in researchStop (never throw), the
  side-free assertion on drafts, and that no stage imports `fetch` or the
  SDK directly (grep `fetch(` under `src/gentrack/steps/` should hit nothing).
