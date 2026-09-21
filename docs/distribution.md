# Distribution: how content reaches players

GrandTour's public surface is static files. This page is the contract
between the content pipeline, the servers, and the players. The objects
themselves are in [object-model.md](object-model.md); the decisions behind
them are plan 016.

## A server is a base URL

A **GrandTour server** is any base URL that serves an index file and the
bundles it points to. A website, a GitHub repository served raw, a folder on
a laptop, or the authoring server: nothing else is required.

```
<base>/grandtour.json                Index — one entry per track, each with its bundle's URL
<base>/tours/<slug>.grandtour.json   TrackExport — one track, complete; audio by absolute URL
```

The index says where the tours live; the tours say where the data lives.
Track URLs in the index resolve against the index's own URL, so a checkout
and a website serve identical files. Audio URLs are absolute — ours point
into the bucket behind `data.grandtour.fyi`, a park service's point at the
park service — and no client rewrites them.

How a user names a server, and where its index is (`indexUrl` in
`@grandtour/shared`, `Distribution.indexURL` in Swift):

| Spelling | Index |
|---|---|
| `grandtour.fyi` | `https://grandtour.fyi/grandtour.json` |
| `https://example.org/tours/` | `https://example.org/tours/grandtour.json` |
| `github.com/gtfyi/content` | `https://raw.githubusercontent.com/gtfyi/content/main/grandtour.json` |
| `https://github.com/org/repo/tree/dev/marin` | that branch and folder, raw |
| `http://100.80.32.94:8787` | the authoring server's live index |

The authoring server serves the same two shapes live (`GET /grandtour.json`,
`GET /tours/<slug>.grandtour.json`), with its locally stored recordings
addressed at whatever host the request arrived on. It additionally offers
the live API (`/api/*`): nearby polling, fill-in items, manifests, and the
creator write path. The phone tells the two apart by probing `/health` once.

## What a player does

1. Fetch the index. It is small and position-independent.
2. Pick the tracks whose `areas` meet the cells around the player's own
   position: `tracksInAreas(index, areasAround(pos))`. Areas are geohash
   cells at precision 4 (about 39 km by 20 km); both sides compute them,
   so there is no list to sync.
3. Fetch those bundles whole — ahead of a trip, or on entering their area —
   and cache them by the index's `hash`.
4. Evaluate triggers on the device on every fix (`computeNearby` on the
   web, `TriggerEvaluator` on the phone), schedule, play.
5. Play audio from the URL the bundle names; cache it locally.

**What a server can observe, stated precisely:** which files a client
fetched. No coordinate is ever sent. Fetching the index reveals nothing;
fetching a bundle reveals interest in a track; fetching audio reveals which
stories were played. Fetching whole bundles rather than asking for spots
one at a time is what keeps that grain coarse — do not add a per-spot
fetch path.

Against an authoring server the phone keeps its richer behaviour: the
server resolves "on your left" from the course, fill-in tracks fill silent
stretches, journeys prefetch a route corridor, and Walk and Record publishes
takes. Against a static server the tour is bundles plus local evaluation;
recording is declined with a pointer to the server list.

## Where content comes from

```
authoring database ──content:export──▶ gtfyi/content-private   every track; held ones marked visibility: private
                                              │
                                       content:publish            public tracks only
                                              ├──▶ gtfyi/content   the public repository — itself a server
                                              ├──▶ site/dist       grandtour.fyi serves the index (and the app) beside the pages
                                              └──▶ R2 bucket       tours/<slug>.grandtour.json and audio/<sha256>.<ext>, behind data.grandtour.fyi
```

Export is naming; publish is materialisation. `content:export` writes a
bundle for every tour track with the recordings named by their final public
URLs, computed from each file's content hash, without copying any audio.
A bundle is the distribution cut of a track: voiced spots and their recorded
pieces only (`voicedOnly`), documents with just the `audio` and `sentence`
tiers (`slimDocuments` — the word tier is most of a document and nothing on
a player reads it), written compact. The authoring database keeps everything.
`content:publish` copies the public tracks and uploads only the recordings
those bundles name, so a held track's URLs simply do not resolve until it is
released. Both are deterministic: unchanged content produces byte-identical
files, and the content repositories' history shows only real changes.

```sh
cd server
bun run content:export  --out ../../content-private --prune
bun run content:publish --from ../../content-private --to ../../content --upload
cd ../site && bun run deploy         # the site builds from ../../content
```

The release gate is `tracks.visibility` on the authoring server: hold a
track and the next export marks it private, the next publish drops it, and
every server built from the public repository stops listing it.

## Format

Bundles and the index carry `formatVersion` (currently 1). A player accepts
the versions it knows; producers write the current one. Adding fields is
compatible; changing the meaning of one is a new version. The schemas are
the source of truth: `Index`, `IndexTrack`, `TrackExport` in
`packages/shared/src/distribution.ts` and `api.ts`, mirrored by
`ios/Sources/Distribution.swift`, `TrackDownloadBundle.swift` and
`Models.swift`.

## Running your own

- **A folder.** Put `grandtour.json` and `tours/` on any static host, or
  serve the folder locally; the site's dev server (`bun run dev:site`) is one
  such host. Open the app with `?server=<that url>`, or add it under
  Tracks → Server on the phone.
- **A GitHub repository.** Commit the same layout; name the repository as the
  server. The published tracks in `gtfyi/content` work this way.
- **The authoring server.** `bun run dev:server`; it is a server as it
  stands, with the live API on top, which is what creators use.
