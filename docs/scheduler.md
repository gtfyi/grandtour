# The scheduler: what plays, and when

How the tour decides what to narrate next. Living spec: it describes the code
as built and is the place to argue about changing it.

Code map:

- [`SpotScheduler`](../ios/Sources/SpotScheduler.swift) — **wander** style:
  the predict-and-target decision core. Pure (no clocks, audio, network);
  driven deterministically by `SpotSchedulerTests` + `JourneySimulator`.
  `RepeatedTownTests` carries disk-backed history across walking/driving visits.
- [`GuidedTourPlanner`](../ios/Sources/GuidedTourPlanner.swift) — **guided**
  style: next stop, arrival, directions. Pure; `GuidedTourPlannerTests`.
- [`NarrationDuration`](../ios/Sources/NarrationDuration.swift) — how long a
  story runs (measured clip, else estimated from text) — feeds the lead
  window and every "does this fit" test.
- [`TourViewModel`](../ios/Sources/TourViewModel.swift) — the orchestrator:
  polling, decision points, the gap planner (ambient + fill-ins), guided
  session state and spoken cues, locator intros.
- [`PlaybackEligibility`](../ios/Sources/PlaybackEligibility.swift) — shared
  phone/watch manifest rules for chapter order and series replay suppression.
- [`TriggerEvaluator`](../ios/Sources/TriggerEvaluator.swift) — on-device
  "am I in this spot?" for unchanged-polls, offline, and the watch.
- [`AudioPlayer`](../ios/Sources/AudioPlayer.swift) — the signals the
  scheduler runs on: `nowPlayingSpotId == nil` (idle → decide),
  `onApproachingEnd` (~8 s left → pre-warm), and `speakCue` (guided
  directions).
- [`WatchTourEngine`](../ios/WatchSources/WatchTourEngine.swift) +
  [`PollPolicy`](../ios/Sources/PollPolicy.swift) — the watch runs the wander
  core unchanged on a sparser polling economy.

## Two tour styles

The user picks one in the Tracks sheet (`TourStyle`, persisted):

| | **Wander** (default) | **Guided** ("Walking tour: *track*") |
|---|---|---|
| Tracks | every enabled track | one track |
| What's next | the least-heard eligible spot **ahead** of where you'll be when the player frees up (preferred track breaks freshness ties) | the next **stop** to walk to (authored order, else nearest unvisited) |
| Direction matters? | yes — a spot you've passed is gone for this pass | no — you'll turn toward it; the app tells you where |
| Starts when | its lead window opens (story ends ≈ on arrival) or you enter the radius | you enter the radius (arrival) |
| Between stories | fillers (heard spots) if they fit, ambient area stories, then fill-ins | spoken directions, ambient area stories; **no fill-ins** |
| Objective | most unheard stories over the journey, each played just before you reach it | see every stop, in a sensible order, without looking at the phone |

Both share: nothing preempts, nothing overlaps (a start only ever happens
against an idle player); manual taps always play; every play is recorded in
`PlayHistory` and re-arms the gap clock.

## 1. Wander: the model

There is **no queue and no pool**. At every decision point the scheduler
recomputes, from scratch, exactly one *target* — the spot the tour is heading
for — and, if the player is idle, what to start right now.

### Inputs (`SpotScheduler.Context`)

| Input | Source |
|---|---|
| `location`, `courseDeg` | freshest fix; course = GPS course if valid, else bearing from the previous poll when moved > 15 m, else nil |
| `mode` | user setting; supplies an assumed speed when the fix has none |
| `journeyRoute` | active journey polyline (strongest predictor), may be empty |
| `trackOrder`, `trackIdToSlug` | optional Tracks-sheet ordering |
| `now`, `lastPlayedAt`, `playCount` | clock + `PlayHistory` |
| `isEligible`, `neverReplays` | sequence gate; series-track membership |
| `busyForS`, `nowPlayingId` | how long the player stays busy (0 idle); what's playing |
| `durationS` | narration length per spot (`NarrationDuration` by default) |

`busyForS` is the **prediction horizon**: recorded audio reports its clock;
on-device speech runs on the estimate it started with.

### Step 1 — predict where the traveler will be when the player is free

