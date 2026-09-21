# Phone signing repair — September 20, 2026

The iPhone again reported GrandTour “no longer available.” The previous
Personal Team profile expired September 20 at 13:43 PDT, as recorded in
[the September 13 repair](phone-signing-repair-2026-09-13.md).

## Build and installation

- Built the current workspace, including the new demo-drive feature, as
  version 1.0, build **2026.9.20**. The build number was supplied to
  `xcodebuild`; no app source changes were needed for the renewal.
- Regenerated the project with `GRANDTOUR_SIGNING=true` and built with
  automatic provisioning updates, the existing developer team and bundle
  identifiers, and `GRANDTOUR_CARPLAY_MODE=none`.
- Preserved the built-in server `http://100.80.32.94:8787`; `/health` passed.
- The renewed phone profile expires **September 27, 2026 at 16:21:07 PDT**;
  the embedded Watch profile expires one second later. The phone profile
  includes the target iPhone, and its app identifier matches the signature.
- `codesign --verify --deep --strict` passed for the built app.
- Installed in place on `minnow`; device inventory confirms build 2026.9.20.
  No uninstall was performed.
- All **371 downloaded audio files** retained their sizes and modification
  times. All other pre-existing files were unchanged except one removed
  system launch screenshot in `Library/SplashBoard/Snapshots`. Preferences
  compared equal before and after installation, before first launch.

The initial launch returned CoreDevice error 10002 with a SpringBoard
signing/trust rejection. The user was asked to trust or verify the developer
app under Settings → General → VPN & Device Management. The user subsequently
reported reaching the recording flow. The follow-up offline-recording build
**2026.9.21** was installed in place at 21:38 PDT and launched successfully
through CoreDevice, confirming that the signing block was resolved.

This renews the ordinary phone/system Now Playing build. It does not add
Apple's dedicated CarPlay entitlement. Apple documents the seven-day
Personal Team provisioning limit in
[Choosing a Membership](https://developer.apple.com/support/compare-memberships/).

## Receipts

- Build log: `/tmp/grandtour-phone-build-20260920.log`
- App: `/tmp/grandtour-phone-renewal-20260920/Build/Products/Debug-iphoneos/GrandTour.app`
- Decoded profiles: `/tmp/grandtour-phone-profile-20260920.plist` and
  `/tmp/grandtour-watch-profile-20260920.plist`
- Install: `/tmp/grandtour-phone-install-20260920.json`
- App inventories: `/tmp/grandtour-phone-app-before-20260920.json` and
  `/tmp/grandtour-phone-app-after-20260920.json`
- File inventories: `/tmp/grandtour-phone-files-before-20260920.json` and
  `/tmp/grandtour-phone-files-after-20260920.json`
- Preferences: `/tmp/grandtour-phone-preferences-before-20260920.plist` and
  `/tmp/grandtour-phone-preferences-after-20260920.plist`
- Initial launch: `/tmp/grandtour-phone-launch-20260920.json`
