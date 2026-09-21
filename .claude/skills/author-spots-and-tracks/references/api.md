# GrandTour authoring reference

Exact routes, schemas, slate formats, and CLI usage. Line references are as
of 2026-09 — trust the source files over this document if they disagree.

## Contents

- [Auth](#auth)
- [Admin routes](#admin-routes)
- [Field schemas](#field-schemas)
- [Slate file format (import-spots)](#slate-file-format)
- [Authoring CLIs](#authoring-clis)
- [AI generation](#ai-generation)
- [Locating: two mechanisms](#locating-two-mechanisms)
- [Publish lifecycle](#publish-lifecycle)
- [Fill-in tracks](#fill-in-tracks)

## Auth

Two distinct paths:

- **HTTP admin API** — `Authorization: Bearer $ADMIN_TOKEN` on everything
  under `/api/admin/*`. No `ADMIN_TOKEN` in the server env → every admin
  route returns 503 `admin_disabled`. The token lives in the gitignored
  repo-root `.env` — never read or print that file; ask the human to run
  authenticated curl themselves, or use the CLI path below.
- **CLI scripts** (`server/scripts/*.ts`) — talk to Postgres directly via
  repo functions; need `DATABASE_URL`, not the token. Run from `server/`:
  `bun run scripts/<name>.ts`.

## Admin routes

All prefixed `/api/admin` (mounted in `server/src/index.ts`; handlers in
`server/src/routes/admin.ts`). Validation is zod `safeParse` → 400
`{error: "invalid_body"|"invalid_query", detail}`.

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/tracks` | — | `{tracks}` |
| POST | `/tracks` | `TrackInput` | 201. **No track update/delete route exists** |
| GET | `/identify?lat=&lng=` | — | reverse-geocode helper |
| GET | `/spots?limit=&trackId=` | — | all statuses; limit default 500 cap 1000 |
| GET | `/spots/:id` | — | `{spot, content: ContentPiece[]}` |
| POST | `/spots` | `SpotInput` | 201; slug generated from title; 400 on `anywhere` trigger or sequence collision |
| PUT | `/spots/:id` | `SpotInput` | **FULL REPLACE** — see below; same 400s as POST |
| DELETE | `/spots/:id` | — | |
| PUT | `/content` | `ContentPieceInput` | upsert on `(spotId, locale, variant)`; **overwrites every column** incl. `audioUrl` |
| POST | `/content/:id/status` | `{status}` | publish/unpublish content |
| POST | `/spots/:id/generate` | `GenerateRequest` | AI narration; 422 on refusal |
| POST | `/spots/:id/locating/generate` | `{locale?, voiceId?}` | renders locating clips; 400 for `area` spots (they have no locating) |
| GET | `/fillin-items?trackId=` | — | `trackId` required |
| POST | `/fillin-items` | `FillInItemInput` | payload must match `moduleType` |
| POST | `/fillin-items/import` | `VocabImportRequest` | bulk vocab |
| PUT | `/fillin-items/:id` | `FillInItemInput` | COALESCE-safe on order/status; rebuilds script only if no audio |
| POST | `/fillin-items/:id/status` | `{status}` | |
| POST | `/fillin-items/:id/generate` | `{voiceId?, pauseSeconds?}` | TTS; pauseSeconds 0.5–3, default 3 |

**PUT /spots/:id is a full replace.** Every column is set unconditionally;
omitted `modes` → `[]`, `subtitle` → `""`, `guideId` → null, `status` →
`"draft"`, and omitted `sequence` → cleared. Only `locating` is
COALESCE-guarded (omitting it preserves stored clips). Always GET the spot
first and send the merged object back.

**PUT /content orphans audio if you drop it.** The upsert writes EXCLUDED
values for all columns, so re-saving text without `audioUrl`/`durationMs`
nulls generated audio. Read the existing piece and carry them forward
(pattern: `server/scripts/import-spots.ts` around lines 135–144).

## Field schemas

Source of truth: `packages/shared/src/content.ts` and `geo.ts`.

**TrackInput** — `slug` (required, `/^[a-z0-9-]+$/`), `name` (required),
`description` (default `""`), `kind` (`"tour"|"fillin"`, default `"tour"`),
`lifecycle` (`"evergreen"|"series"`, default `"evergreen"` — series tracks
are heard-once: units never auto-replay, and the app auto-disables the
track when every unit has been heard, re-enableable with "start over"),
`icon` (SF Symbol name), `color` (`#rrggbb`, 6 hex digits, `#` required),
`official` (default false).

**SpotInput** — `trackId` (uuid, required), `title` (required — drives slug
on create; renames do NOT re-slug), `subtitle` (default `""`), `trigger`
(required), `sequence` (optional `{key, index}` — see below), `modes`
(`ActivityMode[]`, default `[]` = all modes), `guideId`, `locating`,
`status` (default `"draft"`). **There is no `slug` field** — slugs are
server-generated, per-track unique, stable.

**GeoTrigger** — discriminated by `kind` (`"point"|"area"|"anywhere"`,
default `"point"` so all pre-kind `{center, radiusM}` data parses
unchanged). Coordinates are `{lat, lng}` objects everywhere in authoring;
only PostGIS internals use `[lng, lat]`.

- `point` — "you have arrived": requires `center: {lat, lng}`; fires within
  `radiusM` (meters, max 50 000, **default 80**) OR inside the optional
  precise `region` boundary; plays promptly, with locating audio.
- `area` — "relevant anywhere in this fence": requires `region` (polygon
  ring of `{lat,lng}`, min 3 points, server closes the ring, no holes);
  playable anywhere inside it but scheduled only into narration gaps (ahead
  of fill-ins). No arrival moment, **no locating** (don't author anchors
  for these). `center` optional — a representative point for map pins and
  ordering; server fills it with the fence centroid.
- `anywhere` — schema-reserved for no-geometry content but **rejected with
  400 on POST/PUT /spots**. Use a fill-in track or an area fence instead.

**Spot.sequence** — `{key: string /^[a-z0-9-]+$/, index: int ≥ 0}`. Spots
sharing a `key` within a track form an ordered story: a part auto-plays
only after every lower-index part has been heard (works for point spots
along a route and for area chapters). `(track_id, key, index)` is unique —
collisions return 400. Sequence eligibility is computed client-side from
the track manifest, so parts miles apart still gate correctly.

**Locating** — `mode` (`"auto"|"custom"|"none"`, default auto), `anchor`
(≤200 chars), `template` (used only with `mode:"custom"`; may contain
`{{side}}`), `clips` (generated — don't author).

**ContentPieceInput** — `spotId` (uuid, required), `source`
(`"human"|"ai"|"imported"`, required), `locale` (default `"en"`), `variant`
(default `"default"`), `document` (filo doc or null), `audioUrl`,
`durationMs`, `provenance` (`{model?, ttsProvider?, voiceId?, sources:
[{title,url}], prompt?, generatedAt?, warnings}` — **served publicly on
/nearby**, keep it non-sensitive), `status` (default `"draft"`).

## Slate file format

Consumed by `server/scripts/import-spots.ts` — the main bulk-authoring path.

```jsonc
{
  "track": {
    "slug": "fairfax-to-stinson", "name": "Fairfax to Stinson",
    "description": "", "kind": "tour", "lifecycle": "evergreen",
    "icon": "car.fill", "color": "#2f6f4f", "official": false
  },
  "spots": [{
    "slug": "arequipa-camp-bothin",   // handle for generate-voiceovers only; NOT the DB slug
    "title": "Pottery and Fresh Air", // idempotency key on re-import
    "subtitle": "The sanatorium that turned illness into art",
    "trigger": { "center": {"lat": 37.997, "lng": -122.599}, "radiusM": 120 },
    // or an area fence: {"kind": "area", "region": [{"lat":…,"lng":…}, …]}
    "sequence": { "key": "sanatorium-story", "index": 0 },  // optional ordered-story membership
    "modes": ["driving"],
    "side": "left",                   // authoring hint only; runtime computes real side
    "locating": { "mode": "auto", "anchor": "the wooded canyon mouth at the foot of the grade" },
    "narration": "…",                 // string, OR segment array for multi-voice:
    // [{"text":"…","speaker":{"name":"…","kind":"man|woman|publication","year":"1911"}},
    //  {"text":"…","speaker":null}]
    "sources": ["https://…"]          // → provenance.sources (title = hostname)
  }]
}
```

Slate constraints: `locating` accepts only `mode` + `anchor` (no template or
clips); content is written as `source:"imported"`, locale `en`, variant
`default`; spots match by exact `title` within the track on re-import.

## Authoring CLIs

Run from `server/`. All idempotent unless noted.

| Script | Usage | Purpose |
|---|---|---|
| `import-spots.ts` | `bun run scripts/import-spots.ts <slate.json> [--draft]` | Create track + spots + text content. **Publishes unless `--draft`** |
| `generate-voiceovers.ts` | `bun run scripts/generate-voiceovers.ts <slate.json> [--force] [--only slug]` | Multi-voice ElevenLabs TTS; matches slate `slug`; skips spots with audio unless `--force`; resumable |
| `build-geoquiz.ts` | `[--out path]` | Wikidata → quiz JSON (template-generated, no LLM — keep it that way) |
| `import-quizzes.ts` | `[path]` | Quiz JSON → fill-in track (creates track if absent) |
| `import-vocab.ts` | `[path]` | Vocab JSON → fill-in track (track must exist) |
| `prepare-fillins.ts` | `[--draft] [--rebuild]` | Attach text-only docs, set status |
| `enrich-vocab-senses.ts` | `[--dry-run]` | WordNet multi-sense expansion; run `prepare-fillins.ts --rebuild` after |

## AI generation

`POST /api/admin/spots/:id/generate`, body `GenerateRequest` (all optional):
`brief`, `locale` (`"en"`), `variant` (`"default"`), `voiceId`,
`targetSeconds` (default 90, max 900), `useSearch`, `useWikipedia`,
`synthesizeAudio` (all default true).

Pipeline (`server/src/ai/generate.ts`): reverse-geocode → Wikipedia
GeoSearch + Exa anchored search → Claude vets sources for
location-relevance → **refuses (422 `generation_refused`) when sources were
found but none vet** → drafts (side-free, markdown-free, ~150 wpm) → filo
doc with word/sentence tiers → ElevenLabs TTS with char-timestamp alignment
(misaligned output throws before upload) → saved as `source:"ai"`,
`status:"draft"`. Generation never publishes.

The refusal path is an invariant (CLAUDE.md) — respond by fixing inputs
(coordinates, brief) or writing narration by hand, never by bypassing
vetting. Note: zero gathered sources does *not* refuse — the model drafts
from broad knowledge with a provenance warning; treat such output with
extra skepticism and prefer adding sources.

## Locating: two mechanisms

**(a) `spot.locating` clips** — the TTS'd "where to look". Author writes
`mode` (+ `template` if custom, may contain `{{side}}`) and `anchor`.
`POST /spots/:id/locating/generate` renders tiny left/right clips (or one
fixed clip). Runtime picks the side from the listener's course vs the
spot's bearing; unknown course → `locating: null`, never a guessed side.
Never re-synthesize narration for direction changes.

**(b) Locator sentence** (`packages/shared/src/locate.ts` ↔
`ios/Sources/SpotLocator.swift`) — deterministic "Coming up in 500 feet on
your right, at <anchor>." Appends the authored `anchor` verbatim: anchors
starting with a preposition (`at/on/near/by/in/behind/across/opposite`)
join with a comma; others join with an em dash. Keep anchors ≤200 chars,
side-free. The TS and Swift implementations are a pinned parity contract —
changing one requires changing both plus `scripts/locator-parity/`.

## Publish lifecycle

`PublishStatus = draft | review | published | archived` on Spot,
ContentPiece, and FillInItem (tracks have no status). Only `published` is
served; `review`/`archived` behave like `draft` for serving. `/api/nearby`
requires the **spot** to be published AND filters content to published
separately — a published spot with only draft content returns
`content: null`. When multiple published pieces exist, selection is locale
match → has-audio → most recently updated (no variant selection yet).

Verify end-to-end with the public API (no auth):
`GET /api/nearby?lat=…&lng=…&radiusM=2000&tracks=<slug>`.

**Track manifest** — `GET /api/track-manifest?tracks=a,b` (public, no auth;
empty `tracks` = all) → `{tracks: [{trackId, slug, lifecycle,
contentUpdatedAt, units: [{id, sequenceKey, sequenceIndex}]}]}`. Lists only
published, narratable units. Clients use it for sequence eligibility and
series-track completion; authors can use it to confirm what's actually
live after publishing — a spot missing here means it (or its content)
isn't published.

## Fill-in tracks

`kind: "fillin"` tracks hold `FillInItem`s (vocab/quiz) with **no
geometry** — iOS inserts them during narration silence. They never appear
in `/nearby`; items are served (published only, random order) by
`/api/fillin-items?tracks=…`. Deliberately separate from the location
pipeline: no vetting/refusal (the factual guard is `payload.source`), no
audio alignment tier (SSML pauses break provider char timing), English-only
in practice. Scripts are deterministic templates over the payload — no LLM.
Design and settled decisions: `plans/014-fillin-content.md`.

**VocabPayload** — `word`, `pronunciation?`, `senses: [{partOfSpeech?,
definition, exampleSentence?}]` (min 1), `source: {title, url}`.
**QuizPayload** — `category`, `question`, `answers: string[]` (min 1,
spoken in order), `note?`, `source: {title, url}`.
