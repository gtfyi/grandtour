# Plan 002: Add bearer-token auth and input/output hardening to the admin API

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat $(grep -oE '[0-9a-f]{7,}' <(grep "Baseline commit" plans/README.md))..HEAD -- server/src admin/src .env.example`
> If any in-scope file changed since the baseline, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/001-vcs-baseline.md
- **Category**: security
- **Planned at**: baseline commit from plan 001, 2026-07-05

## Why this matters

Every route under `/api/admin/*` is completely unauthenticated. The README
acknowledges auth as a TODO, but one route makes this urgent:
`POST /api/admin/spots/:id/generate` calls Anthropic (Claude) and ElevenLabs
— **each request spends real money on the operator's API keys**. Anyone who
can reach the server can drain those accounts. Three smaller issues in the
same surface: (1) `POST /content/:id/status` writes any client-supplied
string into the DB `status` column unvalidated, corrupting the
draft/review/published/archived state machine; (2) generation failures
return raw upstream error text (`String(err)`) to the client, leaking
provider/library internals; (3) CORS is the wide-open default.

## Current state

- `server/src/index.ts` — Hono app wiring. Line 12: `app.use("*", cors())`
  (Hono default: `origin: *`). Line 19–20:

```ts
// Admin API consumed by the web admin. (Auth middleware goes here later.)
app.route("/api/admin", adminRouter);
```

- `server/src/routes/admin.ts` — all admin routes. Lines 64–70, the
  unvalidated status write:

```ts
adminRouter.post("/content/:id/status", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { status?: string };
  if (!body.status) return c.json({ error: "missing_status" }, 400);
  const content = await setContentStatus(sql, c.req.param("id"), body.status);
```

  Lines 98–100, the error-detail leak:

```ts
  } catch (err) {
    return c.json({ error: "generation_failed", detail: String(err) }, 502);
  }
```

- `server/src/env.ts` — the config accessor object (`export const env = {...}`)
  with helpers `required(name)` / `optional(name)` at the top. All new env
  vars must be added here, following the existing lazy-function style
  (e.g. `anthropicKey: () => optional("ANTHROPIC_API_KEY")`).
- `.env.example` — documents env vars. Has no ADMIN_TOKEN entry. Also
  missing `GEOCODIO_API_KEY`, which `env.ts:34` already reads — add it while
  you are in this file.
- `admin/src/api.ts` — fetch wrapper. Lines 10–20: single `req<T>()` helper
  that sets `content-type` and throws on `!res.ok`. All admin calls go
  through it. There is no auth header anywhere.
- `admin/src/App.tsx` — root component; holds `error` state and renders it
  (`{error && <div className="error">{error}</div>}`, line 235).
- `packages/shared/src/content.ts` line 77 — the status enum the server must
  validate against:

```ts
export const PublishStatus = z.enum(["draft", "review", "published", "archived"]);
```

- Validation convention: routes parse bodies with
  `X.safeParse(await c.req.json().catch(() => null))` and return
  `{ error: "invalid_body", detail: parsed.error.message }, 400` — see
  `admin.ts:27-31` (`POST /layers`). Match it.
- Dev server loads env from the repo-root `.env` via
  `bun --env-file=../.env --hot src/index.ts` (`server/package.json`), so a
  new var added to `.env` is picked up on restart.
- In dev the admin is served by Vite on :5180 and proxies `/api` to :8787
  (`admin/vite.config.ts`), so browser requests are same-origin; CORS
  changes will not break the dev admin.

## Commands you will need

| Purpose   | Command                                   | Expected on success |
|-----------|-------------------------------------------|---------------------|
| Install   | `bun install` (repo root)                 | exit 0              |
| Typecheck | `bun run typecheck` (repo root)           | exit 0              |
| Server tests | `cd server && bun test`                | all pass            |
| DB up     | `docker compose up -d db`                 | container healthy   |
| Migrate   | `bun run db:migrate` (repo root)          | exit 0              |
| Run server | `bun run dev:server` (repo root)         | "GrandTour server on http://localhost:8787" |

## Suggested executor toolkit

- If a `bun-hono-webservice` skill is available in your environment, load it
  before writing the middleware — it covers Hono middleware typing and
  strict-TS patterns used here.

## Scope

**In scope** (the only files you should modify):
- `server/src/index.ts`
- `server/src/routes/admin.ts`
- `server/src/env.ts`
- `.env.example`
- `admin/src/api.ts`
- `admin/src/App.tsx` (only the minimal token-entry UI described in Step 5)

**Out of scope** (do NOT touch, even though they look related):
- `server/src/routes/public.ts` — the public API must stay unauthenticated.
- `server/src/ai/*` — generation internals are not part of this plan.
- Cookie/session-based auth, user accounts, roles — a single shared bearer
  token is the deliberate scope here.
- The `/uploads/*` handler in `index.ts` (plan 003 owns it).

## Git workflow

- Branch: `advisor/002-admin-api-hardening` off `main`.
- Commit per step; plain imperative messages (repo has no established
  convention yet), e.g. `Require bearer token on admin API`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add ADMIN_TOKEN to env config

In `server/src/env.ts`, add to the `env` object, following the existing
style: `adminToken: () => optional("ADMIN_TOKEN"),`.

In `.env.example`, add under the PORT line:

```
# Shared secret for the admin API. Generate one: openssl rand -hex 32
ADMIN_TOKEN=
# Reverse geocoding for AI generation location anchoring
GEOCODIO_API_KEY=
```

Do not write any value into `.env` yourself; if `.env` needs the var for
manual testing, tell the operator at the end.

**Verify**: `bun run typecheck` → exit 0.

### Step 2: Auth middleware on the admin router

In `server/src/routes/admin.ts`, immediately after
`export const adminRouter = new Hono();`, register:

```ts
adminRouter.use("*", async (c, next) => {
  const token = env.adminToken();
  if (!token) {
    return c.json({ error: "admin_disabled", detail: "Set ADMIN_TOKEN to enable the admin API." }, 503);
  }
  const header = c.req.header("Authorization");
  if (header !== `Bearer ${token}`) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
});
```

Import `env` from `../env`. Fail-closed is deliberate: with no token
configured the admin API is off, never open. Also update the comment at
`server/src/index.ts:19` (remove "Auth middleware goes here later").

**Verify**: with the DB up and the server running with `ADMIN_TOKEN` unset,
`curl -s -o /dev/null -w '%{http_code}' http://localhost:8787/api/admin/layers`
→ `503`. Export a test token in `.env` temporarily is NOT needed — instead run:
`ADMIN_TOKEN=testtoken bun --env-file=../.env run src/index.ts` from `server/`
and check `curl -s -o /dev/null -w '%{http_code}' http://localhost:8787/api/admin/layers`
→ `401`, and with `-H 'Authorization: Bearer testtoken'` → `200`.
Also `curl -s -o /dev/null -w '%{http_code}' 'http://localhost:8787/api/nearby?lat=40&lng=-74'`
→ `200` (public route unaffected).

### Step 3: Validate status transitions with the shared enum

In `admin.ts`, replace the `POST /content/:id/status` body handling with the
repo's safeParse convention using a local schema:

```ts
const StatusBody = z.object({ status: PublishStatus });
```

(`import { z } from "zod"` and add `PublishStatus` to the existing
`@grandtour/shared` import.) On parse failure return
`{ error: "invalid_body", detail: parsed.error.message }, 400`.

**Verify**: `cd server && bun test` → pass;
authenticated `curl -X POST .../api/admin/content/00000000-0000-0000-0000-000000000000/status -d '{"status":"bogus"}' -H 'content-type: application/json' -H 'Authorization: Bearer testtoken'`
→ HTTP 400 with `invalid_body`.

### Step 4: Stop leaking upstream error detail from /generate

In the `catch` at `admin.ts:98-100`: log the full error server-side
(`console.error("generation_failed", spotId, err)` — include the spot id),
and return a stable message:
`{ error: "generation_failed", detail: "Narration generation failed. Check server logs." }, 502`.
Exception: the deliberate "refusing to generate; wrong-location" error thrown
by `server/src/ai/generate.ts:79-83` is a user-facing message the admin UI
relies on. Preserve it: `if (err instanceof Error && err.message.includes("Refusing to generate"))`
→ return `{ error: "generation_refused", detail: err.message }, 422`.

**Verify**: `bun run typecheck` → exit 0. `cd server && bun test` → pass.

### Step 5: Send the token from the admin client

In `admin/src/api.ts`, inside `req<T>()`, read
`localStorage.getItem("grandtour_admin_token")` and, when present, add
`Authorization: Bearer <token>` to the headers.

In `admin/src/App.tsx`, add a minimal token gate: a `token` state initialized
from the same localStorage key; when a request fails with the message
containing `unauthorized` or HTTP 401/503 (the `req` helper surfaces
`error`/`detail` strings), render a single password-type input + "Save token"
button (store to localStorage, then call `refresh()`). Keep styling consistent
with existing `.field` / `button` classes in `admin/src/styles.css`. Do not
add a router, context, or new dependencies.

**Verify**: `bun run typecheck` → exit 0. Manual: with the server running
with a token and the admin dev server up (`bun run dev:admin`), loading
http://localhost:5180 shows the token prompt; after entering the token,
layers load.

### Step 6: Constrain CORS

In `server/src/index.ts`, replace `app.use("*", cors())` with an
origin-restricted config read from env (add `allowedOrigins: () =>
(process.env.ALLOWED_ORIGINS ?? "http://localhost:5180").split(",")` to
`env.ts`):

```ts
app.use("*", cors({ origin: env.allowedOrigins() }));
```

Document `ALLOWED_ORIGINS` in `.env.example` (comment: comma-separated;
defaults to the dev admin origin). The iOS app is unaffected (native apps
don't send CORS preflights that need approval).

**Verify**: `curl -s -D - -o /dev/null -H 'Origin: http://evil.example' http://localhost:8787/api/layers | grep -i access-control-allow-origin`
→ no `access-control-allow-origin: http://evil.example` header (absent or
mismatched). With `-H 'Origin: http://localhost:5180'` → header echoes that
origin.

## Test plan

Server route tests are established comprehensively in plan 006; for this plan
add one focused file now, `server/tests/admin-auth.test.ts`, modeled
structurally on `server/tests/align.test.ts` (bun:test, describe/test):

- With `ADMIN_TOKEN` unset in the test env → `app.fetch` of
  `GET /api/admin/layers` returns 503.
- With `ADMIN_TOKEN=t` set (set `process.env.ADMIN_TOKEN` in the test before
  importing the router) → no header ⇒ 401; wrong token ⇒ 401.
- `POST /api/admin/content/x/status` with `{"status":"bogus"}` and a valid
  token ⇒ 400 (this exercises the enum validation without a DB because
  validation runs before the SQL call — confirm by reading the handler; if
  validation is after the DB call in your implementation, restructure so it
  is before).

Import the app via `import app from "../src/index"` and call
`app.fetch(new Request("http://localhost/api/admin/layers"))`. These cases
must not require a running Postgres.

**Verification**: `cd server && bun test` → all pass including the new file.

## Done criteria

- [ ] `bun run typecheck` exits 0
- [ ] `cd server && bun test` exits 0; `admin-auth.test.ts` exists with the 4 cases above
- [ ] `grep -n "String(err)" server/src/routes/admin.ts` → no matches
- [ ] `grep -n "cors()" server/src/index.ts` → no matches
- [ ] `.env.example` documents `ADMIN_TOKEN`, `ALLOWED_ORIGINS`, `GEOCODIO_API_KEY`
- [ ] No secret values appear in any committed file (`git diff main --stat` touches only in-scope files)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts in "Current state" don't match the live code.
- Importing `../src/index` in a test starts an actual listener or requires a
  live database — report instead of restructuring `index.ts` beyond moving
  the `app` construction (small export-only refactors of `index.ts` are
  allowed; anything touching the `/uploads` handler is not, plan 003 owns it).
- You find yourself wanting to add a dependency (jwt lib, session store) —
  the shared-bearer-token design is the decided scope.
- Anything requires writing a real token value into a committed file.

## Maintenance notes

- Plans 004 and 006 build on this: 004 adds a new admin route (it inherits
  the middleware automatically because the middleware is registered with
  `adminRouter.use("*")` before any route); 006 needs the test-token pattern
  established here.
- When real multi-user auth lands later, replace the middleware body, not
  the call sites; keep fail-closed 503 behavior for missing config.
- Reviewer should scrutinize: the middleware is registered BEFORE all routes
  in `admin.ts` (Hono applies middleware only to routes registered after it).
