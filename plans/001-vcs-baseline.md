# Plan 001: Establish the version-control baseline (gitignore fixes + initial commit)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: this repo has NO commits yet, so there is no
> SHA to diff against. Instead, verify the "Current state" excerpts below
> match the live files. `git log --oneline` must print
> `fatal: your current branch 'main' does not have any commits yet` — if it
> shows commits instead, this plan is already done or the repo has moved on:
> STOP and report.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: no commit exists (repo unversioned), 2026-07-05

## Why this matters

The repository has git initialized but **zero commits** — every file is
untracked. There is no protection against accidental deletion, no history, no
baseline for code review, and no anchor for the drift checks used by every
other plan in this directory. Additionally, `.gitignore` is missing entries,
so a naive `git add -A` would commit ~5MB of generated narration MP3s and the
user-local Claude settings file. This plan fixes the ignore rules and creates
the initial commit. Every other plan (002–010) depends on it.

## Current state

- `.gitignore` — exists, 11 lines, currently:

```
node_modules
dist
*.log
.env
.env.local
.DS_Store
*.xcuserstate
xcuserdata/
.build/
DerivedData/
dist-web/
```

- `server/uploads/` — contains 4 generated files matching
  `narration_*_en-default.mp3` (~5MB total). These are dev artifacts produced
  by the AI pipeline's local storage fallback; they must NOT be committed.
- `.claude/settings.local.json` — user-local tool settings; must NOT be committed.
- `.env` — contains live API keys. It IS already covered by `.gitignore`
  (line 4). Do not open, print, move, or delete this file.
- `admin/dist/` — build output; already covered by the `dist` ignore rule.
- `git status --short` currently lists everything as `??` (untracked), and
  `git rev-parse HEAD` fails with "Needed a single revision".

## Commands you will need

| Purpose   | Command                                        | Expected on success |
|-----------|------------------------------------------------|---------------------|
| Git state | `git log --oneline`                            | fatal: no commits (before), one commit (after) |
| Ignore check | `git check-ignore -v <path>`                | prints matching rule |
| Typecheck | `bun run typecheck` (repo root)                | exit 0 (pre-existing pass; run to confirm you start green) |

## Scope

**In scope** (the only files you should modify/create):
- `.gitignore` (edit)
- The initial git commit itself

**Out of scope** (do NOT touch):
- `.env` — never open or stage it. If `git status` ever shows `.env` as
  staged, that is a STOP condition.
- Any source file. This plan changes zero lines of code.
- Do NOT create a GitHub remote or push anywhere. Local commit only.

## Git workflow

- Work directly on `main` (there is no history to branch from).
- One commit. Message: `Initial commit: GrandTour monorepo (shared, server, admin, iOS)`.

## Steps

### Step 1: Extend .gitignore

Append these lines to `.gitignore`:

```
server/uploads/
.claude/
```

**Verify**:
`git check-ignore -v server/uploads/narration_53aa51fa-c6e9-42b5-be32-5373e1325e17_en-default.mp3`
→ prints a line citing the `server/uploads/` rule.
`git check-ignore -v .claude/settings.local.json` → prints a line citing `.claude/`.
`git check-ignore -v .env` → prints a line citing `.env`.

### Step 2: Stage everything and inspect before committing

Run `git add -A`, then `git status --short`. Review the staged list. It must
NOT contain: `.env`, anything under `server/uploads/`, anything under
`.claude/`, anything under `node_modules/` or `admin/dist/`. It SHOULD
contain (non-exhaustive): `PRD.md`, `README.md`, `package.json`, `bun.lock`,
`docker-compose.yml`, `.env.example`, `.gitignore`, `plans/`, and the
`packages/`, `server/`, `admin/`, `ios/`, `scripts/` trees.

**Verify**: `git status --short | grep -E '^\S+\s+(\.env$|server/uploads/|\.claude/)'`
→ empty output (exit code 1 from grep is the success signal).

### Step 3: Commit

`git commit -m "Initial commit: GrandTour monorepo (shared, server, admin, iOS)"`

**Verify**: `git log --oneline` → exactly one commit. `git status --short`
→ empty (or only files you were told to leave untracked).

### Step 4: Record the baseline SHA for the other plans

Run `git rev-parse --short HEAD` and write the SHA into
`plans/README.md` under the "Baseline" note (there is a placeholder line
`Baseline commit: _pending plan 001_`). Replace the placeholder with the SHA.

**Verify**: `grep "Baseline commit" plans/README.md` → shows the real SHA.

## Test plan

No code changes, so no new tests. Run `bun run typecheck` from the repo root
once at the end to confirm the tree is exactly as healthy as you found it
(expected: exit 0).

## Done criteria

- [ ] `git log --oneline` shows exactly 1 commit
- [ ] `git check-ignore .env server/uploads/ .claude/` matches all three
- [ ] `git show --stat HEAD | grep -cE '\.env$|uploads/.*\.mp3|settings\.local'` → 0 matches
- [ ] `plans/README.md` contains the baseline SHA and this plan's row is DONE

## STOP conditions

Stop and report back (do not improvise) if:

- `git log` shows the repo already has commits (plan is stale).
- `.env` or any `server/uploads/*.mp3` file appears in the staged list after
  Step 1's ignore rules are in place.
- You find any other file that looks like it contains credentials (e.g. a
  `*.keys`, `*.pem`, or token-looking file) — do not commit it; report it.

## Maintenance notes

- The commit created here is the drift-check anchor for plans 002–010; those
  plans' "Planned at" refers to this baseline.
- If a remote is added later, remember the repo `.env` was flagged (in a
  prior session) as containing keys that were exposed in a chat transcript on
  2026-06-28 and should be rotated regardless.
- `server/uploads/` being ignored means fresh clones start with no local
  audio; regenerate via the admin "AI generate" button.
