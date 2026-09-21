# Car audio diagnosis — September 7, 2026

GrandTour reportedly cuts in and out roughly every second throughout a story
over **wireless CarPlay**; its phone speaker and other car audio apps work.
Existing evidence confirms interruption-recovery failures but **does not prove
the cause of this continuous chopping**. Acceptance requires a parked listening
test on the affected car.

Baseline evidence was captured around September 7, 10:26 PDT / 17:26 UTC.
GrandTour 1.0, build **2026.9.7**, has now been installed and launched on the
connected iPhone. Actual-car audibility and transport validation remain pending.

Follow-up: build **2026.9.8** was installed and launched at 10:54 PDT with the
whole-track download feature. It retains these audio fixes and the comparison
switch. The combined iOS suite passed 116 tests; real-car audibility remains
unverified. Install receipt: `/tmp/grandtour-download-install.json`.

## Installed changes and validation

- Audio-session interruptions are tracked between stories as well as during
  playback. A denied activation or declined automatic resume preserves the
  narration instead of letting the watchdog discard unheard stories. Explicit
  Play can reclaim the session; the keepalive follows the same permission.
- Delayed speech callbacks cannot stop or start a replacement story. Media
  resets rebuild the synthesizer. Explicit Pause is retained during a Siri
  interruption and while a recording downloads.
- A foreground-started tour can continue receiving location with When-In-Use
  permission when the phone locks, with the location indicator visible.
- The keepalive comparison switch below is available in Tracks. New diagnostics
  identify the build, playback states/stalls, route format/latency, and numeric
  session errors. These measurements still cannot directly measure sound from
  the head unit.
- **99 iOS tests passed, zero failures**, including 12 audio-player and four
  audio-session tests. All four Bun workspaces passed typechecking. The signed
  iPhone/Watch build succeeded and its signature was verified. Both app bundles
  carry build 2026.9.7. Normal installation preserved the existing app container;
  the API address was retained. Install and launch both returned success.
- The dedicated CarPlay app remains blocked by its missing Apple-granted
  entitlement. The available car interface is system Now Playing. Turn the tour
  back on after the app restart.

Validation artifacts: `/tmp/grandtour-audio-20260907-tests-final.xcresult`,
`/tmp/grandtour-audio-tests-final.log`,
`/tmp/grandtour-audio-device-build-final.log`,
`/tmp/grandtour-audio-typecheck.log`,
`/tmp/grandtour-audio-install-2026-9-7.json`, and
`/tmp/grandtour-audio-launch-2026-9-7.json`.

## Confirmed baseline

- **Installed build:** GrandTour 1.0, build 1, on an iPhone 17 Pro running
  iOS 26.6.1. Its installed bundle directory exactly matches the successful
  September 6, 22:51 PDT installation record. The associated local binary was
  built at 22:50:58 and contains keepalive, route diagnostics, and the watchdog.
  Version 1 alone cannot distinguish builds; no device binary hash or source
  revision was recovered.
