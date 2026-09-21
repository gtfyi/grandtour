# Eager playback — September 12, 2026

Build **2026.9.13** fixes missed automatic narration. The signed device app is
at `ios/build-device/Build/Products/Debug-iphoneos/GrandTour.app`; its API base
is `http://100.80.32.94:8787`.

## Evidence and changes

In phone session `9135bdae`, White Hill narration finished at 14:21:38 PDT.
The 15-second pause covered the next point's approach: Last Round at San
Geronimo was logged as passed at 14:21:47 without playing. The next ambient
story did not start until 14:21:53.

- The default pause is now 3 seconds. The prior 15-second setting migrates
  to 3 seconds through `narrationGapSecondsV2`. Longer previous choices are
  preserved; the settings picker still permits selecting 15 seconds.
- An unheard, triggered point takes priority over a farther preferred
  target. Passing its center does not invalidate arrival while still within
  its authored trigger. No starts after leaving a passed point's trigger.
- Every GPS update evaluates the current nearby snapshot before any network
  request or throttle, including when no offline track is pinned.
- Area stories need no initial quiet period. Candidates are filtered by the
  available time before ranking, so a long story cannot hide a shorter fit.
- Playback still respects the current item, replay cooldown, chapter order,
  enabled tracks, and server-only narration.

## Validation and installation

All **136 iOS tests passed**, including full journey simulations, arrival
priority and expiry, cooldown and interruption guards, preference migration,
area selection, and fresh GPS with no server or pinned download. The signed
iPhone/Watch build succeeded and passed `codesign --verify --deep --strict`.

Installation was attempted but CoreDevice returned error 1011: the device
could not be located. Both device listings showed `minnow` unavailable.
The phone's new live session `6bdbc2fc` reports the previous build 2026.9.12,
so these native scheduler fixes are **not yet installed**.

## Immediate content adjustment

The running phone did receive the newly voiced Nicasio reservoir story.
Its location was roughly 909 meters from that story's route anchor, outside
the original 550-meter trigger. Because the narration concerns the reservoir
as a whole, its listening radius was enlarged to 1,000 meters to include
the reservoir stop at Nicasio Valley Road and Point Reyes–Petaluma Road.
This server change is live and requires no reinstall. The new route slate
and database both contain the updated radius; its existing recording remains
unchanged.
