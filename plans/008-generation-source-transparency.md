# Plan 008: Stop swallowing source-gathering failures in AI generation

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat $(grep -oE '[0-9a-f]{7,}' <(grep "Baseline commit" plans/README.md))..HEAD -- server/src/ai/generate.ts packages/shared/src/content.ts admin/src/ContentEditor.tsx`
> If any in-scope file changed since the baseline, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch,
> treat it as a STOP condition. (Plan 005 also edits `generate.ts` — its
> changes are in `alignAudioToSentences`/TTS handling, not the source-
> gathering block; both plans can land in either order.)

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-vcs-baseline.md
- **Category**: bug
- **Planned at**: baseline commit from plan 001, 2026-07-05

## Why this matters

During AI narration generation, Wikipedia and exa.ai lookups are wrapped in
`catch { /* non-fatal */ }`. Non-fatal is the right call — but the failure
is recorded nowhere: not logged, not surfaced in provenance. A reviewer in
the admin sees "AI content with sources" and cannot tell that generation ran
with fewer source channels than requested (e.g. exa key expired, Wikipedia
timeout). The generation pipeline already refuses on zero *vetted* sources,
but a run that silently lost one channel produces thinner narration with no
trace. Fix: log each failure server-side and record it in the piece's
provenance so the admin UI can disclose it.

## Current state

- `server/src/ai/generate.ts` lines 49–65 — the swallowed failures:

```ts
  const sources: SourceDoc[] = [];
  if (input.useWikipedia) {
    try {
      sources.push(...(await wikipediaNearby(center.lat, center.lng, { limit: 3 })));
    } catch { /* non-fatal */ }
  }
  if (input.useSearch) {
    try {
      const q = [ ... ].filter(Boolean).join(" ").trim();
      sources.push(...(await exaSearch(q)));
    } catch { /* non-fatal */ }
  }
```

  and lines 119–126 — the provenance object built at the end
  (`model`, `ttsProvider`, `voiceId`, `sources`, `prompt`, `generatedAt`).
- `packages/shared/src/content.ts` lines 112–121 — `GenerationProvenance`
  zod object (all fields optional/defaulted). The DB stores it as JSONB
  (`content_pieces.provenance`), so adding an optional field needs no
  migration.
- `admin/src/ContentEditor.tsx` lines 98–111 — renders
  `content.provenance.sources` as a link list inside a `.field` block; the
  `muted` CSS class is the established style for secondary text.
- Server logging convention: bare `console.log`/`console.error` (see
  `server/src/index.ts:104`, and plan 002 adds `console.error` in the
  generate route). No logging framework — don't add one.

## Commands you will need

| Purpose      | Command                          | Expected on success |
|--------------|----------------------------------|---------------------|
| Typecheck    | `bun run typecheck` (repo root)  | exit 0              |
| Shared tests | `cd packages/shared && bun test` | all pass            |
| Server tests | `cd server && bun test`          | all pass            |

## Scope

**In scope** (the only files you should modify):
- `packages/shared/src/content.ts` (one optional field)
- `server/src/ai/generate.ts` (the two catch blocks + provenance assembly)
- `admin/src/ContentEditor.tsx` (display warnings when present)
- `packages/shared/tests/schema.test.ts` (one added assertion)

**Out of scope** (do NOT touch):
- `server/src/ai/search.ts` — failures are handled at the call site.
- Retry logic, timeouts, circuit breakers — out of scope; failures stay
  non-fatal and single-attempt.
- The refusal behavior at `generate.ts:78-83` — already correct.

## Git workflow

- Branch: `advisor/008-generation-source-transparency` off `main`.
- One or two commits, e.g. `Record source-gathering failures in provenance`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Schema field

In `GenerationProvenance` (`packages/shared/src/content.ts`), add:

```ts
  /** Non-fatal problems during generation (e.g. a source channel failed). */
  warnings: z.array(z.string()).default([]),
```

Extend the round-trip test in `packages/shared/tests/schema.test.ts`: parse
a provenance-bearing `ContentPieceInput` that includes
`warnings: ["exa search failed"]` and assert it survives; also assert a
provenance WITHOUT `warnings` parses (default `[]`) — this proves existing
DB rows stay valid.

**Verify**: `cd packages/shared && bun test` → pass; `bun run typecheck` → exit 0.

### Step 2: Collect and log failures in generateNarration

In `generate.ts`, before the source-gathering block add
`const warnings: string[] = [];`. Change the catches:

```ts
    } catch (err) {
      const msg = `wikipedia geosearch failed: ${err instanceof Error ? err.message : String(err)}`;
      console.warn(`[generate] spot ${input.spot.id}: ${msg}`);
      warnings.push(msg);
    }
```

(and equivalently `exa search failed: ...` for the second block). Include
`warnings` in the provenance object built at lines 119–126. Note the
warning strings may contain upstream error text — they are stored and shown
only in the authenticated admin, never on the public API (`/nearby` returns
whole ContentPiece rows including provenance — check: `assembleNearby` maps
full pieces. Therefore KEEP THE MESSAGES GENERIC: provider name + status
code only. Do not include response bodies: use
`err instanceof Error ? err.message.slice(0, 200) : "unknown error"` and
strip anything after a newline).

**Verify**: `bun run typecheck` → exit 0; `cd server && bun test` → pass.

### Step 3: Show warnings in the admin editor

In `ContentEditor.tsx`, below the existing Sources block (after line 111),
render when `content?.provenance?.warnings?.length`:

```tsx
      {content?.provenance?.warnings?.length ? (
        <div className="field">
          <label>Generation warnings</label>
          <ul className="muted" style={{ margin: 0, paddingLeft: 16 }}>
            {content.provenance.warnings.map((w, i) => (
              <li key={i}>⚠️ {w}</li>
            ))}
          </ul>
        </div>
      ) : null}
```

**Verify**: `bun run typecheck` → exit 0.

## Test plan

- Shared: the two schema assertions from Step 1 (with/without `warnings`).
- Server: no new server test is required — `generateNarration`'s happy path
  needs live external APIs (out of scope to mock here; plan 006 deliberately
  excludes it). The change is exercised by typecheck + the schema tests.
  If plan 006's harness already exists and mocking `search.ts` is trivial in
  bun:test via module mocking, a single test (wikipedia throws → provenance
  warnings non-empty) is a welcome bonus, not a requirement.

## Done criteria

- [ ] `bun run typecheck` exits 0
- [ ] `cd packages/shared && bun test` exits 0 with the new assertions
- [ ] `grep -n "catch { /\* non-fatal \*/ }" server/src/ai/generate.ts` → no matches
- [ ] `grep -n "warnings" packages/shared/src/content.ts admin/src/ContentEditor.tsx server/src/ai/generate.ts` → matches in all three
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts don't match the live code (beyond plan 005's documented
  changes to other parts of `generate.ts`).
- Adding the schema field breaks parsing of existing rows in a way the
  default doesn't cover (visible as failures in the shared round-trip test).

## Maintenance notes

- Public exposure: provenance (including warnings) rides along on `/nearby`
  responses today. If provenance is ever deemed private, strip it in
  `assembleNearby` — that decision is bigger than this plan and was left
  alone; the generic-message rule in Step 2 is the mitigation.
- If retry logic is added later, push it into `search.ts` and keep the
  warning semantics ("failed after N attempts").
