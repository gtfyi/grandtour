# Plan 009: Wire locale through /nearby content selection

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat $(grep -oE '[0-9a-f]{7,}' <(grep "Baseline commit" plans/README.md))..HEAD -- packages/shared/src/api.ts server/src/routes/public.ts server/tests/nearby.test.ts`
> If any in-scope file changed since the baseline, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-vcs-baseline.md (and, if landed, updates plan 006's tests)
- **Category**: bug
- **Planned at**: baseline commit from plan 001, 2026-07-05

## Why this matters

The content model supports localized narration end to end — `ContentPiece`
has a `locale`, the DB has a `(spot_id, locale, variant)` unique key, the
generation request takes a locale, and `assembleNearby` accepts a `locale`
argument to prefer matching pieces. But the public API never lets a client
say which locale it wants: `NearbyQuery` has no locale field and the route
hardcodes `"en"`. A Spanish content piece can be authored and published
today and no client can ever receive it while an English one exists. One
parameter closes the loop.

## Current state

- `packages/shared/src/api.ts` lines 17–32 — `NearbyQuery` (zod, coercing
  query strings): fields `lat, lng, radiusM, layers, mode, limit`. No locale.
- `server/src/routes/public.ts` lines 10–26 — the route; line 24:

```ts
  const spots = await assembleNearby(sql, rows, "en");
```

- `server/src/content/repo.ts` lines 217–231 — `assembleNearby(sql, rows,
  locale)` already implements the preference:

```sql
    SELECT DISTINCT ON (spot_id) *
    FROM content_pieces
    WHERE spot_id = ANY(${spotIds}) AND status = 'published'
    ORDER BY spot_id, (locale = ${locale}) DESC, updated_at DESC
```

  i.e. exact-locale match wins, otherwise most recently updated published
  piece of any locale. No change needed there.
- If plan 006 landed: `server/tests/nearby.test.ts` case 8 pins the
  hardcoded-`"en"` behavior with a comment referencing this plan.
- Convention for query params in `NearbyQuery`: `z.coerce`/`.default(...)`
  per field; locale strings elsewhere in the codebase are plain BCP-47-ish
  lowercase (`"en"`), validated only as non-empty strings — don't invent a
  stricter format here.

## Commands you will need

| Purpose      | Command                                 | Expected on success |
|--------------|------------------------------------------|---------------------|
| Typecheck    | `bun run typecheck` (repo root)         | exit 0              |
| Shared tests | `cd packages/shared && bun test`        | all pass            |
| Server tests | `cd server && bun run test:db` (if plan 006 landed) else `bun test tests` | all pass |

## Scope

**In scope** (the only files you should modify):
- `packages/shared/src/api.ts`
- `packages/shared/tests/schema.test.ts` (extend the NearbyQuery test)
- `server/src/routes/public.ts`
- `server/tests/nearby.test.ts` (only if plan 006 landed)

**Out of scope** (do NOT touch):
- Mode-aware **variant** selection ("drive-by vs deep dive") — the schema
  comments promise it, but variant-to-mode mapping is an unmade product
  decision. Deliberately deferred; recorded in plans/README.md.
- iOS: sending the device locale is deferred to follow-up (noted in plan
  007's maintenance notes) — this plan is server + schema only.
- `assembleNearby` — its locale handling is already correct.

## Git workflow

- Branch: `advisor/009-nearby-locale` off `main`.
- One commit, e.g. `Accept locale on /nearby and honor it in content selection`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Schema

In `NearbyQuery` (`packages/shared/src/api.ts`), after `mode`:

```ts
  /** Preferred content locale; server falls back to any published piece. */
  locale: z.string().min(1).max(35).default("en"),
```

Extend the existing `NearbyQuery` test in
`packages/shared/tests/schema.test.ts`: parsing without `locale` yields
`"en"`; parsing `{ ..., locale: "es" }` yields `"es"`.

**Verify**: `cd packages/shared && bun test` → pass.

### Step 2: Route

In `server/src/routes/public.ts:24`, replace the literal:

```ts
  const spots = await assembleNearby(sql, rows, q.locale);
```

**Verify**: `bun run typecheck` → exit 0.

### Step 3: Integration test (only if plan 006's harness exists)

In `server/tests/nearby.test.ts`, update/extend case 8: seed one spot with
two published pieces (`locale: "en"` and `locale: "es"`, distinct variants
are not needed — use variant `"default"` and `"default"`... note the DB
unique key is `(spot_id, locale, variant)`, so same variant with different
locales is fine). Assert:

- `GET /api/nearby?...&locale=es` → `content.locale === "es"`.
- `GET /api/nearby?...` (no param) → `content.locale === "en"`.
- `GET /api/nearby?...&locale=fr` (no French piece) → content non-null
  (fallback to most recent published, per the `ORDER BY` above).

Remove the `// BUG?`/plan-009 comment left by plan 006.

**Verify**: `cd server && bun run test:db` → all pass.

## Test plan

Steps 1 and 3 above. If plan 006 has NOT landed, the schema tests plus
typecheck are the gate, and note in your report that the integration cases
should be added when 006 lands.

## Done criteria

- [ ] `bun run typecheck` exits 0
- [ ] `cd packages/shared && bun test` exits 0 with the locale assertions
- [ ] `grep -n '"en"' server/src/routes/public.ts` → no matches
- [ ] (If 006 landed) `cd server && bun run test:db` exits 0 with the three locale cases
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts don't match the live code.
- The `DISTINCT ON` ordering in `assembleNearby` doesn't behave as
  documented when you test it (would indicate a pre-existing bug — report,
  don't patch it here).

## Maintenance notes

- iOS follow-up: add `locale` (from `Locale.current.language.languageCode`)
  to `GrandTourAPI.nearby()`'s query items — one line, deferred with plan
  007's notes.
- Mode-aware variant selection remains open: when the product decides how
  variants map to activity modes (e.g. a `variantForMode` column or naming
  convention), extend the same `ORDER BY` ranking in `assembleNearby`.
- Reviewer should scrutinize: `locale` never reaches SQL unparameterized
  (it flows through the `postgres` tagged template, which parameterizes —
  confirm no string concatenation was introduced).
