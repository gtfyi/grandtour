---
name: author-spots-and-tracks
description: >-
  Author GrandTour tracks and spots collaboratively with the human — interview
  them about what they want to hear along a route, co-build a spot list, write
  the slate JSON, import it, generate narration/locating audio, and publish.
  Use this skill whenever the user wants to create, extend, or edit a track,
  add spots, build a drive/walk/ride tour, import content, or says anything
  like "make a track for X", "add some spots along Y", "narrate my commute",
  or "what should this tour cover" — even if they don't use the words "track"
  or "spot".
---

# Authoring GrandTour spots and tracks

A **Track** is a named set of **Spots**; a Spot is a GPS trigger (center +
radius, optionally a polygon) with narration attached as **ContentPieces**.
When a listener drives or walks into a trigger, the app speaks. Your job is
to decide, *with the human*, what the world should say and where — then wire
it up correctly.

GrandTour is human-guide-first: the best narration comes from what the human
already knows and cares about. You are the scribe and engineer; they are the
guide. Never dump a finished track on them that they didn't shape.

## The workflow at a glance

1. **Interview** the human about the route and what they want to hear.
2. **Co-build a spot list** — propose candidates, let them cut/add/reshape.
3. **Write the slate JSON** and import it as drafts.
4. **Generate** narration and locating audio (with their sign-off — it costs
   API money).
5. **Review and publish** — nothing is audible to listeners until both the
   spot and its content are `published`.

Exact routes, field tables, and CLI flags live in
[references/api.md](references/api.md) — read it before writing a slate or
calling the admin API. This file covers judgment; that one covers syntax.

## Step 1: Interview the human

Don't ask "what spots do you want?" — most people can't answer a blank
question. Ask concrete, low-effort questions and do the generative work
yourself. Cover these, conversationally (AskUserQuestion works well for the
menu-shaped ones; batch related questions rather than drip-feeding):

**The route and mode.** Where does this track live — a specific drive, a
neighborhood walk, a bike loop, a commute? Which direction(s) will they
travel it? Mode matters mechanically: `modes: ["driving"]` spots need bigger
trigger radii (~100–250 m) and spacing that fits speech at speed, while
walking spots can be tight (~30–80 m) and dense. Default radius is 80 m.

**What lenses interest them.** Offer a menu and let them pick and rank:
local history · architecture and infrastructure · nature, geology, ecology ·
food and businesses · oddities, lore, crime, ghosts · news and current
events · literary/film connections · personal and family stories. Also ask
what to *avoid* — "no true crime" is as useful as "more geology".

**Their own knowledge.** Ask directly: "What do you already know about this
route that a visitor wouldn't? Any stories you tell passengers?" Anything
they give you becomes authored narration text in the slate — it beats AI
generation and skips the whole search-and-vet pipeline. Capture their wording;
edit for the ear, not into encyclopedia prose.

**Pacing and feel.** Roughly how many spots? Long essays or quick hits
(`targetSeconds`, default 90)? One narrator or multi-voice with quoted
sources? Should quiet stretches stay quiet, or be backfilled by a fill-in
track (vocab/quiz — see api.md; those have no geometry and a different
pipeline)?

**Shape of the content.** Three structural questions worth asking once the
lenses are clear:
- Is anything a *place* vs a *zone*? A landmark gets a `point` trigger; a
  valley's geology or a neighborhood's history that isn't tied to one
  address gets an `area` fence — it plays opportunistically in narration
  gaps while the listener is inside, with no "you have arrived" moment and
  no locating.
- Are any spots chapters of one story? Give them a shared `sequence` key so
  parts auto-play strictly in order even if the listener wanders — good for
  serialized history along a route.
- Is the track `evergreen` (replayable ambient companion, the default) or a
  `series` (heard-once; the app auto-disables it when every unit has been
  heard)? A story-driven tour is usually a series; a "know your commute"
  layer is evergreen.

If they hand you a route with no opinions ("just make it good"), pick two or
three lenses that fit the terrain, say which you chose and why, and proceed —
but still run Step 2's review round before importing anything.

## Step 2: Co-build the spot list

Give spots **concise, descriptive titles that name the actual subject**,
including town history and other local stories. When a spot is about one
particular person, place, event, or thing, name it directly; avoid fanciful
titles, metaphors, and vague hooks such as "Reading the Street Signs". For
example, use "Frustuck Avenue's Name" for a story about that avenue's name,
or "Fairfax Street Names" if the story covers several streets. The title
should make the topic clear without requiring the subtitle or narration.

Research the route (map it mentally or with search) and draft **more
candidates than you need** — if they want ~10 spots, pitch ~15. Present a
numbered list where each entry is one line:

