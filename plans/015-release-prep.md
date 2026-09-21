# 015 — Release prep: grandtour.fyi, open-sourcing, inventory curation

Status: TODO · Priority: P1 · Effort: L · Depends on: —

Prepared 2026-09-18. **Nothing in this plan ships.** It stops at the point
where a human pushes the button: no `wrangler deploy`, no DNS change, no
repo visibility flip, no `status` change on any spot or content piece.
Each section ends with an explicit STOP.

Release targets, as scoped by the maintainer:

1. **grandtour.fyi** live, fully usable on mobile browser and desktop
2. **gtfyi/grandtour** open-sourced with the app and all code
3. the **spots / tracks inventory** released, after curation

## Decisions (maintainer, 2026-09-18)

| # | Decision |
|---|----------|
| B7 | **No public API server.** The demo site is the only public surface. The full server code — creator API included — ships in the repo for people to run themselves. The creator routes stay as they are; they are a self-host feature, not a hosted one. |
| B8 | **Content we create is MIT / public domain.** Third-party content keeps its own terms (see B6). |
| C1 | **Silent pieces do not ship.** The 214 live-but-silent pieces stay local. |
| C2 | **All national park content ships.** Other non-Marin content (NYC, North Dakota) stays local. |
| C3 | **Fill-in tracks do not ship** — `geography` (644 items) and `sat-vocabulary` (10,001 items) are held back. |
| B4 | Commit granularity is the executor's call. |
| A5 | **Demo front piece is a national park tour** — Going-to-the-Sun Road (see below). |
| A3 | **EN only** at launch. Drop the FR locale rather than ship it 75% silent. |
| B5 | **No GPS traces ship** — exclude the `docs/` walk verifications, drive audits, and route GeoJSON. |
| B5a | **`bothin-to-seven-eleven` ships, redistributed into the new categories** rather than as a standalone route. |
| B8a | **The Point Reyes Light track does not ship in the initial version.** Held, not deleted — see C6. |

### What ships, under those rules

**Correction to an earlier count.** The first pass used a Marin bounding box
that cut at -122.3 and so wrongly labelled four *human-recorded Berkeley*
spots as strays. Classified properly, the corpus is:

| Region | Spots | Voiced | Source | Ships? |
|--------|------:|-------:|--------|--------|
| Marin | 831 | 618 | ai, human, imported | yes |
| Berkeley / East Bay | 4 | 4 | human | yes — was miscounted before |
| Glacier NP (Going-to-the-Sun Road) | 25 | 25 | imported (NPS PD) | yes — see below |
| NYC | 3 | 2 | ai, human | no — not Marin, not a park |
| North Dakota | 1 | 2 | ai | no — "Gramma and Grampa's house", personal |

Published + voiced + public today: **554 pieces, 581 min (9.7 h)**.
With the Glacier tour published: **579 pieces, 630 min (10.5 h)**.

(Was 622/647 before `point-reyes-light-sheriff-calls` was held — see C6. Its
68 pieces are preserved, just not served.)

**The Glacier spots are all `draft`.** All 25 — spot *and* content status —
have never been published; they are the 17 drafts in `parks-and-trails`, 6 in
`history`, 2 in `shops-and-restaurants`. Shipping them is therefore a
publish, not just an un-exclusion, and this plan does not perform status
changes. Flagged for execution.

They also need pulling out of the three Marin topic tracks into their own
track — they are a single coherent road tour, not park entries scattered
across Marin categories.

### The national park front piece

**Going-to-the-Sun Road Audio Tour** (Glacier NP, MT) — 25 spots, **all 25
voiced**, already exported to `going-to-the-sun-road.grandtour.json` and
already vendored into the site.

It is the right choice on every axis. `research/open-audio-tours/README.md`
confirms it **public domain (NPS)** after a ~230-unit sweep — and that README
is emphatic that PD *cannot* be assumed from a `.gov` domain, so this is a
verified clearance, not a guess. It is a road tour, which is what the product
is for. And unlike Fairfax Town (41 of 117 voiced, first spot silent), every
stop plays real ranger narration instead of `speechSynthesis`. Switching the
demo to it resolves A5 outright.

Note the boundary: this tour is *not* ours, so B8's MIT/PD grant does not
cover it. It is already public domain and needs an NPS attribution line, not
a license from us.

