# 017 — Content curation before the first public release

Status: IN PROGRESS · Priority: P1 · Effort: M · Depends on: 016 (done)

Prepared 2026-09-19 for a separate executor; executed 2026-09-20 in the
maintainer's session against the live authoring database. Every change is
logged in `curation_log` (`change`, `spot_id`, `old`) and is reversible from
it. Plan 015's decisions stand where this plan does not override them.

## Ground rules (still in force)

- **Query the database with `docker exec grandtour-db-1 psql -U postgres -d grandtour`**,
  not `docker compose exec` (compose parses the repo-root `.env` and fails
  on it). Never read, print or commit `.env`.
- **Hold, don't delete.** `tracks.visibility = 'private'` with a
  `hold_reason` withholds a whole track; a spot is withheld by
  `status = 'draft'`. Nothing here deletes content rows.
- **Every mutation in one transaction**, with the row counts it should touch
  stated first and checked. Log it in `curation_log`.
- **Never edit the sheriff's-calls scripts** (CLAUDE.md invariant); that
  track stays held.
- Verify curation by exporting and reading the diff in `content-private`,
  not by eyeballing the database.

## Decisions (maintainer, 2026-09-20)

1. **Nothing new is voiced.** Unvoiced spots stay unpublished; ElevenLabs
   is for new creations when the maintainer chooses (500k credits stand;
   the key works but lacks `user_read`, so usage cannot be read by API).
2. **No mode filtering ships.** Every spot plays in any mode
   (`spots.modes = '{}'` everywhere; the filtering code stays for other
   servers).
3. **No route tracks.** The Marin routes fold into the five topics:
   history (which is history *and geography*), parks-and-trails,
   shops-and-restaurants, real-estate, news. News stays evergreen for now.
4. **The release gate is the maintainer's, not the admin's.** The generic
   admin is for anyone's server; what GrandTour publishes is decided on the
   release console (`/release`, `RELEASE_CONSOLE=true`).
5. **MIT for everything GrandTour authored**; third-party content keeps its
   own terms in `provenance.origin`.
6. **NPS tours ship without transcript highlighting**; the aligner is
   gtfyi/grandtour#12.
7. New York strays and Everglades stay unshipped; the sheriff's calls stay
   held.

## Done 2026-09-20 (content-private commit 9a43ce8)

| Change | Rows | Log key |
|---|---:|---|
| New York strays (Woolworth Building, Brooklyn Bridge, City Hall Park) → draft | 3 | `nyc-stray-drafted` |
| Published spots with no published recording → draft | 213 | `unvoiced-drafted` |
| `spots.modes` cleared | 494 | `modes-cleared` |
| bothin-to-muir-beach-101 + fairfax-point-reyes-archive-drive + bothin-to-seven-eleven → topic tracks | 239 | `folded:<src>><dst>` |
| Walk scripts that narrate the errand itself (An Acreage Is Not a Building Plan, The Old Glass and the New Services, The Workshop Beyond the Garage, Your Errand Is on a Housing Map) → draft, left in the held track | 4 | `walk-itinerary-held` |
| `provenance.origin` = GrandTour / MIT / clearance confirmed on every GrandTour-authored published piece | 769 | — |

The fold, by destination: history 114, parks-and-trails 78, news 32,
real-estate 14, shops-and-restaurants 1. Rule used: subtitle "Local
history" / "Historical writing · 1880" / railroad, town, people → history;
national-park, trail, marsh, creek-habitat, wildlife → parks-and-trails;
physical geography (faults, fog, watersheds, valley shape) → history;
address-keyed houses, ADUs, property maps, a 2023 coastal house review →
real-estate; the Pelican Inn → shops-and-restaurants; anything dated 2025
or later, and the Light-sourced civic items → news. The two emptied route
tracks are held ("Folded into the topic tracks…"); `history` is now named
**History & Geography**.

