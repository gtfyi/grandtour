# Phone signing repair — September 13, 2026

GrandTour reported “no longer available” on the iPhone after its Personal Team
profile expired September 12 at 15:24 PDT. The installed version was 1.0,
build 2026.9.12. A launch attempt returned CoreDevice error 10002 with a
SpringBoard signing/trust rejection. Xcode initially had no signed-in Apple
account; the user signed in before renewal.

## Renewed build and installation

- Built version 1.0, build **2026.9.13**, using the existing team and bundle IDs.
- Explicitly selected `GRANDTOUR_CARPLAY_MODE=none`, retaining the ordinary
  phone and system Now Playing experience. Dedicated CarPlay still requires
  Apple's entitlement approval; this repair does not establish that approval.
- Preserved the reachable API base `http://100.80.32.94:8787`; `/health` passed.
- Renewed iPhone profile expires **September 20, 2026 at 13:43:01 PDT**;
  embedded Watch profile expires one second earlier.
- Both profiles match the signed app identifiers. The signing certificate
  expires August 28, 2027. `codesign --verify --deep --strict` passed.
- Installed successfully on `minnow` at **13:45 PDT**. Device inventory
  confirms build 2026.9.13. No uninstall was performed.
- All 265 downloaded files in `Library/Application Support/GrandTour/audio`
  survived with unchanged sizes and modification times. All remaining
  pre-existing files were unchanged except for one removed system launch
  screenshot under `Library/SplashBoard/Snapshots`. Preferences compared
  equal before and after installation.

The first launch after installation still returned the SpringBoard
signing/trust rejection. The user was asked to check the Developer App entry
under Settings → General → VPN & Device Management and trust or verify it if
offered. At **13:46 PDT**, a fresh device process inventory confirmed the
newly installed GrandTour executable running as PID 1146.
The subsequent foreground-launch check timed out, and the next device listing
reported the phone unavailable. The successful running-process observation
therefore precedes the loss of the Mac's device connection.

## Receipts

- Build: `/tmp/grandtour-phone-signing-renewed-20260913.log`
- Bundle: `/tmp/grandtour-phone-signing-repair-20260913/Build/Products/Debug-iphoneos/GrandTour.app`
- Install: `/tmp/grandtour-repair-install.json`
- Device inventory: `/tmp/grandtour-repair-app-before.json` and `/tmp/grandtour-repair-app-after.json`
- File inventories: `/tmp/grandtour-repair-files-before.json` and `/tmp/grandtour-repair-files-after.json`
- Preferences: `/tmp/grandtour-repair-preferences-before.plist` and `/tmp/grandtour-repair-preferences-after.plist`
- Initial launch result: `/tmp/grandtour-repair-launch.json`
- Running-process verification: `/tmp/grandtour-repair-processes.json`
- Subsequent launch attempt: `/tmp/grandtour-repair-launch-verified.json`

Apple documents the seven-day Personal Team profile limit in
[Choosing a Membership](https://developer.apple.com/support/compare-memberships/).