**Its audio is not fully cleared yet, and that gates the launch.** The
research README clears the tour as public domain, but a sibling NPS tour
(Everglades by Car) was found to blend a named third party's field recordings
into files whose narration was plainly federal — with that credit in an
adjacent line, outside the credit field the Glacier builder checks. Absence of
a third-party credit is therefore not evidence of absence.

`build-going-to-the-sun-road.ts` now records this honestly: `clearance` marks
the **text `confirmed`** (17 U.S.C. §105, credit line verified on all 25
stops) and the **audio `probable`** pending a listen-through of the 25 files
and a re-read of their media records. Someone has to do that before this tour
fronts a public site. It is a short job — 49 minutes of audio — but it is not
optional, and it is the same pass the park-tours session is running over its
own batch.

## Where things actually run today

| Surface | Location | Port | State |
|---------|----------|------|-------|
| Landing site | `~/projects/grandtour.fyi` (separate repo, **no git remote**) | 5181 | detached `screen` session `grandtour-fyi`, up 10 days |
| Tour viewer | `packages/tour-viewer` | 5190 | running; vendored into the site's `public/tour/` |
| **The app** | `packages/tour-viewer` in app mode — `http://localhost:5190/?mode=app`, or `/app/` on the built site | 5190 / 5181 | built 2026-09-18; see A7 |
| API server | `server` | 8787 | running — leave it up, the phone uses it over the tailnet |
| Admin | `admin` | 5180 | not running |

The site deploys to a Cloudflare Worker (`grandtour-fyi`) with custom domains
`grandtour.fyi` and `www.grandtour.fyi`. The domain is registered and on
Cloudflare nameservers (`keaton`/`kristina.ns.cloudflare.com`) but has **no A
record** — `wrangler deploy` has never run. Nothing is public yet.

---

## A. grandtour.fyi — launch readiness

### A1 (P1) Bare `/tour/` shows a developer error screen

`http://localhost:5181/tour/` — no query string — renders the viewer's track
chooser, which calls `/api/tracks`, gets a 404 from the static host, and
displays:

> Could not load tracks (HTTP 404). Check that the API is running. A remote
> server must allow this viewer's origin in ALLOWED_ORIGINS.

The landing page's iframe is fine because it passes
`?bundle=/tour/fairfax-town.grandtour.json&embed=1`. But `/tour/` is a real
public URL on the deployed site — anyone who trims the query string, or
follows a shared link, lands on an `ALLOWED_ORIGINS` error.

**Fix:** when no `bundle` param is present and the viewer is served from the
static site, default to the demo bundle instead of the server-tracks tab. The
"Exported bundle" tab already has an *Open the Fairfax demo* link; make that
the no-param default.

### A2 (P1) Demo audio cannot be verified before launch

Vendored bundles carry absolute `https://grandtour.fyi/tour/audio/<file>.mp3`
URLs, so on localhost every clip resolves to a domain that does not exist.
The demo is unverifiable until after it is live.

Root-relative URLs are **not** an option — confirmed by trying it. The shared
schema validates `audioUrl` with `z.string().url()`, and the viewer rejects
the whole bundle:

> Bundle doesn't match the expected shape: [{ "validation": "url", "code":
> "invalid_string", "message": "Invalid url", "path": ["spots", 76,
> "content", 0, "audioUrl"] } …]

That change was made and reverted; `scripts/vendor-tour-viewer.ts` is back to
its committed form.

**Fix (no code change needed):** the script already honors `SITE_BASE_URL`.
Verify locally with

```bash
cd ~/projects/grandtour.fyi && SITE_BASE_URL=http://localhost:5181 bun run vendor:tour && bun run build
```

confirm a recorded clip plays on mobile and desktop widths, then re-vendor
with the default base before deploying. Consider making that round-trip a
step in a release script so the localhost base can never ship.

### A3 (P2) French demo audio is missing

`bun run build` warns on every build:

```
[audio] fr/harbor: no clip; run bun run audio
[audio] fr/market: no clip; run bun run audio
[audio] fr/lighthouse: no clip; run bun run audio
```

Three of the four FR demo spots are silent. Either run `bun run audio` for
`fr`, or ship EN-only at launch and add FR when the clips exist. Shipping a
language picker whose second language is 75% silent is worse than shipping
one language.

### A4 (P2) Vendored tour data is stale and points at a deleted track

