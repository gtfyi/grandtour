# Plan 014: Fill-in content (non-location-anchored filler modules)

> **Executor instructions**: This plan is fully specified — all open product
> questions (Segments approach, gap-prediction layer, preemption,
> selection order) were resolved with the maintainer on 2026-08-29 and are
> recorded below under "Decisions already made." Build straight through;
> no further design sign-off needed unless you hit a STOP condition.
>
> **Drift check (run first)**: `git diff --stat $(grep -oE '[0-9a-f]{7,}' <(grep "Baseline commit" plans/README.md))..HEAD -- packages/shared/src/content.ts server/db server/src/content/repo.ts server/src/routes/public.ts ios/Sources/TourViewModel.swift`
> If any in-scope file changed since the baseline, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MEDIUM (new content kind touches schema, DB, server, AI
  pipeline, and iOS playback; the iOS insertion logic is the riskiest part
  because it adds new state to the auto-play state machine in
  `ios/Sources/TourViewModel.swift`)
- **Depends on**: plans/001-vcs-baseline.md; reuses generation pipeline
  shape from plans/011/012 (staged, persisted, evalable) for the vocab
  module's content generation
- **Category**: feature
- **Planned at**: 2026-08-29

## Why this matters

The user asked for a new feature: **fill-in content** — narration that has
nothing to do with the traveler's location, inserted to fill dead air
("blank spots") during a tour. First module: **vocabulary practice**, drawn
from sources like SAT vocab flashcard lists — the announcer says a word,
pauses for the listener to guess a definition, then gives the definition,
uses it in a sentence, and spells it.

This is a deliberate **inversion** of the core content model. Everything in
the schema and server today assumes narration is triggered by and about a
place:

- `Spot.trigger: GeoTrigger` is required, not optional (`content.ts:139`).
- `/nearby` and `/route-nearby` are PostGIS queries — `findNearby`,
  `findAlongRoute` (`server/src/geo/queries.ts`) — there is no path to
  "give me content" that isn't a spatial query.
- The AI generation pipeline's core invariant (CLAUDE.md) is **reverse-geocode
  → anchored search → source vetting → refuse when nothing vets**. A vocab
  word's definition is a *fact*, not a *place claim* — it doesn't reverse-geocode
  and shouldn't be forced through location-anchored source vetting.
- iOS playback (`AudioPlayer.swift`, `TourViewModel.swift`) is built around
  one narration item queued per triggered spot, started by GPS trigger
  entry and ended by `AVPlayerItemDidPlayToEndTime` — there's no concept of
  an item that isn't tied to a `spotId`/trigger, and no pause-for-response
  interaction (vocab practice needs to speak, wait, then keep speaking).

Note: `plans/README.md`'s "Direction findings" item **D (Memory-palace
mode)** already anticipated a structurally similar problem — a track whose
spots carry content *unrelated* to the place they're anchored to — and
proposed a track-level `kind` field as the fix. Fill-in content is a
simpler case of the same idea (no place at all, vs. an arbitrary place used
as a peg), so this plan reuses that direction rather than inventing a
second mechanism. If memory-palace mode is ever built, `kind` should
enumerate both: `"tour" | "palace" | "fillin"`.

## Decisions already made (do not re-litigate)

Resolved with the maintainer before this plan was written:

1. **Scoping model: new track kind, not an optional-trigger Spot.** A
   fill-in track is a `Track` with `kind: "fillin"` containing `FillInItem`
   rows — a new entity, *not* a `Spot` with an optional `GeoTrigger`. This
   was chosen specifically to avoid weakening `GeoTrigger` to optional
   everywhere Spot is touched (PostGIS insert, `findNearby`,
   `findAlongRoute`, the admin map) for a feature that structurally needs
   no geometry at all. A fill-in track never appears in `/nearby` or
   `/route-nearby` responses and never touches PostGIS.
2. **Playback trigger: planner-driven, client-side.** The user was
   explicit that this is not a naive "N minutes of silence → play
   something" timer — it's a planner that inserts a fill-in when it
   predicts or observes a gap. Resolved: the planner lives in
   `TourViewModel`, reactively, during normal `/nearby` polling (not a
   server-side `route-nearby` planning step — see decision 4 below for why
   this was chosen over a server-side or hybrid approach).
