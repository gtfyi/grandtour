# Plan 006: Integration-test the API routes against a real PostGIS database

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat $(grep -oE '[0-9a-f]{7,}' <(grep "Baseline commit" plans/README.md))..HEAD -- server/src server/tests server/db server/package.json`
> Plans 002–004 intentionally changed `server/src` — that is expected drift;
> re-read the touched routes before writing tests against them. On any
> mismatch with THIS plan's excerpts, STOP.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: LOW
- **Depends on**: plans/002-admin-api-hardening.md, plans/004-admin-spot-list.md
- **Category**: tests
- **Planned at**: baseline commit from plan 001, 2026-07-05

## Why this matters

`/api/nearby` is the hot path of the entire product — the iOS app polls it
continuously — and it has zero tests. Neither do any admin mutations. The 8
existing tests cover schema parsing and pure helpers only. The geo logic
(radius vs. polygon triggers, layer/mode filters) was verified manually once
and can regress invisibly. This plan stands up a disposable test database
and exercises the real HTTP surface end to end, giving every future plan a
safety net.

## Current state

- Test runner: `bun test` per workspace (`server/package.json` →
  `"test": "bun test tests"`). Existing pattern: `server/tests/align.test.ts`
  (bun:test `describe/test/expect`). Plans 002/003 added
  `admin-auth.test.ts` and `uploads.test.ts`, both driving the app via
  `import app from "../src/index"` + `app.fetch(new Request(...))` — reuse
  that pattern.
- DB connection: `server/src/db.ts` (14 lines) creates one client:

```ts
import postgres from "postgres";
import { env } from "./env";
export const sql = postgres(env.databaseUrl(), { ... });
```

  and `env.databaseUrl()` (`server/src/env.ts:14-16`) reads
  `process.env.DATABASE_URL` with a localhost default. So pointing tests at
  a different database is purely an env-var matter — but it must be set
  BEFORE `../src/index` (and therefore `db.ts`) is imported.
- Migrations: `bun run db:migrate` (root) → `server/db/migrate.ts`, which
  applies `server/db/001_init.sql` and `002_seed.sql`. Read `migrate.ts`
  before Step 1 to confirm it honors `DATABASE_URL` and note how it tracks
  applied migrations.
- Dev database: `docker compose up -d db` → PostGIS 16 on :5432, user/pass
  `postgres/postgres`, db `grandtour` (`docker-compose.yml`).
- Seed data (`server/db/002_seed.sql`): read it to learn the seeded layers/
  spots — tests may rely on schema but should create their own rows rather
  than depending on seed specifics.
- Key behaviors to pin (from `server/src/geo/queries.ts:76-112` and
  `server/src/content/repo.ts:217-261`):
  - A spot is returned within the outer `radiusM` cap; `triggered` is true
    when inside its own `radius_m` OR inside its `region` polygon.
  - Only `status='published'` spots appear (`queries.ts:105`).
  - Layer slug filter: `AND l.slug = ANY(...)` when `layers` non-empty.
  - Mode filter: spots with empty `modes` match any mode.
  - Content: best published piece per spot, preferring locale `"en"`
    (hardcoded at `public.ts:24` until plan 009 — write the test against
    current behavior and leave a comment referencing plan 009).
- Auth (post-002): admin routes need `Authorization: Bearer <ADMIN_TOKEN>`;
  set `process.env.ADMIN_TOKEN = "test-token"` in test setup before
  importing the app.

## Commands you will need

| Purpose        | Command                                                        | Expected on success |
|----------------|----------------------------------------------------------------|---------------------|
| DB up          | `docker compose up -d db`                                      | healthy             |
| Create test DB | `docker compose exec db psql -U postgres -c 'CREATE DATABASE grandtour_test'` | CREATE DATABASE (or "already exists") |
| Migrate test DB| `DATABASE_URL=postgres://postgres:postgres@localhost:5432/grandtour_test bun run db/migrate.ts` (from `server/`) | exit 0 |
| Tests          | `DATABASE_URL=postgres://postgres:postgres@localhost:5432/grandtour_test bun test tests` (from `server/`) | all pass |
| Typecheck      | `bun run typecheck` (repo root)                                | exit 0              |

## Scope

**In scope** (the only files you should modify/create):
- `server/tests/helpers.ts` (create — test-DB setup/teardown utilities)
- `server/tests/nearby.test.ts` (create)
- `server/tests/admin-routes.test.ts` (create)
- `server/package.json` (only if a `test:db` convenience script is added)
- `plans/README.md` (status row)

**Out of scope** (do NOT touch):
- Any file under `server/src/` — this plan is characterization; if a test
  reveals a bug, record it in your report (and as a note in
  `plans/README.md`) instead of fixing it.
- `docker-compose.yml` — the existing container hosts the test DB fine.
- The AI pipeline (`/generate` happy path) — it calls paid external APIs.
  Only its validation/404 paths are tested.

## Git workflow

- Branch: `advisor/006-route-integration-tests` off `main` (after 002 and
  004 are merged).
- Commit per test file, e.g. `Add /nearby integration tests`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Test-DB harness

Create `server/tests/helpers.ts`:

- Export `TEST_DATABASE_URL` =
  `postgres://postgres:postgres@localhost:5432/grandtour_test`.
- At module top (before anything imports the app):
  `process.env.DATABASE_URL = TEST_DATABASE_URL; process.env.ADMIN_TOKEN = "test-token";`
- Export `adminHeaders = { "Authorization": "Bearer test-token", "content-type": "application/json" }`.
- Export `resetDb(sql)` that truncates
  `content_pieces, spots, guides, layers` (`TRUNCATE ... CASCADE`).