```
3. Alto Tunnel portal (walking, N end of Camino Alto) — the collapsed 1884
   rail tunnel cyclists have fought 40 years to reopen
```

Then ask them to react: keep / cut / "more like #3" / "you missed the old
dam". Iterate in short rounds — a second pass of 4–5 replacement candidates
aimed at their feedback converges fast. Signals to watch:

- Every spot must be **anchored to a real, locatable place**. If you can't
  state coordinates and what's physically there, it's not a spot yet.
- Order the list along the direction of travel; flag any spot that only
  works in one direction.
- For driving tracks, check spacing: at 40 mph a 90-second narration covers
  a mile. Adjacent triggers that would overlap get merged or trimmed.
- Ask about **sides**: "the reservoir will be on your right heading west" —
  record it as the slate's `side` hint and keep it OUT of narration text
  (the runtime computes sides live; baked-in directions go stale and the
  drafting pipeline deliberately forbids them).

Get an explicit "yes, this is the list" before writing the slate. The list
is the product; the JSON is clerical.

## Step 3: Write the slate and import

### Sheriff's calls: date, town, report only

The user's standing direction is to read sheriff's calls simply as they
are: **date, town, original report**. Do not add an introduction, commentary,
editorializing, jokes, interpretation, or a conclusion. Preserve the report's
wording, including uncertainty and any time recorded in the report. Keep
publication names and source links in provenance, outside the narration.
For multiple calls in one spot, repeat date, town, report for each call.
Store these fields in `reportEntries`; `narration` is exactly the entries
formatted as `Date. Town. Report` and joined by a space. When converting an
existing call, regenerate its recording and publish the matching text and
audio together. Preserve its identity, listening area, and play history.

The primary authoring artifact is a **slate JSON** consumed by
`server/scripts/import-spots.ts` (format in api.md). Key habits:

- Coordinates are `{lat, lng}` objects everywhere in authoring. Pin them
  precisely — eyeball-from-memory coordinates put triggers in the wrong
  block. Verify against a map source.
- `title` is the idempotency key on re-import and the source of the
  server-generated slug — get it right the first time; renames don't re-slug.
- `locating.anchor` is a short side-free noun/prepositional phrase ("the
  white water tower behind the ballfield") that the locator sentence appends
  verbatim. Write one for any `point` spot not obvious from the road; `area`
  spots have no locating at all — don't author anchors for them.
- Human-authored stories go straight into `narration` (string, or segment
  array for multi-voice with quoted speakers). Spots you'll AI-generate for
  can omit it.
- Put real `sources` URLs on anything factual — they ride into provenance,
  which is public.

Import with `--draft` first. Then look at the result in the admin UI
(`bun run dev:admin`, track workspace at `/:trackSlug`) or via
`GET /api/admin/spots?trackId=…` and sanity-check placement before spending
on audio.

## Step 4: Generate audio

- Narration: `POST /api/admin/spots/:id/generate` (optionally with a `brief`
  refining the angle). A **422 `generation_refused`** means no gathered
  source vetted as actually being about that location — that is the pipeline
  protecting you from confident wrong-place narration, not an error to
  retry around. Fix it by improving the brief, the coordinates, or writing
  the narration yourself; never by weakening the pipeline.
- Locating clips: `POST /api/admin/spots/:id/locating/generate` renders the
  tiny left/right (or fixed) clips. Never re-synthesize narration to change
  a direction.
- Multi-voice slates: `bun run scripts/generate-voiceovers.ts <slate.json>`.
- TTS costs real money — confirm with the human before batch generation,
  and generate one spot first so they can hear the voice and tone.

## Step 5: Publish deliberately

Everything imports and generates as `draft`. `/api/nearby` serves only
`published`, and it requires **both** the spot and its content piece to be
published. Publishing is the human's call — ask before flipping status,
ideally after they've listened to at least a sample. `--draft`-less
`import-spots.ts` publishes immediately; use that only for re-imports of an
already-reviewed track.

## Traps that have bitten before

- `PUT /api/admin/spots/:id` is a **full replace**: send the complete
  `SpotInput` or you silently reset `modes`, `subtitle`, `status`, and
  `sequence` (only `locating` survives omission).
- Re-upserting content without `audioUrl` **nulls out existing audio**. Read
  the current piece back and carry `audioUrl`/`durationMs` forward when
  editing text (pattern in `server/scripts/import-spots.ts`).
- Narration text must be side-free and markdown-free — it's spoken.
- Byte offsets in filo documents are UTF-8 bytes; never index them with
  UTF-16 string math. Use `byteToStringIndex` if you touch offsets at all.
- Fill-in items are a separate pipeline on purpose (no vetting, no alignment
  tier). Don't route them through the location pipeline.