3. **Pause mechanism: baked into the audio (Segments Option A).** The
   word → *(pause)* → definition → sentence → spelling beat is one
   continuous TTS render with an SSML break in the middle, stored as an
   ordinary `ContentPiece`. **No changes to `AudioPlayer.swift`** — from
   its perspective a fill-in item is narration like any other, just with a
   quiet patch. Rejected the segmented/tap-to-reveal alternative (separate
   prompt/answer audio segments, new client-driven wait/queueing mode) as
   more correct for a true interactive quiz but unnecessary scope for a
   first module; revisit only if a tap-to-reveal interaction is
   specifically wanted later.
4. **Gap prediction: client-side only, not server-side or hybrid.**
   `TourViewModel` tracks time since a tour spot last triggered and
   enqueues a fill-in item when a threshold is crossed — see "iOS-side"
   below for the mechanism. This covers both planned journeys and
   free-roam touring with one code path, at the cost of not being able to
   pre-plan a fill-in for a *known* upcoming gap (e.g. mid-download,
   before the traveler is even in the corridor). That tradeoff was
   accepted explicitly in favor of simplicity — no `route-nearby`/
   `NearbyResponse` schema change, no heterogeneous spot/fill-in list to
   thread through the journey prefetch path.
5. **Preemption: none — single FIFO queue, fill-in finishes first.** A
   fill-in item already playing is not interrupted by a newly-triggered
   real spot; the spot narration simply waits behind it in the same
   `pendingSpotIds`-style queue `playNextPending` already drains
   sequentially. This was chosen over spot-preempts-fill-in specifically
   to avoid adding a priority concept to that queue — acceptable because
   fill-in items are short (~15–20s including the pause), so the worst
   case is a real spot's narration starting up to ~20s late.
6. **Selection: random track, random item, session-dedup only.**
   *(Amended 2026-08-30 by the maintainer: tracks now rotate round-robin —
   the least-recently-played enabled track supplies the next item, so
   multiple fill-in tracks alternate instead of coin-flipping. Item choice
   within the track stays random-unplayed; everything else here stands.)*
   When the
   planner decides to insert a fill-in, it picks uniformly at random among
   the traveler's *enabled* fill-in tracks, then uniformly at random among
   that track's published items not already played this session.
   `FillInItem.order` is retained in the schema (useful for admin
   authoring/review ordering, and left available for a future module that
   wants strict sequencing) but the *planner* ignores it for selection.
   No persisted state needed beyond an in-memory "played this session" set
   — picks fully re-randomize on next app launch.

## New schema: fill-in tracks and items

### `packages/shared/src/content.ts` additions

```ts
export const TrackKind = z.enum(["tour", "fillin"]);
export type TrackKind = z.infer<typeof TrackKind>;

// Track gains:
kind: TrackKind.default("tour"),
```

A `kind: "fillin"` track has no `Spot`s. It has `FillInItem`s instead:

```ts
export const FillInModuleType = z.enum(["vocab"]); // more later: trivia, quotes, etc.
export type FillInModuleType = z.infer<typeof FillInModuleType>;

/** Module-specific structured payload. Discriminated by moduleType. */
export const VocabPayload = z.object({
  word: z.string().min(1),
  pronunciation: z.string().optional(), // e.g. IPA or a phonetic respelling
  partOfSpeech: z.string().optional(),  // "noun", "adjective", ...
  definition: z.string().min(1),
  exampleSentence: z.string().min(1),
  /** Where the word/definition was sourced, for review + attribution — same
   * shape as GenerationProvenance.sources, reused here directly. */
  source: z.object({ title: z.string(), url: z.string().url() }),
});
export type VocabPayload = z.infer<typeof VocabPayload>;

export const FillInItem = z.object({
  id: z.string().uuid(),
  trackId: z.string().uuid(),
  moduleType: FillInModuleType,
  /** Module-specific structured data (VocabPayload today; a discriminated
   * union on moduleType once a second module exists). */
  payload: VocabPayload,
  /** Manual authoring order; ties broken by createdAt. Nullable = unordered
   * (the planner can pick freely, e.g. shuffled vocab practice). */
  order: z.number().int().nonnegative().nullable(),
  /**
   * The item as filo document + audio, SAME shape as ContentPiece — one
   * continuous narration with an SSML pause baked in between the word and
   * its definition (decision 3 above). Reuses ContentPiece wholesale
   * rather than inventing a parallel text/audio type — the filo
   * alignment, locale, source, provenance, and status machinery all apply
   * unchanged, and AudioPlayer needs no changes to play it.
   */
  content: ContentPiece.nullable(),
  status: PublishStatus.default("draft"),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type FillInItem = z.infer<typeof FillInItem>;
```