`Prediction`: if idle → here, now. Otherwise advance `speed × busyForS`:
along the **journey route** when one is active and the traveler is within
500 m of it (projected onto the nearest *segment*, then forward — so it knows
about the turn ahead); else **dead reckoning** along the course; else stay
put (no course). Heading at the predicted point = route bearing there, else
the current course.

Speed: the GPS speed when it's a real moving figure; the mode's typical speed
(walking 1.4, cycling 4.5, driving 12, … m/s) when the fix reports none;
**nil when a valid speed says stationary** (< 0.3 m/s) — then nothing is
projected and no lead window opens early, so a red light can't start the
story for 500 m down the road.

### Step 2 — eligibility

A spot can be auto-played at all only if it is: point kind (area spots
belong to the gap planner), narratable, not what's playing, released by the
sequence gate, and not replay-blocked — a series unit that was ever heard is
retired; an evergreen spot heard within the **6 h** cooldown is out; beyond
that it's back (ranked behind unheard ones).

### Step 3 — predict ahead, but honor an actual arrival

Relative to the predicted position and heading, a spot is ahead when its
**center** lies forward along the course (positive along-track component),
or is within **`hereM` = 15 m** ("right here" — GPS jitter alone spans it;
matches `SpotLocator`). This predicts future targets while audio is busy.
When idle, an unheard point whose trigger contains the traveler takes
priority, even if its center is slightly behind. Once outside its trigger,
a passed point no longer starts. Unknown course cannot exclude a spot.

### Step 4 — the target ("Up next")

First choose an eligible, unheard point already triggered while idle. If
there is none, choose among spots ahead of the predicted position **and on its approach
line** (lateral offset ≤ radius + 10 m when course is known), the best by strict
lexicographic rank:

1. **freshness tier** — 0 never played, else `max(1, 31 − daysSince)`
   (played today = 31 … a month+ ago = 1; day buckets on purpose). A
   never-heard story on any track beats a heard one on the favorite track;