- Export small builders `makeLayer(sql, over?)`, `makeSpot(sql, layerId, over?)`
  that INSERT minimal valid rows and return ids. Center spots near
  lat 40.70, lng -73.99 by default (matches README's sanity-check curl).
- Document at the top of the file: "Requires `docker compose up -d db` and
  a migrated `grandtour_test` database — see plans/006 Commands."

Guard against the dev DB: `resetDb` must throw if
`process.env.DATABASE_URL` does not end in `_test` (protects real data).

**Verify**: `bun run typecheck` → exit 0.

### Step 2: /nearby characterization tests

Create `server/tests/nearby.test.ts` importing helpers FIRST, then
`import app from "../src/index"`. Seed via builders in `beforeAll` (reset in
`beforeEach` where needed). Cases (each asserts on the parsed
`NearbyResponse` JSON):

1. Radius trigger: published spot with `radius_m=100`; query from its center
   → 1 spot, `triggered: true`, `distanceM < 1`.
2. Within outer cap but outside own radius: query ~500m away with
   `radiusM=2000` → returned, `triggered: false`.
3. Outside outer cap → empty `spots`.
4. Polygon trigger independent of radius: spot with `radius_m=10` and a
   `region` polygon covering a point ~300m from center; query from that
   point (with outer cap 2000) → `triggered: true`.
5. Draft spot invisible: `status='draft'` spot at the query point → empty.
6. Layer filter: two layers, query `layers=<slugA>` → only layer-A spots.
7. Mode filter: spot with `modes={driving}` invisible for `mode=walking`;
   spot with empty modes visible for any mode.
8. Content attachment: spot with a published content piece → `content` is
   non-null with that piece's id; spot with only a draft piece →
   `content: null`.
9. Validation: `lat=999` → 400 with `error: "invalid_query"`.

### Step 3: Admin route tests

Create `server/tests/admin-routes.test.ts` (same import order). Cases:

1. `POST /api/admin/layers` valid body → 201, row retrievable via
   `GET /api/admin/layers`.
2. `POST /api/admin/layers` invalid slug (`"Bad Slug!"`) → 400 `invalid_body`.
3. `POST /api/admin/spots` → 201; `GET /api/admin/spots` (plan 004's route)
   lists it including `status:"draft"`; `GET /api/admin/spots/:id` returns
   it with the trigger round-tripped (center/radius/region equal to input).
4. `PUT /api/admin/spots/:id` on a missing uuid → 404.
5. `PUT /api/admin/content` upsert twice with same
   (spotId, locale, variant) → second call updates rather than duplicates
   (`listContentForSpot` via `GET /api/admin/spots/:id` shows 1 piece).
6. `POST /api/admin/content/:id/status` with `"published"` → 200; with
   `"bogus"` → 400 (pins plan 002's validation).
7. `POST /api/admin/spots/:id/generate` on a missing spot → 404 (does not
   reach external APIs).
8. All of the above with a wrong bearer token → 401 (one parameterized case
   is enough).

**Verify (Steps 2–3 together)**: from `server/`:
`DATABASE_URL=postgres://postgres:postgres@localhost:5432/grandtour_test bun test tests`
→ all pass (existing + ~17 new). Then plain `cd packages/shared && bun test`
still passes (untouched).

### Step 4: Make it one command

Add to `server/package.json` scripts:
`"test:db": "DATABASE_URL=postgres://postgres:postgres@localhost:5432/grandtour_test bun test tests"`.
Note in your report that `bun test tests` without the env var will now fail
the DB-backed files if `grandtour_test` isn't reachable — that is accepted;
the pure-logic tests (`align`, `uploads`, `admin-auth`) must keep passing
without a DB, so keep all DB access confined to the two new files + helpers.

**Verify**: `cd server && bun run test:db` → all pass.

## Test plan

This plan IS the test plan. Structural pattern: `server/tests/align.test.ts`
for bun:test idioms; `app.fetch(new Request(...))` for HTTP (as in plans
002/003's test files).

## Done criteria

- [ ] `cd server && bun run test:db` exits 0 with ≥17 new tests across
      `nearby.test.ts` + `admin-routes.test.ts`
- [ ] `helpers.ts` refuses to truncate a non-`_test` database (unit-verify by
      asserting the throw in one test)
- [ ] `git diff --stat` shows no changes under `server/src/`
- [ ] `bun run typecheck` exits 0
- [ ] `plans/README.md` status row updated (and any bugs found recorded there)

## STOP conditions

Stop and report back (do not improvise) if:

- Docker/Postgres is unavailable on this machine (`docker compose up -d db`
  fails) — the DB-backed portion cannot proceed.
- `server/db/migrate.ts` does not honor `DATABASE_URL` (read it first) —
  report; do not patch it silently.
- Setting `process.env.DATABASE_URL` in helpers is too late because
  something imports `db.ts` earlier — restructure import order in the test
  files only; if that fails, report.
- A characterization test exposes a real bug in route behavior — pin the
  CURRENT behavior with a `// BUG?` comment, report it, and continue.

## Maintenance notes

- Plan 009 (locale/mode selection) will need to update case 8 in
  `nearby.test.ts` — the hardcoded-`"en"` expectation is marked with a
  comment referencing it.
- CI (future): the test-DB bootstrap commands in this plan are the exact
  recipe a CI job needs; keep them in sync with `docker-compose.yml`.
- Reviewer should scrutinize: truncation guard, and that no test depends on
  `002_seed.sql` row specifics.