`public/tour/*.grandtour.json` were exported 2026-09-06 and vendored
2026-09-08. They describe track `fairfax-town`, which **no longer exists** —
the live DB has no such slug after today's reorg
(`.reorg-backup/pre-reorg-20260918-074200.sql`, 2026-09-18 07:42). Re-export
and re-vendor from current data before launch, then re-verify A2.

### A5 (P3) The demo is robot speech, not the product's voice

The viewer narrates with `speechSynthesis` (plus a silent-WAV element to
unlock audio on iOS Safari). In the Fairfax bundle only **41 of 117** spots
carry a recording; the other 76 have `audioUrl: null` and fall back to the
device voice. The first spot a visitor hears — "Reading the Street Signs" —
is one of the silent ones.

The demo sells the product. Curate the bundle down to spots that have real
recordings, or order it so a recorded spot plays first.

### A6 Rebuild before deploying

The running dev server was serving a `dist/` built 2026-09-08; edits to
`public/` were invisible until `bun run build`. Any deploy must build first —
`bun run deploy` already does (`build && wrangler deploy`), but the stale-dist
trap is easy to hit while reviewing locally.

### A7 The phone-browser app — built 2026-09-18

The maintainer's ask: a version of the app, as close to the iOS app as
possible, usable in a phone browser, carrying every production track, distinct
from the landing-page demo, linked from the home page. It exists now.

- **Where:** `/app/` on the site (nav link "Open the app", plus a call to
  action under the hero title). In development,
  `http://localhost:5190/?mode=app`.
- **What it does:** several tracks at once with the phone's Tracks sheet
  (full screen; "N of M tracks on", All on / All off, a switch and Only this
  track per row, per-track Start over and "N of M heard", Done), real GPS,
  stories that start as you enter their triggers, a pin tap that plays the
  story in the card below the map, a live transcript, replay/skip,
  lock-screen controls, and a play history that survives reloads with the
  phone's own replay rules. First run turns on only the tracks near you.
- **What it carries:** the 14 public tour tracks, voiced spots only — the 7
  Marin tracks plus 7 national-park tours (Glacier from its pre-built bundle,
  and the six the park-tours session landed today: MLK Birth Home, Saratoga,
  Grand Canyon, Mount Rainier, Voyageurs, Puʻukoholā Heiau). Holding a track
  removes it from the next export; nothing else decides membership.
- **How it ships:** static. `catalog.json` + one bundle per track, 25 MB raw /
  **3.2 MB compressed** for all 14 (2.4 MB for the Marin seven). First run
  turns on only the tracks near the first fix, so a Marin phone never pulls
  Hawaii. Audio is 571 clips as Workers static assets — free, unlimited
  requests (B2) — with the one file over 25 MiB re-encoded by the vendor step.
- **Verified locally:** typecheck 4/4, viewer tests 56/56, server 133/133;
  loads and runs at both :5190 (dev) and :5181 (the built site, assets shared
  with the demo); the deploy guard refuses the localhost vendor base.

**The one honest gap vs. iOS:** background. A page gets no location updates
once the screen locks, so the app holds a screen wake lock while a tour runs
and says so in Settings. Audio keeps playing with the screen off; new stories
will not start until the screen is back.

**Testing on a phone.** Two scripts in grandtour.fyi do it:
`bun run vendor:phone` picks a base the phone can reach and vendors + builds
for it; `bun run serve:phone` (or the `site-phone` preview in the grandtour
repo) serves `dist/` on :8443 with real 206 Range responses — iOS Safari will
not play `<audio>` from a server that answers a Range request with 200, which
the :5181 dev server does.

- **Without a certificate** (today): `http://100.80.32.94:8443/app/?at=37.9871,-122.5889`
  — the whole app with real audio at a simulated position. No GPS: iOS grants
  geolocation only in a secure context.
