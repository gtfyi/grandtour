# Plan 010: Add CLAUDE.md and .editorconfig (agent + editor onboarding)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `ls CLAUDE.md .editorconfig 2>/dev/null` —
> if either file already exists, STOP (someone got here first); otherwise
> spot-check the facts below against the live repo (they are the content of
> the doc you will write, so they must be true at execution time).

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-vcs-baseline.md (ideally last — the doc should
  reflect plans 002–009 if they have landed; check `plans/README.md` status
  and describe the repo AS IT IS)
- **Category**: dx
- **Planned at**: baseline commit from plan 001, 2026-07-05

## Why this matters

This repo's plans (this directory) are written to be executed by coding
agents, and future feature work will be too. A `CLAUDE.md` at the root is
loaded automatically by Claude Code and equivalents — it's the highest-
leverage 60 lines of documentation the repo can have: commands that actually
work, the domain vocabulary, and the two or three invariants that are easy
to violate. An `.editorconfig` keeps whitespace consistent across Xcode,
VS Code, and editors in between. (ESLint/Prettier were considered and
deliberately deferred — single-author repo, consistent style already, and
tool config churn isn't worth it yet; see plans/README.md rejected list.)

## Current state (the facts the doc must contain — verify each)

- Monorepo layout: `packages/shared` (zod schemas/types), `server`
  (Bun + Hono + PostGIS), `admin` (Vite + React + MapLibre), `ios`
  (SwiftUI via XcodeGen), `scripts/dev.ts` (dev orchestrator).
- Domain model: `Layer ──< Spot ──< ContentPiece`; a Spot's geo trigger is
  center + radiusM + optional polygon region; a ContentPiece's text is a
  filo document (immutable text addressed by UTF-8 byte offsets, tiers of
  annotations; the `audio` tier aligns time ranges to byte ranges).
- filo is a **local path dependency** (`file:../../filo` in
  `server/package.json` and `admin/package.json`) — the repo only installs
  when `../filo` exists as a sibling checkout. This surprises everyone; it
  goes in the doc.
- Commands (verify each still works before writing it down):
  - `bun install` (root; workspaces)
  - `docker compose up -d db` (PostGIS 16)
  - `bun run db:migrate` (applies `server/db/*.sql`)
  - `bun run dev:server` → :8787 (loads repo-root `.env` via `--env-file=../.env`)
  - `bun run dev:admin` → :5180 (Vite, proxies `/api` → :8787)
  - `bun run typecheck` (root, all workspaces)
  - `cd packages/shared && bun test`; `cd server && bun test`
    (+ `bun run test:db` for DB-backed tests, if plan 006 landed)
  - `cd ios && xcodegen generate` then open `GrandTour.xcodeproj`
- Env vars: documented in `.env.example` (`DATABASE_URL`, `PORT`,
  `ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY`/`ELEVENLABS_VOICE_ID`,
  `EXA_API_KEY`, `STORAGE_*`; plus `ADMIN_TOKEN`, `ALLOWED_ORIGINS`,
  `GEOCODIO_API_KEY` if plan 002 landed). Names only — never values.
- Invariants worth stating (each earned by a real bug or a real decision):
  - All byte offsets are UTF-8; convert to platform string indices only via
    the tested helpers (`byteToStringIndex` in `@grandtour/shared` after
    plan 005; `stringRange` in `TranscriptView.swift`). Never index text
    by UTF-16 units when counting bytes.
  - The public `/nearby` must only ever return `status='published'` spots
    and content; admin surfaces use `/api/admin/*`.
  - PostGIS `GEOGRAPHY` + `ST_DWithin`/`ST_Covers` is the decided geo
    approach (see README "Geo: why PostGIS") — don't reintroduce haversine
    math in JS.
  - AI generation must stay location-anchored: reverse-geocode → anchored
    search → source vetting → refuse when nothing vets. Don't remove the
    refusal path.
- Style conventions visible in the code: 2-space TS, zod `safeParse` +
  `{ error, detail }` JSON errors on routes, repo functions take `sql`
  first, bare `console.*` logging, no default exports except the Hono app.

## Commands you will need

| Purpose   | Command                          | Expected on success |
|-----------|----------------------------------|---------------------|
| Typecheck | `bun run typecheck` (repo root)  | exit 0              |
| Tests     | per-workspace `bun test`         | all pass            |

## Scope

**In scope** (create only):
- `CLAUDE.md`
- `.editorconfig`

**Out of scope** (do NOT touch):
- README.md / PRD.md — CLAUDE.md links to them, doesn't replace them.
- ESLint/Prettier/husky — deferred (see Why this matters).
- Any source file.

## Git workflow

- Branch: `advisor/010-claude-md` off `main`.
- One commit: `Add CLAUDE.md and .editorconfig`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: CLAUDE.md

Write `CLAUDE.md` (~60–90 lines) with exactly these sections, populated
from "Current state" (verified, not copied blind):

1. `# GrandTour` — two sentences: what the product is, what the repo holds.
2. `## Commands` — the verified command table (setup, run, verify). Include
   the filo sibling-checkout requirement as a callout at the top.
3. `## Architecture` — the monorepo map (one line per workspace) and the
   Layer/Spot/ContentPiece + filo explanation (≤6 lines), linking to
   README.md and PRD.md for depth.
4. `## Invariants` — the four bullets from Current state, phrased as
   instructions ("Never count UTF-8 bytes by UTF-16 code units…").
5. `## Conventions` — the style bullets from Current state.
6. `## Plans` — one line: `plans/` holds executor-ready implementation
   plans; read `plans/README.md` before starting work there.

**Verify**: every command written in the doc has been run in this session
and succeeded (list them in your report with their exit status).

### Step 2: .editorconfig

```ini
root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
trim_trailing_whitespace = true
indent_style = space
indent_size = 2

[*.swift]
indent_size = 4

[*.md]
trim_trailing_whitespace = false
```

(4-space Swift matches the existing `ios/Sources/*.swift`; 2-space matches
all TS/JSON/YAML in the repo — spot-check before committing.)

**Verify**: `cat .editorconfig` matches; open two files (`server/src/index.ts`,
`ios/Sources/AudioPlayer.swift`) and confirm the indent rules describe them.

## Test plan

Docs-only; the gate is that every command in CLAUDE.md was executed and
worked. Run `bun run typecheck` once at the end to prove the tree is
untouched.

## Done criteria

- [ ] `CLAUDE.md` exists with the six sections, all commands verified
- [ ] `.editorconfig` exists as specified
- [ ] `git diff --stat` shows only the two new files
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Either file already exists.
- A command from "Current state" fails when you verify it — the doc must
  not ship untrue commands; report which one and why.

## Maintenance notes

- CLAUDE.md rots fast: whoever adds a workspace, env var, or verification
  command must update it — reviewers should ask for that in PRs.
- When lint/format tooling is eventually added, record the decision here
  and in CLAUDE.md's Conventions section.