Known cost of folding as-is: 54 of the folded scripts still say "this
drive", "our Muir Beach destination" or "this walk" (29 from the 101 drive,
13 from the archive drive, 12 from the walk). They play fine; they read
oddly outside the route. Re-scripting means re-voicing, which decision 1
defers. List them with:
`SELECT s.title FROM spots s JOIN content_pieces c ON c.spot_id=s.id WHERE c.document->>'text' ~* '(this drive|our drive|this walk|our destination|the walk''s destination)'`.

After the export the public index carries 12 tracks (5 topics + 6 NPS
tours + Going-to-the-Sun Road), 687 recordings, and `history` is a 28 MB
bundle — see the open item on bundle size below.

## Remaining

### A. Going-to-the-Sun Road: bundle, not rows

The tour still ships from a pre-built bundle passed to the export
(`--extra scripts/data/going-to-the-sun-road.grandtour.json`; the file is
gitignored under `server/scripts/data/` — restore it from
`content-private/tours/` if it is missing, as it was on 2026-09-20). Its 25
spots exist in the database only as drafts spread over history (6),
parks-and-trails (17) and shops-and-restaurants (2). Turning it into rows
(a real track, the 25 spots moved into it and published) makes the admin
able to edit it and the export self-contained, and is gated on the audio
listen-through described in plan 015 (third-party credits in the NPS
files: the Everglades lesson). Steps as in the 2026-09-19 version of this
plan; nothing in the shipped bundle changes except ids.

### B. Publish (maintainer's buttons)

```sh
cd server
bun run content:publish --from ../../content-private --to ../../content --site ../site/static --upload
cd ../../content && git add -A && git commit -m "First publication" && git push
cd ../grandtour && bun run site:deploy
```

`content:publish` now also copies `LICENSE` and `README.public.md` (as
`README.md`) into the public repository. The upload is about 670 MB,
idempotent. The site's landing frame plays `demo_track`
(going-to-the-sun-road-audio-tour), which is in the index.

### C. Open items, not release blockers

- **Bundle size** — done 2026-09-20: bundles drop the `word` tier and are
  written compact (`slimDocuments`), which takes `history` from 28 MB to
  about 2.5 MB. Transcripts fetched per story would be the next step if
  bundles grow past cellular comfort again.
- **Index minutes for NPS tours read 0**: their imported pieces have no
  `duration_ms`. Measure the files at import (or in the export) and stamp it.
- **NPS tracks have no colour or icon**; the apps fall back to teal.
- **Route-framed scripts** (above): re-script and re-voice when voicing
  resumes; one narrator per track is the maintainer's call at that point.
- **Point Reyes Light citations** (74 pieces, now spread across news and
  parks-and-trails) are GrandTour narration reporting with credit; plan 015
  recommends leaving them published. Unchanged.
- **Fill-in tracks** (geography, sat-vocabulary) are held and are not part
  of the static distribution at all.

## STOP

Do not: run `content:publish` or push to `gtfyi/content`, deploy the site,
or change any repository's visibility. Those are the maintainer's buttons.

## Verification queries

Per-track counts and the release gate are what the release console shows.
From SQL:

```sql
SELECT t.slug, t.visibility, t.lifecycle,
       count(s.id) FILTER (WHERE s.status = 'published') AS pub,
       count(s.id) FILTER (WHERE s.status <> 'published') AS other,
       count(DISTINCT s.id) FILTER (WHERE s.status = 'published' AND EXISTS (
         SELECT 1 FROM content_pieces c WHERE c.spot_id = s.id AND c.status = 'published' AND c.audio_url IS NOT NULL)) AS voiced
  FROM tracks t LEFT JOIN spots s ON s.track_id = t.id
 WHERE t.kind = 'tour' GROUP BY t.id ORDER BY t.visibility, t.slug;
```

What was changed today, and how to undo a step:

```sql
SELECT change, count(*), min(at) FROM curation_log GROUP BY change ORDER BY 3;
-- e.g. restore mode lists:
-- UPDATE spots s SET modes = ARRAY(SELECT jsonb_array_elements_text(l.old)) FROM curation_log l WHERE l.spot_id = s.id AND l.change = 'modes-cleared';
```

The index after an export, per track:
`jq '.tracks[] | {slug, visibility, spotCount, voicedCount, areas}' content-private/grandtour.json`.
