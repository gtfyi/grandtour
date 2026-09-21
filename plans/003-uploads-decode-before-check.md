# Plan 003: Decode the /uploads key before the traversal check

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat $(grep -oE '[0-9a-f]{7,}' <(grep "Baseline commit" plans/README.md))..HEAD -- server/src/index.ts server/src/ai/storage.ts server/tests`
> If any in-scope file changed since the baseline, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-vcs-baseline.md
- **Category**: security
- **Planned at**: baseline commit from plan 001, 2026-07-05

## Why this matters

The audio-serving route guards against path traversal by rejecting keys
containing `..` — but it checks the **raw** URL path and only afterwards
URL-decodes it. A request whose path contains `%2e%2e` (the percent-encoded
form of `..`) sails past the check and reaches the storage layer decoded.
Today the blast radius is limited: the local-dev backend flattens `/` to `_`
before touching the filesystem, and the S3 backend is scoped to one dedicated
bucket. But the check exists to enforce an invariant and is trivially
bypassable, and future storage changes (e.g. key prefixes, a shared bucket)
would silently inherit the hole. Fix the ordering and pin the allowed key
shape.

## Current state

- `server/src/index.ts` lines 25–29 — the vulnerable ordering:

```ts
app.on(["GET", "HEAD"], "/uploads/*", async (c) => {
  const key = c.req.path.slice("/uploads/".length);
  if (!key || key.includes("..")) return c.notFound();

  const obj = await getAudio(decodeURIComponent(key));
```

- `server/src/ai/storage.ts` — `getAudio(key)`:
  - S3 branch (lines 89–101): passes `key` directly to `client.file(key)`.
  - Local branch (lines 104–115): `join(LOCAL_DIR, key.replace(/\//g, "_"))`
    — traversal-safe because separators are flattened, matching how
    `putAudio` writes (line 39).
- Keys actually written by the pipeline have the shape
  `narration/<spot-uuid>/<locale>-<variant>.mp3`
  (`server/src/ai/generate.ts:109`), which the local backend stores as
  `narration_<uuid>_<locale>-<variant>.mp3`.
- Existing tests: `server/tests/align.test.ts` (bun:test style — use as the
  structural pattern).

## Commands you will need

| Purpose   | Command                          | Expected on success |
|-----------|----------------------------------|---------------------|
| Typecheck | `bun run typecheck` (repo root)  | exit 0              |
| Tests     | `cd server && bun test`          | all pass            |
| Run server | `bun run dev:server` (repo root) | listening on :8787  |

## Scope

**In scope** (the only files you should modify/create):
- `server/src/index.ts` (the `/uploads/*` handler only)
- `server/tests/uploads.test.ts` (create)

**Out of scope** (do NOT touch):
- `server/src/ai/storage.ts` — the flattening behavior is load-bearing
  (files on disk are already named with `_`); changing it would orphan
  existing uploads.
- The Range-parsing logic (`parseRange`) in the same file — it is correct
  and tested behavior; don't reformat or "improve" it.
- Auth for `/uploads` — audio URLs are deliberately public (the iOS app
  fetches them unauthenticated).

## Git workflow

- Branch: `advisor/003-uploads-decode-before-check` off `main` (rebase onto
  002's branch if it is not yet merged and you get conflicts in `index.ts` —
  002 only touches lines 12 and 19–20 of this file, so conflicts are unlikely).
- One commit, e.g. `Decode uploads key before traversal check`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Decode first, then validate against an allowlist shape

Replace the two key lines in the handler with:

```ts
  let key: string;
  try {
    key = decodeURIComponent(c.req.path.slice("/uploads/".length));
  } catch {
    return c.notFound(); // malformed percent-encoding
  }
  // Keys are pipeline-generated: letters/digits and _ - . / only, no dot-dot.
  if (!key || key.includes("..") || !/^[\w\-./]+$/.test(key)) return c.notFound();

  const obj = await getAudio(key);
```

Notes: `decodeURIComponent` throws a `URIError` on bad input like `%zz` —
that's what the try/catch handles (the old code would have thrown a 500
there too; this fixes that for free). The character allowlist matches every
key `putAudio` can produce (see Current state) with room for `/`-prefixed S3
keys.

**Verify**: `bun run typecheck` → exit 0.

### Step 2: Regression tests

Create `server/tests/uploads.test.ts` (bun:test, modeled on
`align.test.ts`). Import the app: `import app from "../src/index";` and
drive it with `app.fetch(new Request(url))`. Cases:

1. `GET /uploads/%2e%2e/etc/passwd` → 404 (the encoded-traversal bypass, the
   bug this plan fixes).
2. `GET /uploads/../etc/passwd` → 404 (raw form still rejected; note many
   HTTP clients normalize this before it reaches the server, which is why
   the encoded form matters — `app.fetch` with a hand-built `Request` does
   not normalize).
3. `GET /uploads/%zz` → 404, not a thrown error (malformed encoding).
4. `GET /uploads/no-such-file.mp3` → 404 (well-formed key, missing object).
5. Happy path: write a small temp file into the local uploads dir
   (`server/uploads/test-fixture.mp3`, a few bytes) in the test setup,
   `GET /uploads/test-fixture.mp3` → 200 with `accept-ranges: bytes`; and
   with header `Range: bytes=0-1` → 206 and `content-length: 2`. Delete the
   fixture in an `afterAll`.

These tests must run without Postgres or S3 env vars (the local storage
fallback is active when STORAGE_* are unset).

**Verify**: `cd server && bun test` → all pass, including 5+ new tests.

## Test plan

Covered by Step 2 — that file IS the test plan. The Range-request assertions
double as characterization tests for the untouched `parseRange` logic.

## Done criteria

- [ ] `bun run typecheck` exits 0
- [ ] `cd server && bun test` exits 0, `uploads.test.ts` exists with the 5 cases
- [ ] In `server/src/index.ts`, `decodeURIComponent` appears BEFORE the
      `includes("..")` check in the handler (visual check of the diff)
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The handler in `index.ts` doesn't match the "Current state" excerpt.
- Importing `../src/index` in a test fails or requires a live database.
- The happy-path test fails in a way that implicates `getAudio` or
  `parseRange` rather than your change — those are out of scope; report the
  finding.
- Real narration keys exist that the `[\w\-./]+` allowlist rejects (check
  any files in `server/uploads/` — if a filename contains characters outside
  the allowlist after URL-decoding, widen cautiously and note it).

## Maintenance notes

- If storage ever moves to user-supplied filenames (e.g. creator uploads,
  see plans/README "Direction"), this allowlist is the choke point to
  revisit — user input must be sanitized at write time too, not just read.
- Reviewer should scrutinize: the regex anchors (`^`…`$`) and that the 416/
  Range behavior is unchanged (the tests assert it).