**Why reuse `ContentPiece` for `content` rather than a new type**: the
filo-document + audio-tier + locale + source + provenance + status shape is
exactly what a vocab item needs, and every consumer that already knows how
to render/play a `ContentPiece` (the transcript highlighter, `AudioPlayer`,
the admin content editor) keeps working unmodified. The only new thing is
*how the script is drafted* — the pause — which is a TTS/prompt concern
(see "Server-side: generation pipeline for vocab" below), not a storage
shape concern.

## Current state (relevant files)

- `packages/shared/src/content.ts` — `Track`, `Spot`, `ContentPiece` as
  described in "Why this matters"; no `kind` field on `Track` today.
- `server/db/001_init.sql`, `003_tracks_rename.sql` — `layers` table
  (renamed to tracks in 003; confirm exact table name when implementing)
  has no `kind` column; `spots.layer_id` is `NOT NULL`.
- `server/src/content/repo.ts` — all read/write helpers assume
  `Spot`-shaped rows; `pickContent(pieces, locale)` ranks `ContentPiece`s
  for a spot. No fill-in equivalent exists.
- `server/src/routes/public.ts` — `/nearby`, `/route-nearby`, `/tracks`.
  `/tracks` (`listTracks`) returns all tracks with no `kind` filter — this
  is the one endpoint a fill-in track would naturally appear through
  (so the client can offer it as a toggle), everything else must exclude
  `kind: "fillin"` tracks explicitly once they exist, since they're not
  geo-queryable.
- `server/src/ai/generate.ts`, `script.ts`, `search.ts` — location-anchored
  pipeline (reverse-geocode → exa/Wikipedia search → vet → draft → TTS).
  Not reusable as-is for vocab; needs a sibling module (see below).
- `ios/Sources/TourViewModel.swift` — `autoPlayIfTriggered` /
  `playNextPending` / `pendingSpotIds` is the queue a fill-in item would
  need to join; `reconcileTriggers` is where "gap" state could be observed
  (spots repeatedly triggering `false` across polls).
- `ios/Sources/AudioPlayer.swift` — `play(content:spotId:locating:intro:)`
  takes a `ContentPiece` and an opaque `spotId` string used only as a
  dictionary-ish identity key (`nowPlayingSpotId`) — a fill-in item's
  `id` can be passed through this same parameter with no signature change
  if Option A (above) is built, since the function doesn't actually
  require the id to resolve to a `Spot`.

## Server-side: generation pipeline for vocab

New sibling to `server/src/ai/generate.ts`, e.g. `server/src/ai/fillin/vocab.ts`:

1. **Source the word list.** Either (a) admin pastes/imports a word list
   (scrape or paste from a flashcard source like the Manhattan Review SAT
   vocab page) into `FillInItem.payload` directly — no AI call needed for
   the word/definition/example itself if sourced from a vetted list — or
   (b) an AI drafting step similar to `script.ts`'s `draftNarration`, given
   a word and an optional definition source, writes the spoken script
   (intro line, pause marker, definition, example sentence, spelling
   callout). **(a) is simpler and lower-risk to ship first**: import is a
   one-time admin action, not a per-item generation call, and avoids
   needing a vetting/refusal analogue for vocabulary facts (which don't
   have the same "is this really about this place" failure mode the
   location pipeline guards against — a wrong dictionary definition is a
   correctness bug to catch in review, not a hallucinated-location bug to
   architecturally refuse).
2. **Script + TTS.** Reuse `draftNarration`'s prompt-construction pattern
   (system prompt enforces structure and a side-free, brief-anchored
   style) adapted to: state the word, pause (SSML break), state
   part-of-speech + definition, use it in a sentence, spell it letter by
   letter. Reuse `synthesize` (`tts.ts`) and `putAudio` (`storage.ts`)
   unchanged — audio storage doesn't care what kind of content it's
   storing.
3. **No location vetting step.** This is the one place this pipeline must
   diverge from `generate.ts`'s CLAUDE.md invariant on purpose — flag this
   explicitly in the module's own doc comment so a future reader doesn't
   assume the refusal path was forgotten. The equivalent guard for vocab
   is source-of-truth in the payload's `source` field (dictionary/vetted
   list URL), checked at admin review time, not generation time.

## New public endpoint: `GET /fillin-items`

