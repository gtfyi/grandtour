# Plan 013: Author-selectable content variants (short/medium/long, etc.)

> **Executor instructions**: This is a light plan / design spike, not a
> ready-to-build spec — the variant taxonomy and selection rule are unmade
> product decisions (see plans/README.md's "Findings considered and
> rejected" and "Direction findings" sections). Read this plan fully, but
> expect to firm up the open questions with the maintainer before or during
> implementation rather than improvising an answer.
>
> **Drift check (run first)**: `git diff --stat $(grep -oE '[0-9a-f]{7,}' <(grep "Baseline commit" plans/README.md))..HEAD -- packages/shared/src/content.ts server/src/content/repo.ts admin/src/App.tsx`
> If any in-scope file changed since the baseline, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: LOW
- **Depends on**: plans/001-vcs-baseline.md; conceptually follows on from
  plans/009-nearby-locale.md (same selection machinery, different axis)
- **Category**: feature / design spike
- **Planned at**: 2026-08-29

## Why this matters

`ContentPiece` already supports multiple pieces per spot — the DB unique
key is `(spot_id, locale, variant)` and `variant` is a free-text label
(`packages/shared/src/content.ts`, doc comment: `"Quick drive-by", "Deep
dive"`). Storage-wise, arbitrarily many differently-lengthed or
differently-oriented pieces of content per spot already work today.

But nothing above storage knows what to do with more than one:

- `pickContent` (`server/src/content/repo.ts:303`) ranks candidate pieces
  by locale match, then audio presence, then recency — it never looks at
  `variant`. If a spot has a "short" and a "long" piece, which one `/nearby`
  returns is arbitrary (whichever was updated last).
- The public API (`NearbyQuery`, `packages/shared/src/api.ts`) has no field
  for a client to request a length/style preference, so even a perfect
  selection rule server-side would have nothing to key off from the client.
- Admin (`admin/src/App.tsx:365`) always writes `variant: "default"` — there
  is no UI to author a second variant for the same spot, so in practice no
  spot has ever had more than one published piece.
- This was already flagged and deliberately deferred once: plans/README.md
  "Findings considered and rejected" — *"Mode-aware content-variant
  selection ('drive-by vs deep dive'): deferred — the variant↔mode mapping
  is an unmade product decision."*

This plan is the follow-up: turn that deferred finding into a concrete (but
still open-ended) spec once the product is ready to build it.

## Current state

- `packages/shared/src/content.ts` — `ContentPiece.variant: z.string()
  .default("default")`; free text, no enum, no length/duration semantics.
- `server/db/*.sql` — unique constraint on `(spot_id, locale, variant)`
  (confirm exact migration file when implementing; not re-verified here).
- `server/src/content/repo.ts:303-314` — `pickContent(pieces, locale)`:
  sorts by locale match → has-audio → most-recently-updated. No variant
  awareness.
- `server/src/content/repo.ts:352-378` — `assembleNearby` calls
  `pickContent` once per spot with a single `locale` argument; no variant
  or mode preference is threaded through.
- `packages/shared/src/api.ts` — `NearbyQuery` has `mode` (ActivityMode,
  used for spot filtering) but nothing that maps mode or explicit
  preference to a content variant.
- `admin/src/App.tsx:365` — the only place a `ContentPieceInput` is
  constructed in admin; `variant` is hardcoded `"default"`.
- `server/src/ai/generate.ts` — the AI pipeline takes a `variant: string`
  input already (line 15/24) and keys the storage path off it
  (`narration/${spot.id}/${locale}-${variant}.mp3`), so generation already
  supports producing distinctly-variant audio — it's just never invoked
  with anything but the caller's chosen string today.

## Open product questions (resolve before/while implementing)

1. **Taxonomy**: fixed enum (`short | medium | long`) vs. free-text label
   vs. a structured axis (target duration in seconds) vs. multiple axes
   (length *and* orientation, e.g. "walking vs. driving cut" as a separate
   dimension from length)? The doc comment on `variant` already suggests
   both a length axis ("Quick drive-by", "Deep dive") and the existing
   `ActivityMode` enum handles some orientation already — decide whether
   variant should fold in mode-orientation or stay length-only and let
   `modes` (already on `Spot`, not `ContentPiece`) keep doing that job.
2. **Selection rule**: how does `/nearby` pick among available variants for
   a spot when several are published? Candidates: explicit client
   preference (new `NearbyQuery` field) with a fallback order; a
   server-side default tied to `mode`; a per-traveler stored preference.
   This is the crux of the deferred finding — needs a maintainer decision,
   not an executor guess.
3. **Authoring UX**: does admin get a variant picker/tab per spot (author
   "short" and "long" as separate documents, generate audio for each), or
   does the AI pipeline auto-derive shorter cuts from a long draft (single
   source of truth, mechanically trimmed)? These have very different
   implementation costs (parallel authoring UI vs. a summarization/editing
   step in `server/src/ai/generate.ts`).
4. **iOS**: does the traveler get a setting ("prefer short narrations") or
   is variant chosen silently by the server based on `mode`/speed? Affects
   `ios/Sources/Models.swift` / `GrandTourAPI.swift` and whether a new
   preference needs to persist on-device.

## Sketch of an implementation shape (once questions above are answered)

Not a committed plan — illustrative only, to show the pieces are all
already in the right places:

- Extend `ContentPiece.variant` docs/validation only if the taxonomy
  becomes a fixed enum; otherwise no schema change needed — free text
  already works.
- `pickContent` gains a `preferredVariant` (or `preferredDurationMs`)
  parameter and ranks by variant match ahead of (or interleaved with)
  locale match, same pattern as plan 009's locale ranking.
- `NearbyQuery` gains a field analogous to plan 009's `locale` (e.g.
  `variant` or `maxDurationMs`), threaded through
  `server/src/routes/public.ts` → `assembleNearby` → `pickContent`.
- Admin gets a variant selector when creating/editing a `ContentPiece`
  (replace the hardcoded `"default"` at `admin/src/App.tsx:365`) and a way
  to see/switch between a spot's existing variants.
- `server/src/ai/generate.ts` already accepts `variant` as an input — no
  pipeline change needed to *generate* a second variant, only to the UI/API
  that invokes it with something other than `"default"`.

## Out of scope (for this plan; explicitly not decided here)

- Which taxonomy to ship — that's the design spike's output, not an input.
- iOS UI for variant preference — follow-up once server selection exists.
- Auto-derivation of short cuts from long narration via LLM summarization —
  a reasonable option per question 3, but a separate pipeline design.

## Done criteria for the *spike*

- [ ] Maintainer has answered open questions 1–2 above (taxonomy +
      selection rule), recorded either in this plan or a successor.
- [ ] A follow-up build plan exists (or this plan is amended in place) with
      concrete steps once the shape is settled.

## STOP conditions

- Do not silently pick a taxonomy or selection rule and start building —
  this was deferred once already for exactly that reason (see
  plans/README.md). Surface the open questions and get a decision.