- **With one**: from a Terminal (the Tailscale CLI refuses to work from a
  non-GUI session — `CLIError 3` — so this is the maintainer's one manual step):

  ```bash
  /Applications/Tailscale.app/Contents/MacOS/Tailscale cert --cert-file ~/.local/share/grandtour/tls/gnat.tail0c11e1.ts.net.crt --key-file ~/.local/share/grandtour/tls/gnat.tail0c11e1.ts.net.key gnat.tail0c11e1.ts.net
  ```

  then `bun run vendor:phone` again (it sees the cert and switches to
  `https://gnat.tail0c11e1.ts.net:8443`), restart `serve:phone`, and open
  `https://gnat.tail0c11e1.ts.net:8443/app/` on the phone with the Tailscale
  app connected. Allow location, Start tour, walk.

The deploy guard refuses localhost, `.ts.net`, and bare-IP bases alike, so
neither phone build can ship.

### Verified working

- Landing page renders correctly at 375×812 and at desktop width
- The embedded viewer loads, renders the MapLibre map with 117 spots, and
  runs a simulated drive with a live highlighted transcript
- Map tiles come from a bundled blob — no tile-server dependency at runtime
- Audio files serve as `audio/mpeg` (the local dev server answers a `Range`
  request with a full `200`, not `206`; Cloudflare's asset host does support
  ranges, so verify seeking after the first deploy)

**STOP.** Do not run `wrangler deploy` or touch DNS.

---

## B. Open-sourcing gtfyi/grandtour

### B1 (P1) 1.8 GB of third-party audio was one `git add -A` away — FIXED

`research/` (1.8 GB of PD/CC place audio, including 89 MB and 64 MB MP3s) and
`.reorg-backup/` (a 33 MB SQL dump of the live database) were untracked **and
not ignored**. `git add -A` would have committed both.

Both are now in `.gitignore`. The untracked set went from **944 files /
1.8 GB** to **253 files / 19 MB**, which is a reasonable commit.

This is the only change this plan made to the grandtour repo.

### B2 (P1) Audio storage — R2, behind a cached custom domain

**626 of 651** `content_pieces.audio_url` values are
`http://localhost:8787/uploads/…`, meaningless anywhere but this machine. One
`spots.locating` row has the same problem. The remaining 25 are external
`https://` (NPS). `server/src/ai/storage.ts` already supports S3/R2 via
`STORAGE_*` and `STORAGE_PUBLIC_BASE_URL`; the localhost form is the
documented dev fallback, written into the DB at generation time.

**Cost is not a reason to hesitate.** R2 charges **$0 for egress, unlimited** —
the bandwidth bill that makes object storage scary elsewhere does not exist
here. Current corpus: 0.64 GB across 667 files, ~1 MB average.

| | Price | Our usage | Cost |
|---|---|---|---|
| Storage | $0.015/GB-mo, 10 GB free | 0.64 GB | $0 — 15× headroom |
| Egress | **$0, unlimited** | any | $0 |
| Class B (reads) | $0.36/M, 10M free | see below | $0 until large |
| Class A (writes) | $4.50/M, 1M free | 667 uploads | $0 |

A play is not always one request — iOS AVPlayer issues ranged requests for
seeking, so budget ~3 Class B ops per clip. The 10M free reads then cover
~3.3M plays/month, roughly **66,000 listener-sessions** at 50 spots each.
Beyond that it stays cheap: 100M ops/month = 90M billable = **~$32/month**,
for traffic that would cost roughly $9,000 in S3 egress.

**The risk is request volume, not bandwidth.** A public bucket can be
hotlinked and hammered. Serve R2 through a **custom domain on Cloudflare** so
the CDN caches objects at the edge: cache hits never reach R2, cost nothing,
and absorb the range-request multiplication. Set this up with the bucket, not
after.

**Keep the site's demo audio where it is.** `public/tour/audio/` (39 MB, 41
files) ships as Workers static assets, where requests are *free and
unlimited* — the marketing demo has zero marginal cost however viral launch
goes. The full corpus cannot move there: 667 files is under the 20,000-file
cap, but `bothin-continuous-42fa1b75.mp3` (44.8 MB) exceeds the 25 MiB
per-file limit, and static assets couple content releases to site deploys and
cannot absorb Walk-and-Record uploads.

Remaining sub-decision: **how** stored URLs get fixed —

- bulk-rewrite `audio_url` to the R2 public base after upload (simple, but
  bakes in a hostname again), or
- store keys and resolve at read time (cleaner; needs the schema change noted
  in A2, since `z.string().url()` currently forbids relative)

### B3 Secrets — clean

- No secret-shaped literals anywhere in the working tree (scanned for
  `sk-ant-`, `sk_`, `AKIA`, `xoxb-`, `ghp_`, PEM private keys)
- `.env` is untracked and gitignored; `server/uploads/`, `diag/`, and
  per-developer signing are already ignored

### B4 (P2) Land the working tree first