iOS needs a way to fetch published fill-in items for its enabled fill-in
tracks, analogous to `/tracks` but item-shaped. New route in
`server/src/routes/public.ts`:

```ts
publicRouter.get("/fillin-items", async (c) => {
  // query: tracks=slug1,slug2 (required — no "all" fallback; the client
  // always knows which fill-in tracks are enabled from /tracks)
  // returns: { items: FillInItem[] }, status: "published" only, same
  // filter discipline as /nearby (CLAUDE.md: public API serves only
  // published content).
});
```

No geo params, no pagination beyond a reasonable cap (suggest 500, mirrors
`route-nearby`'s limit default) — fill-in tracks are expected to be small
enough (a vocab list) to fetch in full and cache client-side, the same way
`TourCache.shared.absorb(tracks:)` already caches the track catalog.

## iOS-side: planner-driven insertion

Per decisions 4–6 above, the gap-fill logic lives entirely in
`TourViewModel` and joins the existing single FIFO queue
(`pendingSpotIds`/`playNextPending`) — no `AudioPlayer` changes, no server
schema change.

### New state on `TourViewModel`

- `enabledFillInTrackSlugs: Set<String>` (or fold into the existing
  `enabledTrackSlugs` if `allTracks` distinguishes `kind` — prefer folding
  in, since the track-toggle UI already lists all tracks and a fill-in
  track toggling on/off should feel like any other track to the user).
- `fillInItemsByTrack: [String: [FillInItem]]` — loaded once alongside
  `loadTracks()` via `api.fillInItems(tracks:)` (the new `/fillin-items`
  endpoint, see server section below) and cached the same way
  `TourCache.shared.absorb(tracks:)` works today.
- `playedFillInIds: Set<String>` — session-only, in-memory, cleared on
  `stopTour()`/app relaunch (decision 6: no persistence). If every item
  in every enabled fill-in track has been played this session, clear the
  set and start over rather than stalling.
- `lastTourNarrationAt: Date?` — timestamp of the last time a *tour spot*
  (not a fill-in item) started playing or the tour started. Updated in
  `playNextPending` at the point a real spot is dequeued and in
  `startTour`.

### Gap detection

In `refresh(at:)`, after `reconcileTriggers()` and before
`autoPlayIfTriggered()`: if `Date().timeIntervalSince(lastTourNarrationAt)`
exceeds a threshold (suggest **5 minutes** — long enough that this is
clearly a real gap, e.g. a highway stretch or sparse-track area, not
normal spacing between spots on a walking tour) **and** no tour spot is
currently `triggered` in `nearby` **and** the queue
(`pendingSpotIds`) is empty **and** at least one enabled fill-in track has
an unplayed item, pick one (decision 6: random track among enabled, then
random unplayed item from it) and push it onto the *same* queue the way
`autoPlayIfTriggered` pushes a spot id — `playNextPending` doesn't need to
know the difference between a spot id and a fill-in item id as long as the
lookup at dequeue time (see below) resolves either kind.

Reset `lastTourNarrationAt` to now whenever this fires, so a second
fill-in isn't queued back-to-back before the first has even played —
`playNextPending` draining the queue and the real narration starting is
what should re-arm the timer, not the mere act of queuing.

### Dequeue-time resolution (`playNextPending`)

`pendingSpotIds` (rename to something id-kind-agnostic if the diff stays
small, e.g. keep the name but document that it may hold a `FillInItem.id`)
needs its lookup step (`nearby.first(where: { $0.spot.id == id })`) to
first check `playedFillInIds`/`fillInItemsByTrack` for a match before
falling through to `nearby`. On a match: play its `content` via the exact
same `player.play(content:spotId:locating:intro:)` call already used for
spots, passing `locating: nil` and `intro: nil` (a fill-in item has no
locating instruction and no "back 500 feet" intro — it isn't about a
place). Mark it in `playedFillInIds`. On miss (item unpublished/removed
mid-session): drop silently, same pattern as `queue_dropped` for a
vanished spot.

Per decision 5 (no preemption), this dequeue logic requires **no priority
change** — a fill-in item already in the queue or already playing is
never displaced; a newly-triggered real spot's id is simply appended
after it, exactly like two real spots entering trigger range close
together today.

### NowPlaying UI

`AudioPlayer.nowPlayingSpotId` becomes ambiguous (spot id vs. fill-in item
id) from the UI's perspective. `ContentView.swift`'s now-playing card
currently resolves title/subtitle by looking up `nowPlayingSpotId` in
`nearby` (spot-shaped). Add a parallel lookup: if not found in `nearby`,
check `fillInItemsByTrack` and render a distinct header (e.g. "Vocabulary
practice" + the word, no map pin, no distance) instead of falling back to
a blank/broken card. This is the one required UI change — everything else
(the transcript highlighter, play/pause, the audio route handling) works
unmodified because it operates on `ContentPiece`, not on spot-specific
fields.

## Out of scope (for this plan)

- Additional fill-in module types (trivia, quotes, etc.) — `moduleType`
  is designed to extend, but only `vocab` ships here.
- Tap-to-reveal / adaptive-pause interaction (the segmented alternative
  rejected in decision 3).
- A recall/spaced-repetition scheme for vocab (which words repeat, which
  are marked "known") — this plan is playback + authoring only;
  `playedFillInIds` is a per-session dedup, not a durable learning record.
- Server-side gap pre-planning for known journey corridors (the
  server/hybrid alternatives rejected in decision 4) — revisit only if the
  client-side 5-minute threshold proves too reactive in practice (e.g.
  traveler starts a long known-empty corridor and gets no fill-in until
  5 minutes in).

## Done criteria

- [ ] `Track.kind` added (`"tour" | "fillin"`, default `"tour"`);
      `FillInItem`/`VocabPayload`/`FillInModuleType` added to
      `packages/shared/src/content.ts`.
- [ ] DB migration: `tracks.kind` column (default `'tour'`); new
      `fillin_items` table (`track_id`, `module_type`, `payload JSONB`,
      `order`, `content_piece_id` FK or embedded — match the
      `content_pieces` FK pattern used by `spots`/`content_pieces` today,
      `NOT NULL REFERENCES ... ON DELETE CASCADE`).
- [ ] `listTracks`/`/api/tracks` unaffected in shape (still returns
      `Track[]`, now some with `kind: "fillin"`); `/nearby`,
      `/route-nearby`, `findNearby`, `findAlongRoute` explicitly exclude
      `kind: "fillin"` tracks (they're not geo-queryable — confirm this
      exclusion with a test, since a `fillin` track has no `spots` rows
      to join against so an *unfiltered* query likely already returns
      nothing for it, but exclude explicitly rather than relying on that).
- [ ] New `GET /fillin-items` public route, published-only, as specified
      above.
- [ ] Admin CRUD for `FillInItem` (create/edit/import vocab list, generate
      audio) — new panel, same auth middleware as existing admin routes.
- [ ] `server/src/ai/fillin/vocab.ts` — script draft + TTS, no location
      vetting, doc comment explaining the deliberate divergence from
      `generate.ts`'s refusal-path invariant.
- [ ] iOS: `TourViewModel` gap-fill state and logic (fill-in track
      loading, `lastTourNarrationAt` tracking, threshold check in
      `refresh(at:)`, dequeue-time resolution in `playNextPending`) as
      specified above.
- [ ] iOS: `ContentView.swift` now-playing card renders a distinct header
      for a playing fill-in item.
- [ ] Tests: `packages/shared` schema round-trip; `server` route test
      confirming `kind: "fillin"` tracks never appear in `/nearby` or
      `/route-nearby` output, and that `/fillin-items` returns only
      published items.
- [ ] Manual iOS verification (per CLAUDE.md's UI-change convention): run
      the drive simulator with a 5+ minute stretch with no tour spots
      enabled/in-range and confirm a fill-in item plays, the NowPlaying
      card shows the vocab header, and a subsequently-triggered real spot
      queues behind it rather than interrupting.

## STOP conditions

- Do not route vocab generation through `server/src/ai/generate.ts`'s
  location-vetting path or relax that path to accommodate it — CLAUDE.md's
  "never remove the refusal path" invariant is about *that* pipeline;
  fill-in content needs its own pipeline, not a weakened shared one.
- Do not add a priority/preemption concept to `pendingSpotIds`/
  `playNextPending` — decision 5 deliberately keeps this a single FIFO
  queue. If real-world testing suggests preemption is actually needed,
  that's a product decision to bring back to the maintainer, not an
  implementation detail to improvise.
- Do not persist `playedFillInIds` (or any per-item "seen" state) to disk
  or the server — decision 6 is explicitly session-only, no
  spaced-repetition tracking, to keep this plan's scope to playback +
  authoring.
