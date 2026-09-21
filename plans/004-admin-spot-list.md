# Plan 004: Give the admin a real spot list (drafts included, any location)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat $(grep -oE '[0-9a-f]{7,}' <(grep "Baseline commit" plans/README.md))..HEAD -- server/src/routes/admin.ts server/src/content/repo.ts admin/src`
> If any in-scope file changed since the baseline, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch,
> treat it as a STOP condition. Note: plan 002 intentionally modifies
> `admin.ts` and `admin/src/api.ts` (auth); those diffs are expected —
> verify the specific excerpts below still hold.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: plans/002-admin-api-hardening.md (execute after it to avoid conflicts in `admin.ts`/`api.ts`; functionally independent)
- **Category**: bug
- **Planned at**: baseline commit from plan 001, 2026-07-05

## Why this matters

The admin's map and "Spots nearby" list are populated from the **public**
`/api/nearby` endpoint, hardcoded to a point in NYC with an 8km radius. That
endpoint filters `WHERE s.status = 'published'`. Consequences: a newly saved
draft spot vanishes from the admin UI the moment it's created (there is no
other way to reselect it — its edit panel is gone forever once closed), and
any spot outside 8km of downtown Manhattan is invisible regardless of
status. The core authoring loop — create draft → edit → generate → publish —
is broken for exactly the drafts it exists to manage. Fix: a dedicated admin
list endpoint (all statuses, no geo filter) and use it in the UI, flying the
map to the selected spot.

## Current state

- `admin/src/App.tsx` lines 35–44 — the buggy load:

```ts
  const refresh = useCallback(async () => {
    try {
      const ls = await api.listLayers();
      setLayers(ls);
      const { spots } = await api.nearby(40.7128, -74.0059, 8000);
      setSpots(spots.map((s: any) => s.spot));
    } catch (e) {
      setError(String(e));
    }
  }, []);
```

- `server/src/geo/queries.ts:105` — why drafts disappear:
  `WHERE s.status = 'published'` inside `findNearby` (do not change this —
  it is correct for the public API).
- `server/src/routes/admin.ts` — has `GET /spots/:id`, `POST /spots`,
  `PUT /spots/:id`; **no list route**. Routes return DTOs built by
  `server/src/content/repo.ts` mappers.
- `server/src/content/repo.ts` lines 109–118 — `getSpot` shows the exact
  SELECT shape to reuse (GeoJSON casts for `center`/`region`):

```ts
  const [row] = await sql`
    SELECT id, layer_id, title, subtitle,
           ST_AsGeoJSON(center)::json AS center, radius_m,
           ST_AsGeoJSON(region)::json AS region,
           modes, guide_id, status, created_by, created_at, updated_at
    FROM spots WHERE id = ${id}
  `;
  return row ? rowToSpot(row) : null;
```

- `admin/src/api.ts` — the fetch wrapper; every method is a one-liner over
  `req<T>()`. `nearby()` (lines 65–66) is documented as "handy for
  previewing" — keep it, just stop using it as the primary list.
- `admin/src/MapView.tsx` — receives `spots: Spot[]` and renders markers
  (effect at lines 87–105). It holds the map in `mapRef`. There is currently
  no way for App to move the camera; `onSelect(id)` fires when a marker is
  clicked. Map is initialized centered on NYC (line 54) — that default can
  stay.
- Repo conventions: admin routes validate with zod `safeParse` and return
  `c.json(...)`; repo functions take `sql` as first arg and return mapped
  DTOs (see excerpts above). After plan 002, all `/api/admin/*` requests
  require the bearer token — the client wrapper already attaches it.

## Commands you will need

| Purpose   | Command                            | Expected on success |
|-----------|------------------------------------|---------------------|
| Typecheck | `bun run typecheck` (repo root)    | exit 0              |
| Server tests | `cd server && bun test`         | all pass            |
| DB up     | `docker compose up -d db`          | healthy             |
| Migrate   | `bun run db:migrate` (repo root)   | exit 0              |
| Run both  | `bun run dev:server` / `bun run dev:admin` | :8787 / :5180 |

## Scope

**In scope** (the only files you should modify):
- `server/src/content/repo.ts` (add `listSpots`)
- `server/src/routes/admin.ts` (add `GET /spots`)
- `admin/src/api.ts` (add `listSpots`)
- `admin/src/App.tsx` (use it; pass a fly-to signal)
- `admin/src/MapView.tsx` (fly to selected spot)

**Out of scope** (do NOT touch):
- `server/src/geo/queries.ts` — the published-only filter in `findNearby`
  is correct for the public app; do not weaken it.
- `server/src/routes/public.ts` — no admin concerns may leak into the
  public API.
- Pagination/search UI — with today's data volumes a plain
  `LIMIT 500` list is fine; note it visibly (Step 1) rather than building UI.

## Git workflow