- **CarPlay interface blocker:** the associated signed app lacks both
  `carplay-audio` and `carplay-maps`. `ios/project.yml` applies those keys only
  to simulator builds; independent inspection also found them absent from a
  device build's provisioning profile. GrandTour's dedicated CarPlay icon and
  templates need an entitled device build. Ordinary playback and system Now
  Playing are separate capabilities. Apple provides a
  [CarPlay entitlement request](https://developer.apple.com/carplay/);
  adding a source-plist key does not grant it.
- **Latest playback:** the September 7 daily log contains 35 starts, all
  `engine=recorded, local=true`. Logged output is the speaker or AirPods;
  no instrumented session identifies a real car route. The phone's preference
  snapshot has no narration override, so the source default is
  `serverWhenAvailable`.
- **Keepalive present:** the phone contains `keepalive-dither-v1.wav`, modified
  September 6 at 22:47 PDT, and logs successful keepalive playback on AirPods.
  Its effectiveness on this car remains unmeasured. No pending diagnostic
  spill journal was present in the phone cache.

## Confirmed recovery failure

Session `f586d14d` has **32 cached-recording starts, 23 finishes, nine watchdog
stops, eight activation errors, and four interruption-began events with no
logged interruption-ended event**. This is missed/silent playback, not evidence
of one-second transport dropouts.

| UTC, September 7 | PDT | Observed event |
| --- | --- | --- |
| 05:51:26 | Sep 6, 22:51:26 | Tour starts on AirPods; keepalive succeeds. |
| Before 06:18:04 | Before Sep 6, 23:18:04 | Sixteen recordings start and finish without activation errors or watchdog stops. |
| 06:18:04 | Sep 6, 23:18:04 | Interruption begins between stories, `loaded=false`. |
| 06:23:05–06:26:27 | Sep 6, 23:23:05–23:26:27 | Five cached recordings fail activation, stall approximately 40 seconds each, and are abandoned. |
| 06:27:07 | Sep 6, 23:27:07 | Playback starts progressing again without a logged interruption-ended event. |
| 06:34:16 | Sep 6, 23:34:16 | Another interruption begins while narration is loaded. |
| 06:37:38–06:37:42 | Sep 6, 23:37:38–23:37:42 | User pauses; AirPods disconnect; output becomes speaker; keepalive stops; route-disconnected interruption begins. |
| 08:13:33–08:13:41 | Sep 7, 01:13:33–01:13:41 | User resumes on speaker; another interruption begins. |
| 08:15:41–08:17:43 | Sep 7, 01:15:41–01:17:43 | The interrupted play is abandoned after 120 seconds, followed by three more stalled recordings and activation failures. |

The baseline code retained interruption state only while a clip was loaded,
and `AudioSession.takeOver()` returned no activation result. Playback proceeded
even after activation failed. These behaviors match the observed sequence.
The old error event records only “Session activation failed,” without NSError
domain or code, so its precise OSStatus cause and the interrupting app/system
activity cannot be recovered retrospectively.

## Earlier driving evidence

These sessions have speeds consistent with driving, but predate audio-route
diagnostics and therefore cannot independently establish CarPlay connection.

| Session | UTC interval | Maximum speed | Cached recordings | Live device speech |
| --- | --- | --- | --- | --- |
| `fc6abe22` | Aug 30, 21:12–21:46 | 25.10 m/s | 12 | 3 |
| `1836d8c6` | Sep 1, 23:29–23:58 | 15.33 m/s | 4 | 24 |
| `0a906704` | Sep 1, 23:58–Sep 2, 00:26 | 16.62 m/s | 2 | 28 |

Device speech accounts for **52 of 58 starts** in the two September 1 sessions.
Every recorded start in these samples has `local=true`. Download availability
may influence speech fallback, but these recordings were already playing from
disk. Reproduction must compare both engines.

## Confidence limits

Clipped first syllables after gaps do not explain chopping throughout a story.
Existing comments about spoken-audio routing and head-unit gating reflect prior
hypotheses; the available logs are not a controlled car comparison. Session
configuration, concurrent keepalive rendering, metadata updates, and wireless
transport remain candidates. Neither `play_finish` nor a successful simulator
test proves that the head unit emitted every frame. The overnight AirPods
failure must not be presented as the established cause of the car symptom.

## Parked comparison and acceptance test

1. Connect wireless CarPlay, start a fresh tour, and choose a known downloaded
   story with recorded narration selected. Note the installed build, local time,
   head-unit model, route, and title. Listen for at least two minutes, including
   sentences well after the start.
2. The new **Tracks → Car audio → Keep car audio connected** control defaults
   to **on**. While parked and a cached recording is playing, turn it **off**:
   this immediately stops the concurrent keepalive for comparison. Note whether
   chopping changes; turn it back on and repeat the same passage. A consistent
   on/off difference implicates this interaction, but does not yet explain its
   low-level cause. This control is installed in build 2026.9.7.
3. Lock the phone while playback continues and show the car's system Now
   Playing screen. Check title, pause/resume, skip, and replay. Check locating
   introductions and a silent gap followed by the next story for lost syllables.
4. Repeat the same cached story through wired CarPlay, if supported, and the
   speaker, keeping narration, playback rate, and keepalive setting unchanged.
   Then compare recorded narration with device speech on wireless CarPlay.
   Separate whole missed clips from dropouts within a progressing clip.
5. Invoke and dismiss Siri, then verify recovery. Disconnect and reconnect the
   car while parked; confirm stories remain recoverable without being silently
   consumed. Preserve the user's paused state when testing a paused story.
6. Correlate audible timestamps with route, interruption, activation, keepalive,
   player-state, and watchdog events. Confirm an actual car output route.
   From `server`, run `bun run diag diag/tour-2026-09-07.jsonl`. If chopping
   remains, record the car's sound on a second device; app completion events
   cannot measure transport dropouts.

The CLI's obsolete undefined `blocked` branch is fixed; its final verdict now
explicitly concerns trigger failures. That report fix passed current and older
log smoke checks and server typechecking; it is not app/car validation.

## Evidence locations

- Logs: `server/diag/tour-2026-09-07.jsonl` and earlier daily JSONL files.
- Baseline metadata/cache: `/tmp/grandtour-field-installed-app.json`,
  `/tmp/grandtour-field-cache-files.json`.
- Prior installation: `/tmp/grandtour-phone-update/track-selector-install.json`.
- Associated signed app: `/tmp/grandtour-phone-update/build/Build/Products/Debug-iphoneos/GrandTour.app`.
- Independent signing/profile inspection: `ios/build-device`; device signing
  policy: `ios/project.yml`. Inspect signed entitlements using
  `codesign -d --entitlements :-` against the app.

Temporary evidence files are local investigation artifacts, not committed data.