2. **track preference** (index in the user's ordering; unlisted/unset tie);
3. **play count** (fewer first);
4. **distance from the predicted position** (nearer first).

An unheard spot on a parallel street cannot reserve airtime or block an
on-path story; a turn toward it makes it a candidate again. Distance is only
ever the tie-breaker. The objective is the most unheard
stories over the whole journey, not the nearest one now. The target is what
the UI shows as *Up next* (with a live locator line: "Coming up in 90 meters
on your left"), what `prepareForDecision` pre-caches, and what the watch
shows. It is re-aimed on every poll (1.5 s) and every player-idle event, and
logged on each change (`up_next`, `spot_passed`, `target_replaced`).

### Step 5 — the start window (when the target actually plays)

Only against an idle player. The target is *startable* when it's ahead of
the current position **and** either

- the traveler is **inside its trigger radius** (the authored arrival), or
- it's **coming up head-on within the lead window**: the straight path
  passes through the trigger (lateral offset ≤ radius + 10 m) and the
  along-track ETA to its center ≤ `min(duration, 60 s) + 5 s`. So a 60 s
  story opens ≈ 91 m out on foot and wraps up about as you arrive — "played
  right before you reach it" — while a three-minute story still opens no
  more than 65 s early.

Stationary (valid zero speed): only the radius starts it.

### Step 6 — fillers: heard spots earn airtime only when free

If the target isn't startable yet, another eligible spot that *is* startable
now (typically one heard days ago, or a lower-ranked track's) plays as a
**filler** — but only if `its duration + 8 s ≤ time until the target's window
opens`. A filler never costs an unheard story. Fillers rank by the same
order as targets.

### Step 7 — the gap planner, within budget

No spot startable ⇒ the view model's gap planner may use the remaining time
before the target opens (`gapBudgetS`; unbounded if there's no target or its
ETA is unknowable): first an **ambient area spot** whose fence contains the
traveler (unheard first, then longest-forgotten, then the
most specific fence), then a **fill-in item** (after the user's quiet
threshold, default 30 s; round-robin across enabled fill-in tracks, random
unplayed item within) — each only if it fits the budget. Fill-ins therefore
play only when no spot from an active track is available or imminent.
Filter ambient candidates by the available duration before ranking, so a
long candidate cannot hide a shorter story that fits. Initial idle adds
no ambient delay. After playback ends, a shared pause defaults to 3 seconds;
the old 15-second default upgrades to 3 seconds, with longer choices retained.
Known nearby triggers are reevaluated on every GPS update, even while a
server request is pending and no offline track has been downloaded.

### What this buys over the old pool

- A spot you're walking *toward* is promised — and pre-cached — before you
  enter it; the old design only knew about spots you'd already entered.
- A spot remains playable while you are inside its authored trigger;
  an unheard arrival takes priority over a farther preferred target.
- Airtime goes to unheard stories first; heard ones fill only harmless gaps.
- Fill-ins can't blanket the next story.
- No hysteresis state: the replay cooldown does the job `insideSpotIds` did.

## 2. Guided: one track as a walking tour

Session state lives in the view model (`guidedVisited`, the last cue);
`GuidedTourPlanner.plan` answers "where next, how far, have we arrived?"

- **Stops** = the track's narratable point spots in range. Visited stops
  drop out (seeded at session start with stops heard within the cooldown, so
  reopening the app mid-walk resumes where it left off).
- **Order**: if every stop carries one authored sequence key → by index
  (the sequence gate still holds later parts); otherwise the **nearest
  unvisited** stop from the current position — a greedy chain that reads
  well on foot and re-plans as you go.
- **Arrival** = inside the next stop's radius, whatever your heading. No
  early lead: a stop narrates once you're standing at it (with the locator
  intro, "Right here on your left").
- **Directions** are `SpotLocator.describe` from the current fix — the same
  sentence the wander locator uses — shown under *Next stop* and **spoken**
  (`AudioPlayer.speakCue`) when a stop becomes next, again if you've moved
  **40 m farther** from it since the last cue (heading away), and as a
  reminder every **150 s** while it's more than 60 m off. Cues occupy the
  player like narration (no overlap) but last a few seconds.
- **Between stops**: the track's ambient area stories may play; no fill-ins.
- **Done**: every unit in the track's manifest visited (so stops beyond the
  2 km window count) → one spoken "That's the end of the tour." Area stories
  remain playable when no point stop is eligible, including an introduction
  that gates the next stop and an epilogue after the last point stop.

## 3. Polling and decision points (phone)

- Every GPS fix → `refresh`, throttled to **1.5 s** while touring (4 s
  otherwise), single-flight; a **30 s heartbeat** polls while stationary.
- `changedSince` only within **100 m** of where the version was fetched; an
  `unchanged` response re-evaluates triggers locally (`TriggerEvaluator`).
- Server unreachable → offline cache; no cache → still decide (a dead
  stretch is where a fill-in is most welcome).
- ~**8 s** before recorded narration ends: bypass the throttle, refresh,
  pre-cache the target's audio.
- Exploring the map suspends automatic decisions, including player-idle
  events after a manually played remote story finishes.
- **Every** snapshot and every player-idle event runs `decideNext`: wander →
  `SpotScheduler.plan`; guided → `GuidedTourPlanner.plan` + cue logic.

The watch catches triggers locally on every fix and polls the network per
`PollPolicy` (10 s moving / 60 s stationary); it runs the wander core with
no gap planner and no guided style (yet). It fetches the same whole-track
manifests as the phone and caches them per server for offline restarts;
sequence gates and series replay suppression use `PlaybackEligibility` on
both devices.

Regression coverage includes real view-model decisions for exploration and
mixed point/area sequences, plus four visits through the same town on foot,
by car, and alternating modes. Visits reverse direction, reload persistent
history, return within and beyond the cooldown, and discover newly published
stories on a lower-preference track. These tests require fresh narration at
every block and reject replays while fresh stories compete there.

## 4. Constants

| Constant | Value | Where |
|---|---|---|
| Replay cooldown | 6 h | `SpotScheduler.replayCooldownS` |
| "Right here" tolerance | 15 m | `SpotScheduler.hereM` |
| Max lead | 60 s (+ 5 s arrive margin) | `maxLeadS`, `arriveMarginS` |
| Lane slack for early start | radius + 10 m | `laneSlackM` |
| Filler margin | 8 s | `fillerMarginS` |
| Stationary threshold | 0.3 m/s | `stationaryBelowMps` |
| Journey-route snap | 500 m | `pointAlongRoute` |
| Assumed speeds | walk 1.4 · cycle 4.5 · drive 12 · transit 10 · boat 5 · air 60 · museum 0.5 m/s | `assumedSpeedMps` |
| Freshness tiers | 31 day-sized | `freshnessRank` |
| Fill-in quiet | 30 s default (setting) | `FillInGapPreference` |
| Guided: heading-away | 40 m | `GuidedTourPlanner.headingAwayM` |
| Guided: reminder | 150 s, not within 60 m | `reminderIntervalS`, `noReminderWithinM` |
| Fetch throttle | 1.5 s touring / 4 s | `TourViewModel.refresh` |
| Heartbeat | 30 s | `startHeartbeat` |
| Pre-end warmup | 8 s | `AudioPlayer` |
| Watch poll | 10 s / 60 s | `PollPolicy` |

## 5. The web app

`TourPlayback` in `packages/tour-viewer` runs this same decision core.
`SpotScheduler` is ported line for line to `packages/shared/src/scheduler.ts`
(durations in `narration.ts`, the walking/driving detector in
`activityMode.ts`), and the player's `decide()` is `decideWander` from
`TourViewModel.swift`: name the target, and when the player is idle and the
pause has run out, start the target, a fitting filler, or an ambient story
for the gap. `scripts/scheduler-parity/run.sh` compiles the phone's
scheduler, generates golden cases — 3472 decisions over a grid of
positions, courses, speeds, modes, busy times, histories and track orders,
16 simulated journeys and 12 repeated-town visits with carried history —
and replays them through the port. All 3500 match exactly.

| | Phone | Web app |
|---|---|---|
| What starts | the predicted target: lead window, fillers, freshness tiers (§1) | the same code — `plan.playNow` |
| Up next | `wanderPlan.target` | the same — `plan.target` |
| Ambient area stories | in a gap, after the pause: unheard, longest-forgotten, most specific fence (`pickAmbientSpot`) | the same order (`pickAmbient`), within the same `gapBudgetS` |
| Pause after a story | `NarrationGapPreference`, 3 s default | the same options and default (`gap.ts`) |
| Replay rules | 6 h evergreen cooldown; series once; play counts; 180-day retention (`PlayHistory`) | the same (`playHistory.ts`) |
| Sequences | `PlaybackEligibility` over the manifest | `sequenceReleased` over the loaded bundle |
| Activity mode | `ActivityModeDetector` + the Settings choice | the same port + the Travel setting |
| Decision points | every poll (`PollPolicy`) and every narration end | every fix, every narration end, the pause timer, and a 2 s poll while the tour runs |
| Trigger evaluation | `TriggerEvaluator` | `computeNearby` — 396 golden cases agree |
| Distance | `Geo.localDistanceM` | `localDistanceM` — the same arithmetic |
| Fill-ins, guided style, journeys, locating clips by course | yes | no |
| Background | yes | no: the page holds a screen wake lock instead |

The distance row has a story. Parity first came in at 3464/3500 with
sub-metre drifts that grew along a path, and `CLLocation.distance(from:)`
turned out not to be a pure function of its two points: it measures with a
cached local projection, so the same pair returns values ~1e-5 apart
depending on what was asked before it (a knife-edge decision in one journey
moved by four polls). When fresh at the observer it computes the
flat-ellipsoid distance with the WGS84 radii at the observer's latitude —
so that is now the one explicit formula on both platforms, and nothing in
tour logic calls CoreLocation's distance any more.

## 6. Open questions / next iterations

1. **Freshness tiers are day-sized**: two spots both heard "today" tie on
   freshness and fall through to track preference, even if one was heard
   this morning and the other at breakfast a week ago tomorrow. Fine so far.
2. **Lead window on uncertain paths**: on a curvy walk the head-on test can
   open a story ~90 m early for a spot the walker then turns away from. The
   lane check limits it; a road-network predictor would remove it.
3. **Duration estimates for on-device speech** (2.5 words/s + pauses) drive
   the lead and fit tests; measure against real synthesizer output.
4. **Guided ordering** is nearest-neighbor when unsequenced. An authored
   `order` on walking-tour tracks would be better than any heuristic.
5. **Watch guided style**: the planner is shareable; the cue speech path
   isn't wired on the watch.
6. An earlier proposal for a DP-based multi-spot plan over the predicted
   path was set aside: with "one target, re-aimed every 1.5 s" the greedy
   rule already captures the objective, and it stays explainable from a
   single log line.