- Branch: `advisor/004-admin-spot-list` off `main` (after plan 002 is merged;
  otherwise branch off 002's branch and say so in your report).
- Commit per step, imperative messages, e.g. `Add admin spot list endpoint`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: `listSpots` in the repo layer

In `server/src/content/repo.ts`, add below `getSpot`:

```ts
export async function listSpots(sql: Sql, opts: { limit?: number } = {}): Promise<Spot[]> {
  const limit = Math.min(opts.limit ?? 500, 1000);
  const rows = await sql`
    SELECT id, layer_id, title, subtitle,
           ST_AsGeoJSON(center)::json AS center, radius_m,
           ST_AsGeoJSON(region)::json AS region,
           modes, guide_id, status, created_by, created_at, updated_at
    FROM spots ORDER BY updated_at DESC
    LIMIT ${limit}
  `;
  return rows.map(rowToSpot);
}
```

All statuses, newest-edited first (so fresh drafts appear at the top of the
admin list).

**Verify**: `bun run typecheck` → exit 0.

### Step 2: `GET /api/admin/spots` route

In `server/src/routes/admin.ts`, add above the existing `GET /spots/:id`
(Hono matches literal segments before params either way, but keeping list
above detail reads conventionally):

```ts
adminRouter.get("/spots", async (c) => {
  const limit = Number(c.req.query("limit") ?? 500);
  return c.json({ spots: await listSpots(sql, { limit: Number.isFinite(limit) ? limit : 500 }) });
});
```

Add `listSpots` to the existing `../content/repo` import.

**Verify**: with DB up, migrated, server running with a token (see plan 002),
`curl -s -H 'Authorization: Bearer <token>' http://localhost:8787/api/admin/spots | head -c 300`
→ JSON starting `{"spots":[` and containing seed spots with `"status"`
fields including non-published ones (the seed data in
`server/db/002_seed.sql` includes drafts; if the DB is empty, create a draft
spot via `POST /api/admin/spots` first and re-check).

### Step 3: Use it in the admin client

In `admin/src/api.ts` add:

```ts
  listSpots: () => req<{ spots: Spot[] }>("/api/admin/spots").then((r) => r.spots),
```

In `admin/src/App.tsx` `refresh()` (lines 35–44), replace the
`api.nearby(...)` call and mapping with `setSpots(await api.listSpots());`.
Leave `api.nearby` itself in `api.ts` (it is documented as a preview helper).

**Verify**: `bun run typecheck` → exit 0.

### Step 4: Fly the map to the selected spot

The list now contains spots anywhere on Earth, so selecting one must move
the camera. In `App.tsx`'s `selectSpot`, after `setDraft(...)`, nothing more
is needed if you implement the move inside MapView: add to `MapView`'s
existing draft-render effect (lines 108–111) a camera move when the draft
center changes:

```ts
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !props.draft) return;
    const { lng, lat } = props.draft.center;
    const cur = map.getCenter();
    // Only fly when meaningfully far, so radius-slider edits don't jiggle the camera.
    if (Math.abs(cur.lng - lng) > 0.02 || Math.abs(cur.lat - lat) > 0.02) {
      map.flyTo({ center: [lng, lat], zoom: Math.max(map.getZoom(), 13) });
    }
  }, [props.draft?.center.lng, props.draft?.center.lat]);
```

Keep it a separate effect; do not merge it into the draft-geometry effect.

**Verify**: `bun run typecheck` → exit 0. Manual: run server + admin, create
a spot, save it (status stays `draft`), close the panel → the spot is still
in the "Spots nearby" list with a `· draft` suffix and clicking it reopens
the editor and centers the map on it.

## Test plan

- `server/tests/` gets its full route coverage in plan 006; for this plan,
  add to plan 002's `server/tests/admin-auth.test.ts` one case: unauthenticated
  `GET /api/admin/spots` → 401 (confirms the new route inherited the
  middleware). DB-backed list assertions land with plan 006's harness.
- The decisive verification here is the manual loop in Step 4's verify
  (draft persistence through create → close → reselect).

## Done criteria

- [ ] `bun run typecheck` exits 0
- [ ] `cd server && bun test` exits 0 (including the new 401 case)
- [ ] `grep -n "api.nearby" admin/src/App.tsx` → no matches
- [ ] Manual loop from Step 4 verified (state it explicitly in your report)
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `App.tsx`'s `refresh` or `repo.ts`'s `getSpot` don't match the excerpts.
- Plan 002 has not been executed AND you cannot reach the admin routes
  (503/401 with no token infrastructure) — coordinate rather than disabling
  auth.
- `rowToSpot` fails on list rows (e.g. `region` GeoJSON shape mismatch) —
  that would indicate a mapper bug beyond this plan's scope.

## Maintenance notes

- When spot count grows past ~500, add real pagination (`?before=<updatedAt>`)
  and a bbox filter — the `LIMIT` and its cap in Step 1 are the marker for
  where that goes.
- If a "guides" admin panel is built later (see plans/README Direction), it
  should follow exactly this endpoint + repo-function + api.ts shape.
- Reviewer should scrutinize: the public `/nearby` remains published-only
  (`git diff` must not touch `geo/queries.ts`).
