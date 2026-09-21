# CarPlay device readiness — September 13, 2026

The dedicated GrandTour CarPlay app is **not yet ready to install in a car**.
Source and unsigned device compilation can be checked locally, but Apple's
CarPlay grant, valid signing, and an actual-car listening test are still required.
No simulator or CarPlay emulator was used for this audit.

## Confirmed blockers

- Following the [phone signing repair](phone-signing-repair-2026-09-13.md),
  the connected iPhone (`minnow`) has build **2026.9.13**, explicitly built
  with `GRANDTOUR_CARPLAY_MODE=none`. It supports the phone and system Now
  Playing experience; it has no dedicated CarPlay entitlement.
- Xcode sign-in and ordinary phone/Watch signing were restored at 13:43 PDT.
  The renewed **Personal Team** profile expires September 20 at 13:43 PDT.
  A dedicated CarPlay build still needs Apple's approved
  `com.apple.developer.carplay-audio` capability for `fyi.grandtour.app`
  and a matching developer team/profile.
- The wireless audio chopping reported in the earlier
  [car audio diagnosis](car-audio-diagnosis-2026-09-07.md) remains unverified
  on the affected head unit. A passing build or advancing audio clock cannot
  prove what is audible from the speakers.

Apple documents both [requesting the entitlement](https://developer.apple.com/documentation/carplay/requesting-carplay-entitlements)
and [registering the CarPlay scene](https://developer.apple.com/documentation/carplay/displaying-content-in-carplay).
The entitlement request is an account action; editing a plist cannot grant it.

## Changes made

- Register `CPTemplateApplicationScene` explicitly in the scene manifest.
- Sign exactly the configured category on physical devices as well as
  simulator builds: `audio` → `GrandTour.entitlements`, `navigation` →
  `GrandTourNavigation.entitlements`. The previous device build silently
  omitted CarPlay permission. It now fails signing if the profile lacks it.
- Support an explicit `GRANDTOUR_CARPLAY_MODE=none` phone/Now Playing build.
  This mode does **not** provide GrandTour's CarPlay icon, tabs, or map.
- Start shared services and register remote commands at process launch,
  before the phone view appears. Registration is idempotent.
- Make remote Stop end the automatic tour and manual narration; a single
  play/pause button resumes interrupted audio between stories. Replace story
  metadata with GrandTour's idle identity and disable unavailable skip/replay controls. Replays reset
  displayed progress. Remote handlers dispatch to the main thread.
- Provide location-permission status, interrupted-audio recovery, Now Playing
  access, and catalog error text on the Tour tab. Log root-template results
  and clean up Now Playing callbacks on disconnect.
- Add `scripts/check-carplay.py` to inspect an actual built bundle's scene,
  background modes, server URL, signature, entitlement/profile agreement,
  app identifier, and profile expiry. It deliberately rejects simulator,
  phone-only, expired, and unauthorized builds.

The default audio experience is the target for this validation. The existing
navigation mode remains experimental: its guidance still lacks off-route
rerouting and has not been validated as reliable turn-by-turn navigation.

## Build and check for a car

Sign in to Xcode with the approved developer team. Set its team ID for the
iPhone and Watch targets in `ios/project-local.yml`. Enable the approved
CarPlay audio capability on the app ID and regenerate its provisioning profile.
The Watch profile separately needs HealthKit.

From `ios`, replacing the server URL with the server reachable by the iPhone:

```sh
GRANDTOUR_SIGNING=true xcodegen generate
xcodebuild build -project GrandTour.xcodeproj -scheme GrandTour \
  -destination 'generic/platform=iOS' -derivedDataPath build-carplay \
  -allowProvisioningUpdates GRANDTOUR_CARPLAY_MODE=audio \
  GRANDTOUR_API_BASE_URL=https://YOUR-TOUR-SERVER
python3 ../scripts/check-carplay.py \
  build-carplay/Build/Products/Debug-iphoneos/GrandTour.app
```

Only install that build after the check passes. An unsigned build can use
`--configuration-only` for compile-time checks, but that option does not
establish permission to run on the phone or display in CarPlay. For a deliberate
phone-only build while waiting on Apple, set `GRANDTOUR_CARPLAY_MODE=none`;
ordinary phone signing still requires a valid account and unexpired profile.

The currently configured device server uses Tailscale. The phone needs that
connection while streaming, or the desired tracks must be downloaded before
leaving coverage. `localhost` is never the Mac from a physical iPhone.

## Acceptance on the actual car

1. While parked, open the installed phone app, grant location, choose tracks,
   and confirm a downloaded story plays. Record the build number.
2. Connect CarPlay and confirm the GrandTour icon opens Tour / Nearby / Tracks.
   Verify launching from the car works when the phone UI is not already open.
3. Play a complete story on the affected wireless head unit. Listen for the
   reported repeating dropouts, including the beginning of each story.
4. Check steering-wheel play/pause, next, replay, and Stop. Stop must not start
   another story. Test Siri/call interruptions both during a story and between
   stories, then resume with Play.
5. Lock the phone and confirm narration continues. Disconnect/reconnect
   CarPlay and check that there is one playback stream and responsive controls.
6. On a drive, have a passenger confirm GPS-triggered narration and test a
   downloaded track through lost coverage. Repeat wired if supported and
   compare with wireless. Keep the existing keepalive experiment at its
   default off setting for the first comparison.

Inspect `carplay_connect`, `carplay_root_template`, `remote_command`,
`audio_route_change`, `audio_interruption`, and playback events alongside what
the listener actually heard. Logs establish execution and route state, not
speaker audibility.

## Local validation artifacts

- **141 native unit tests passed**, including five Now Playing regressions
  and the existing audio interruption, offline-tour, and scheduler tests.
  All eight bundle/signing checker tests passed as well.
- Physical iPhone + embedded Watch unsigned build:
  `/tmp/grandtour-carplay-device-build-final.log`.
- Native Mac Catalyst unit tests (no emulator):
  `/tmp/grandtour-carplay-native-tests-final.xcresult` and `.log`.
- Signing failure: `/tmp/grandtour-carplay-signing-check.log`.
- Run the eight bundle/signing checker regression tests with
  `python3 -m unittest discover -s scripts/tests -p 'test_carplay_check.py'`.

The new unsigned device bundle passes configuration inspection. The old signed
bundle is correctly rejected for the missing scene class, missing app/profile
CarPlay entitlement, Personal Team provisioning, and expired profile. No new
build was installed on the iPhone during this audit. The later
[phone signing repair](phone-signing-repair-2026-09-13.md) installed a renewed
phone-only build and confirmed its process running; it did not validate
dedicated CarPlay.

## Bluetooth narration follow-up

CarPlay and the phone share `AppServices.tour.player` and `AudioSession`.
The user explicitly requires full audio takeover. `AudioSession.takeOver()`
runs at launch, on CarPlay connection, and before playback. The connection-time
activation has been restored to preserve that ownership policy; it does not
restart the player or unpause narration. GrandTour never deliberately deactivates
the session or signals other media apps to resume, even between stories or
after Pause/Stop. Idle Now Playing metadata stays GrandTour with Play available.
Higher-priority system interruptions remain subject to iOS audio arbitration;
holding the session cannot guarantee that another app or iOS will never interrupt.
The narration configuration stays `.playback` / `.default` / `.longFormAudio`,
with no microphone/HFP option or speaker override. Apple confirms that the
[playback category automatically supports Bluetooth A2DP](https://developer.apple.com/documentation/avfaudio/avaudiosession/categoryoptions-swift.struct/allowbluetootha2dp).
The experimental second-player keepalive continues to default off.

Regression coverage checks that route updates do not restart a playing story,
disconnect/reconnect retains the story and resumes only once, an explicit pause
survives reconnection, denied interruption resumption is respected, repeated
activation preserves the media configuration, and attaching Now Playing controls
leaves narration and the audio configuration intact. These are native tests of
session configuration and injected route events, not measurements of sound over
a physical Bluetooth connection. Actual head-unit audibility remains a field test.

Follow-up validation: **147 native tests passed, zero failures**, and the
unsigned iPhone/Watch build passed. Results are in
`/tmp/grandtour-bluetooth-tests-final.xcresult`,
`/tmp/grandtour-bluetooth-tests-final.log`, and
`/tmp/grandtour-bluetooth-device-build.log`. The native host verifies policy
stability; the effective `.longFormAudio` route-policy assertion requires iOS.
No emulator was used and no new phone build was installed.

Full-takeover follow-up: **30 focused audio/player/Now Playing tests passed**,
including idle identity and Stop retaining GrandTour's controls. The unsigned
iPhone/Watch build also passed. Artifacts:
`/tmp/grandtour-audio-ownership-tests.xcresult`,
`/tmp/grandtour-audio-ownership-tests.log`, and
`/tmp/grandtour-audio-ownership-device-build.log`.