`main` carries **166 modified + 253 untracked** files — Walk and Record, the
watch app, CarPlay, activity modes, the tour viewer, and the whole
`server/scripts/data` corpus. `main` is also **behind 1**: Dependabot's
TypeScript 5.9.3 → 7.0.2 bump, [#8](https://github.com/gtfyi/grandtour/pull/8).

Flipping a repo public with a working tree this large is how private data
leaks. Land it as reviewable commits, merge or close #8, then cut `v0.2.0`
from the `Unreleased` section of `CHANGELOG.md` (last tag `v0.1.0`,
2026-09-02).

### B5 (P2) Privacy review — needs a human decision

The corpus is built around where the maintainer actually lives and walks:

- `bothin-to-seven-eleven` — 36 spots across **0.8 km**, a residential walk
- `bothin-to-muir-beach-101` — 100 spots, 16 km
- `docs/` holds GPS traces, walk verifications, and drive audits
  (`bothin-walk-verification.json`, `point-reyes-drive-status.json`, the
  `sheriff-*` audits)

None of this is dangerous on its own; together, in a public repo, it is a
detailed record of one person's movements around their home. Decide
explicitly what ships.

### B6 (P2) License provenance for the research corpus

`research/open-audio-tours` is now gitignored, so it will not be published —
but anything **derived** from it that is in the DB still needs provenance.
The NPS ≠ public-domain lesson applies: federal-agency audio is not
automatically PD. Audit the 25 external-`https` pieces and any imported
content before release.

### B7 (P1) The creator API cannot face the internet as-is

`server/src/routes/creator.ts` carries its own warning:

> UNAUTHENTICATED by design *for now*: the server is assumed private (a dev
> box on a tailnet, same trust level as /api/diag). Anything public needs
> real creator accounts first — don't mount this on an internet-facing
> deployment as-is.

It is mounted today. Anyone who can reach the server can create tracks,
create published spots, and upload audio. That is correct for a tailnet box
and unacceptable on a public host.

Open-sourcing the code does not by itself expose this — but it publishes the
map to it, and the launch raises the obvious question of where the iOS app
points once people install it. Decide before any public server exists:

- no public API at launch (web demo is static bundles; the app stays
  tailnet-only), or
- public API with `/api/creator/*` unmounted, or
- public API with real creator accounts (a project, not a release step)

`/api/diag` is already handled correctly — gated behind `DIAG_ENABLED`, off
by default, 404 otherwise.

### B8 (P1) Content licence — and the trap in applying it

The code is MIT (`package.json`). The maintainer's decision is that **content
we create is MIT / public domain**, and third-party content keeps its own
terms. Stating that is easy. Applying it correctly is not.

**`content_pieces.source` is an ingestion-path label, not a rights label.**
Anyone executing this pass will reach for it, and it is wrong in both
directions:

- `bothin-to-seven-eleven` has 36 pieces marked **`imported`** that are the
  maintainer's own writing, loaded from a slate file. Withholding the grant
  from them would be wrong.
- `point-reyes-light-sheriff-calls` has 18 pieces marked **`human`** — his
  own recordings — whose *spoken text* is the Point Reyes Light's police
  blotter, reproduced as a plain reading per the sheriff-calls invariant.
  MIT-stamping them would be wrong.

So the rule is: **licence follows `provenance.origin`, never
`content_pieces.source`.** This is what `origin` was added for.

**Two bodies of content are not ours to license:**

| Content | Pieces | Whose | Note |
|---|---:|---|---|
| `point-reyes-light-sheriff-calls` | 68 | Point Reyes Light | The spoken text *is* their blotter; `sources` cites ptreyeslight.com per item |
| Going-to-the-Sun Road (Glacier) | 25 | National Park Service | PD, but see the audio clearance gate above |

The sheriff calls need a posture decided before release, not after: 68 items
reproducing a newspaper's published text, as a product, is a different
question from quoting one. Blotter entries are largely factual and short, and
facts do not carry copyright — but the expression can, and this plan is not
the place to settle it. Ask someone qualified, or drop the track.

Two things sharpen that decision, both from the sheriff-calls invariant in
CLAUDE.md, so neither is an oversight:

1. **The verbatim reproduction is deliberate product design** — "plain
   readings: date, town, original report," no introduction, no editorializing.
   It is a standing instruction, not something that drifted.
2. **Attribution is deliberately kept out of the audio** — "Keep source
   attribution in provenance, out of the spoken text." So a listener hears the
   Light's blotter with no spoken credit, by design. If any attribution
   obligation exists, there is currently nowhere in the listening experience
   it is satisfied; it lives only in metadata the listener never sees.

That second point also carries a cost if the answer is "add a credit": the
same invariant says editing these scripts requires replacing their recordings,
so a spoken credit means **re-recording all 68**. Worth knowing before
choosing that option over the alternatives.

**Blocker:** no content piece carries `origin` yet — the field landed
2026-09-18 and only the Glacier builder writes it, unrun. B8 cannot be
executed until `origin` is backfilled for at least those two sets. This
compounds with B6, which the park-tours session is feeding with per-tour
clearance findings in the same shape.

**STOP.** Do not change repo visibility. That is the maintainer's call, and
it is effectively irreversible once the code is cloned.

---

## C. Inventory curation

Current corpus: **864 spots / 866 content pieces / ~10.8 hours of audio**
across 9 tour tracks plus 2 empty fill-in tracks (`geography`,
`sat-vocabulary`).

| Track | Spots | Pieces | With audio | Live + silent | Min | Extent |
|-------|------:|-------:|-----------:|--------------:|----:|--------|
| history | 281 | 283 | 177 | **105** | 193 | 4063 km |
| shops-and-restaurants | 116 | 116 | 71 | **45** | 52 | 1416 km |
| parks-and-trails | 109 | 109 | 87 | **22** | 106 | 4062 km |
| fairfax-point-reyes-archive-drive | 107 | 107 | 77 | **30** | 130 | 40 km |
| bothin-to-muir-beach-101 | 100 | 100 | 100 | 0 | 68 | 16 km |
| ~~point-reyes-light-sheriff-calls~~ | 68 | 68 | 68 | 0 | 11 | **held** — B8a |
| real-estate | 37 | 37 | 29 | **8** | 31 | 27 km |
| bothin-to-seven-eleven | 36 | 36 | 36 | 0 | 49 | 0.8 km |
| news | 10 | 10 | 6 | **4** | 6 | 17 km |

"Live + silent" counts published pieces on published spots with no audio.
Columns do not sum to "Pieces" because drafts are excluded from that count.

Sources: 428 imported, 305 human, 133 AI. Triggers: 577 point, 287 area.

### C1 (P1) 214 published pieces have no audio and can never play

Every one of these is `status='published'` on a `status='published'` spot with
`audio_url IS NULL`. Since narration now defaults to **Server audio only**,
and unvoiced stories are excluded from automatic playback, these are dead
weight: they will never be heard, but they count toward track sizes and
series-completion math.

history 105 · shops-and-restaurants 45 · archive-drive 30 · parks-and-trails
22 · real-estate 8 · news 4.

Per track, decide: voice them, unpublish them, or accept them as text-only.
This is the single biggest curation decision and it needs the maintainer.

### C2 (P2) 28 spots are thousands of km outside the corpus

821 of 864 spots are in Marin. The strays sit inside the topic tracks:

- **25 in Glacier NP, Montana** (`parks-and-trails` 17, `history` 6,
  `shops-and-restaurants` 2)
- **3 on the east coast** (NYC / Quebec)

These look like test data from the Going-to-the-Sun-Road work — which already
has its own bundle in the viewer. Promote them into a real Glacier track, or
drop them. Leaving them makes `history` a 4,063 km track.

### C3 (P2) The four "official" topic tracks are catch-all buckets

`history`, `shops-and-restaurants`, `parks-and-trails`, `real-estate`, and
`news` are `official: true`, evergreen, and span multiple regions. They work
at runtime — `/nearby` filters by distance — but as a published inventory they
read as uncurated. Consider region-scoping them (`marin-history`) or
presenting them as topic filters rather than tracks.

### C4 Verified correct — not a bug

All 68 `point-reyes-light-sheriff-calls` spots share the coordinate
`38.100, -122.750`. They are all `trigger_kind='area'` with a fence, and per
the trigger-kind invariant an area spot's `center` is a server-computed fence
centroid used only as a map/sort anchor. Sharing the West Marin listening
fence means sharing a centroid. Correct as designed.

### C5 Redistributing `bothin-to-seven-eleven` into the categories

The track is 36 spots across 0.8 km, all voiced, 49 minutes. It ships — but
as category content, not as a route. The route framing ("a walk from a house
to the 7-Eleven") is the part that reads as private; the individual stories
do not.

The content splits cleanly along the lines the categories already use:

- **`history`** — the Arequipa Sanatorium material: Philip King Brown,
  Frederick Rhead, Albert Solon, Elizabeth Ashe, Verena Ruegg, Henry Bothin
- **`real-estate`** — the address-keyed pieces: 112, 128, 131, 155, 180 and
  300 Bothin Road

Mechanics, checked before writing this:

- `spots.track_id` is a single FK, so this is a **move**, not a copy —
  `bothin-to-seven-eleven` ceases to exist once its spots are reassigned
- **No sequence data is lost.** All three tracks have zero `sequence_key`
  values, so there is no part ordering to preserve
- Lifecycle changes `series` → `evergreen`, so those 36 pieces become
  replayable after cooldown instead of play-once. Minor, but it is a
  behaviour change, not a pure relabel

Not executed — this is a mutation of the live database, and other sessions
are working against it. Run it as a single transaction during execution.

### C6 Track visibility — holding content back without losing it

Built 2026-09-18 (migration `008_track_visibility.sql`). `tracks.visibility`
is `public` or `private`, orthogonal to editorial status.

The alternative was unpublishing: flip 68 spots to `draft`. That conflates
"unfinished" with "finished and deliberately withheld", and it destroys the
per-spot record of what had been published — so restoring means guessing which
rows to put back. Visibility leaves every row untouched, so a hold and a
release are each one UPDATE.

- `private` is enforced in every public surface, and they must agree:
  `findNearby`, `nearbyDataVersion` (or the `unchanged` poll gate lies), the
  route-corridor query, `listTracks`, `listTrackManifests`, `listFillInItems`,
  and `/api/tracks/:id/bundle` (404, indistinguishable from missing).
- Admin surfaces and `exportTrack` deliberately ignore it — a held track stays
  fully visible and editable to its author. That is the point.
- A held row must carry `hold_reason` and `held_at`; a DB check enforces it,
  so the row explains itself a year later.
- `PATCH /api/admin/tracks/:id/visibility` operates it.
- Covered by `server/tests/track-visibility.test.ts` (7 tests), including that
  a hold→release round trip leaves every spot and content status byte-identical.

**Applied:** `point-reyes-light-sheriff-calls` is held, reason recorded. It is
gone from the live catalog; its 68 spots remain published with all 68
recordings intact.

### C7 Point Reyes Light content outside the held track

Holding `point-reyes-light-sheriff-calls` does not hold everything sourced
from the Light. **74 further pieces cite ptreyeslight.com across six public
tracks**, 53 of them live and voiced:

| Track | Pieces | Live + voiced |
|---|---:|---:|
| fairfax-point-reyes-archive-drive | 44 | 28 |
| history | 11 | 6 |
| bothin-to-muir-beach-101 | 9 | 9 |
| news | 4 | 4 |
| parks-and-trails | 3 | 3 |
| shops-and-restaurants | 3 | 3 |

**These are a different thing from the sheriff calls, and the difference is
the whole question.** Sampled, they are GrandTour's own narration *reporting
on* Light articles, crediting the paper by name and date in the spoken text:

> "Animal tracker Richard Vacha wrote about Limantour Spit in the Point Reyes
> Light on February 1, 2023. His most surprising observation is this:
> 'Coyotes sometimes dig small wells in the deepest pockets of the dunes.'"

That piece is 991 characters with a single 70-character attributed quote — 7%.
Ordinary quotation with credit, not reproduction. The sheriff calls are the
inverse: the entire spoken text is the Light's blotter, and attribution is
deliberately kept out of the audio.

**Recommendation: leave these published.** The hold as applied captures the
actual exposure. But the maintainer asked that "the Pt Reyes Light audio" not
ship, and that phrase could be read to cover these too, so it is his call —
holding them as well would cost 53 live pieces across six tracks, including
two whose descriptions advertise "Point Reyes Light reporting" as a feature.

### C8 The production track list

Four tracks are held, leaving **7 production tracks** visible to every public
surface — including the phone, which reaches the viewer at
`http://100.80.32.94:5190` over the tailnet (its Vite `/api` and `/uploads`
proxy to :8787, so no CORS setup is needed; `localhost` will not work there).

| Held | Why |
|---|---|
| `point-reyes-light-sheriff-calls` | B8a — the spoken text is the Light's blotter |
| `geography` | C3 — 644 fill-in quiz items, unreviewed |
| `sat-vocabulary` | C3 — 10,001 fill-in vocab items, unreviewed |
| `bothin-to-seven-eleven` | B5a/C5 — until its 36 spots are redistributed into the categories |

Production: `history`, `news`, `parks-and-trails`, `real-estate`,
`shops-and-restaurants`, `bothin-to-muir-beach-101`,
`fairfax-point-reyes-archive-drive`.

**There is no separate mobile web app.** The whole tree holds three
`index.html` files — the admin, `packages/tour-viewer`, and the copy of the
viewer vendored into the landing site. tour-viewer is the only web player; it
is mobile-responsive and fully usable from a phone browser over the tailnet.
The landing site on :5181 is marketing with a canned demo iframe, not the app.

Two things the real app makes obvious that the tables above do not:

- Opening **History** shows a route of **3,115 miles** — the Marin + Glacier +
  NYC sprawl of C2/C3, rendered as one absurd "full tour".
- Its first up-next is the **Woolworth Building**, one of the NYC spots that
  are held from the release but still live in the DB. Holding whole tracks
  does not reach stray spots inside public ones; C2 still needs doing.

**What this is not.** Visibility is a *release* gate, not rights containment.
A held track is still in the database and still reachable through the admin
and export surfaces — deliberately, since the author must be able to work on
it. So it is the right tool when provenance is understood and the only
question is whether to show the content yet (the sheriff calls: a known,
deliberate reproduction, held over display and attribution).

It is **not** a way to bring in material whose redistribution was never
established as authorized. "Not cleared" does not mean "cleared but
embargoed": importing those files is itself a copy — uploading via `putAudio`,
writing rows that reference them — and holding the track afterwards does not
undo it. Content in that state should not be imported at all, pending an
actual answer. The park-tours session made this distinction when it declined
to import the Everglades audio on these grounds, and was right to.

### C9 Two NYC AI spots ride inside public tracks

"Hold off on the AI-generated NYC" is not fully satisfied by track holds:
**Woolworth Building** (`history`) is published, voiced, AI-written, 2,500
miles from anything else in its track — and confirmed present in the app's
History bundle and on its map (it will never auto-play unless someone stands
in lower Manhattan). **City Hall Park** (`parks-and-trails`) is its sibling;
its trigger is an area fence, so check it the same way after re-export. Visibility works
per track; these are two spots inside tracks that ship. The fix is a status
change, which this plan does not make:

```sql
UPDATE spots SET status='draft' WHERE title IN ('City Hall Park','Woolworth Building')
  AND ST_X(center::geometry) > -80;
```

then re-export. The third NYC spot (Brooklyn Bridge, human, no audio) already
drops out of the voiced-only export.

**STOP.** Do not change any `status` field. Curation decisions are the
maintainer's; this plan only surfaces them.

---

## Decisions still open

Most of the plan is now settled. These remain.

| # | Decision | Blocks |
|---|----------|--------|
| B8b | Whether the held Point Reyes Light track is ever released — licence it, seek permission, or retire it. Held indefinitely is a valid answer; the content is preserved either way. | a later release |
| B2a | URL fix method: bulk-rewrite `audio_url` to the R2 base, or store keys and resolve at read time (needs the `z.string().url()` change from A2) | audio migration |
| B6 | Provenance review of the 428 `imported` pieces. The schema can now record it (`SourceRef.clearance`); the audit is not done. The park-tours session is feeding per-tour findings in that shape for 7 parks. | inventory release |

## Suggested order

1. **B4** land the working tree (nothing else is safe until this is done)
2. **B2** migrate audio to R2 behind a cached custom domain — resolve B2a first
3. **C1 / C2 / C3** unpublish or hold back everything outside the ship list
4. **A5 → A4 → A2** switch the demo to Going-to-the-Sun Road, re-export and
   re-vendor, verify audio locally with `SITE_BASE_URL`
5. **A1** fix the bare `/tour/` error screen
6. **A3** strip the FR locale from the build
7. **B5 / B6 / B8** privacy sweep, provenance audit, licence files
8. Then, and only then, the two buttons: deploy the site, flip the repo public
   (there is no third button — B7 means no public API)
