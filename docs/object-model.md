# The object model

Every surface — authoring server, admin, web app, iOS, watch, the tours
repository and the data CDN — speaks the same objects. They are zod schemas
in `packages/shared` (the source of truth) mirrored as Swift `Codable`
structs in `ios/Sources/Models.swift`. This page is the map; the schemas
are the territory.

## Content

```
Track ──< Spot ──< ContentPiece
  │
  └──< FillInItem            (only when track.kind = "fillin")
```

**Track** — a named set of spots a listener turns on or off. `kind` is
`tour` (spots with geometry) or `fillin` (items with none). `lifecycle` is
`evergreen` (replayable after a 6 h cooldown, freshness-ranked) or `series`
(each unit heard once; completion auto-disables the track). `official`
ranks curated tracks first. `visibility` is the release gate: `private`
withholds the whole track from every public surface without touching a
single spot's status, and a held row carries `holdReason` and `heldAt`.

**Spot** — a place that speaks. Its **trigger** is the whole story of
*when*: `point` (centre + radius, optional precise polygon: "you have
arrived", plays promptly, with locating audio) or `area` (a polygon fence:
playable anywhere inside, but only scheduled into narration gaps; its
`center` is a map anchor, never trigger math). `sequence {key, index}` makes
parts of one story auto-play strictly in order. `locating` says where to
look (`{{side}}` resolved from the traveler's course, rendered as tiny
left/right clips) and is never part of the narration text. `status` is
editorial readiness (`draft` / `published`).

**ContentPiece** — one narration of a spot: a `locale`, a `variant`, a
**filo document** (immutable text addressed by UTF-8 byte offsets, with an
`audio` tier mapping time ranges to byte ranges — the coordinate system
every transcript highlighter uses), an `audioUrl` (an `AudioRef`, below),
`durationMs`, `source` (`ai` / `human` / `imported` — an ingestion label,
never a rights label) and `provenance`. Provenance carries the works a
script drew on (`sources`), the work imported content *is* (`origin`), and
capture context for recordings. Each is a **SourceRef**, whose `clearance`
list records who verified which rights (`scope` all/text/audio, status
confirmed/probable/unclear/not-cleared). Licence follows `provenance.origin`.

**FillInItem** — content with no geometry (vocabulary, quiz), played when
narration has been silent past a threshold. It reuses `ContentPiece` for
its narration so every player works unchanged.

**Guide** — an optional human guide a spot promotes (a booking lead).

## Distribution

The public surface is static files, and **a GrandTour server is any base
URL that serves an index file matching the schema and the files it points
to**: a website, a GitHub repository served raw, a folder, or the authoring
server. The index says where the tours live; the tours say where the data
lives. The objects and the pure functions that build and read them live in
`packages/shared` (`area.ts`, `distribution.ts`).

```
<base>/grandtour.json                Index — one IndexTrack per track, with the bundle's URL
<base>/tours/<slug>.grandtour.json   TrackExport — audio by absolute public URL
```

**Index** (`grandtour.json`) — `formatVersion`, `generatedAt`, an optional
`name`/`description`/`source`, and one **IndexTrack** per track: identity
(`id`, `slug`, `name`, `createdAt`), display (`description`, `color`,
`icon`, `official`, `lifecycle`), the bundle's `url` (absolute, or relative
to the index's own URL), counts and `minutes`, `center`/`spanKm`, the
`areas` it touches, and the bundle file's `hash`/`bytes`. A *private* index
also carries `visibility`; `publicIndex` drops held tracks and the field.
`indexUrl(server)` turns however a user names a server (`grandtour.fyi`,
`github.com/gtfyi/content`, `http://localhost:8787`) into its index URL.

**Area** — a geohash cell (`areaId(pos)`, precision 4: about 39 km by 20 km).
Server and client both know the function, so there is no list to sync. A
client turns its own position into `areasAround(pos)` (its cell and the
eight neighbours), keeps `tracksInAreas(index, cells)`, and never sends a
coordinate anywhere. Mirrored in Swift as `AreaId`; pinned by
`scripts/area-parity`.

**TrackExport** (a *bundle*, `<slug>.grandtour.json`) — one track,
complete: the `track`, every published spot with its published content,
fill-in items for fill-in tracks, an optional authored `routePath`, a
`formatVersion`, and `exportedAt` = the newest change it carries (so an
unchanged track exports byte-for-byte the same). The same shape is served
live by the authoring server, previewed by the admin, downloaded by the
phone, and held in the content repositories.

**Audio** — a bundle names each recording by an absolute public URL. Ours
are content-addressed in the bucket, `<AUDIO_PUBLIC_BASE_URL>/audio/<sha256>.<ext>`;
third-party recordings keep their own URLs. Nothing rewrites hosts.

**PlayHistory** (client-side only) — what has been heard, keyed by spot id,
with the replay rules (`SpotScheduler` on iOS, `playHistory.ts` on the web).
Spot ids are stable UUIDs across exports, so histories survive re-exports.

## Who reads what

| Surface | Reads | Writes |
|---|---|---|
| Authoring server (Bun + Hono + PostGIS) | its database | the database; exports bundles and the catalog |
| Admin web | `/api/admin/*` | `/api/admin/*` |
| Walk and Record (iOS) | — | `/api/creator/*` on a server you run |
| `gtfyi/content-private` | — | the location of record: every track, held ones marked |
| `gtfyi/content` and grandtour.fyi | published from the private repository | — |
| R2 bucket (`data.grandtour.fyi`) | recordings, uploaded at publish | — |
| Web app, iOS | `grandtour.json`, bundles and audio from any server (a saved choice, `grandtour.fyi` by default; an authoring server also offers its live API) | play history on the device |
| Watch (planned, not complete) | the live API of an authoring server only | play history on the device |

The gate between "in the database" and "shipped" is `tracks.visibility`:
`content:export` writes every track into the private repository with held
ones marked, and `content:publish` carries only public ones to the public
repository, the site and the bucket. Nothing public evaluates a position
server-side.
