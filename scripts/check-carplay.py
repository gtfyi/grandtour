#!/usr/bin/env python3
"""Check an actual device .app before an in-car test. No simulator required."""

import argparse
from datetime import datetime, timezone
from pathlib import Path
import plistlib
import subprocess
import sys
from urllib.parse import urlparse


ENTITLEMENTS = {
    "audio": "com.apple.developer.carplay-audio",
    "navigation": "com.apple.developer.carplay-maps",
}


def check_configuration(info):
    errors = []
    mode = info.get("GrandTourCarPlayMode")
    if mode not in ENTITLEMENTS:
        errors.append(f"CarPlay mode is {mode!r}; 'none' is a phone/Now Playing build, not a CarPlay app.")
    if info.get("CFBundleSupportedPlatforms") != ["iPhoneOS"]:
        errors.append("Not a physical iPhone build (CFBundleSupportedPlatforms must be iPhoneOS).")
    manifest = info.get("UIApplicationSceneManifest", {})
    scenes = manifest.get("UISceneConfigurations", {}).get(
        "CPTemplateApplicationSceneSessionRoleApplication", []
    )
    if not any(
        s.get("UISceneClassName") == "CPTemplateApplicationScene"
        and s.get("UISceneDelegateClassName", "").endswith(".CarPlaySceneDelegate")
        and "$" not in s.get("UISceneDelegateClassName", "")
        for s in scenes
    ):
        errors.append("Missing CarPlay scene class or resolved CarPlaySceneDelegate in Info.plist.")
    if not manifest.get("UIApplicationSupportsMultipleScenes"):
        errors.append("Phone and CarPlay scenes must be able to connect independently.")
    if not {"audio", "location"}.issubset(info.get("UIBackgroundModes", [])):
        errors.append("Background audio and location modes are required for a locked-phone tour.")
    for key in ("NSLocationWhenInUseUsageDescription", "NSLocationAlwaysAndWhenInUseUsageDescription"):
        if not info.get(key):
            errors.append(f"Missing {key}.")
    url = urlparse(info.get("GrandTourAPIBaseURL", ""))
    if url.scheme not in ("http", "https") or not url.hostname or url.hostname in (
        "localhost", "127.0.0.1", "::1", "0.0.0.0"
    ) or url.hostname.endswith(".localhost"):
        errors.append("The built-in server must be reachable from the iPhone; localhost points at the phone.")
    return errors


def check_signing(info, signed, profile, now=None):
    errors = []
    required = ENTITLEMENTS.get(info.get("GrandTourCarPlayMode"))
    granted = profile.get("Entitlements", {})
    if required:
        for label, values in (("App signature", signed), ("Provisioning profile", granted)):
            if values.get(required) is not True:
                errors.append(f"{label} lacks {required}. Apple must approve this capability for the app ID.")
        actual = {key for key in ENTITLEMENTS.values() if signed.get(key) is True}
        if actual - {required}:
            errors.append("App signature mixes audio and navigation entitlements; sign only the configured category.")
    if profile.get("LocalProvision"):
        errors.append("Personal Team provisioning cannot authorize this CarPlay app; use an approved developer team/profile.")
    expiry = profile.get("ExpirationDate")
    now = now or datetime.now(timezone.utc)
    if not isinstance(expiry, datetime) or expiry.replace(tzinfo=timezone.utc) <= now:
        errors.append(f"Provisioning profile expired or has no expiration date ({expiry}).")
    app_id = signed.get("application-identifier", "")
    if not app_id.endswith("." + info.get("CFBundleIdentifier", "")):
        errors.append("Signature application identifier does not match the built app.")
    profile_id = granted.get("application-identifier", "")
    if not profile_id or not (app_id.startswith(profile_id[:-1]) if profile_id.endswith("*") else app_id == profile_id):
        errors.append("Provisioning profile application identifier does not match the signature.")
    return errors


def run(*args):
    result = subprocess.run(args, capture_output=True)
    if result.returncode:
        raise ValueError(result.stderr.decode().strip() or f"{args[0]} failed")
    return result.stdout


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("app", type=Path, help="Built GrandTour.app for iPhoneOS")
    parser.add_argument("--configuration-only", action="store_true",
                        help="Inspect an unsigned compilation; does NOT establish device eligibility")
    args = parser.parse_args()
    try:
        info = plistlib.loads((args.app / "Info.plist").read_bytes())
        errors = check_configuration(info)
        if not args.configuration_only:
            run("codesign", "--verify", "--deep", "--strict", str(args.app))
            signed = plistlib.loads(run("codesign", "-d", "--entitlements", ":-", str(args.app)))
            profile = plistlib.loads(run("security", "cms", "-D", "-i", str(args.app / "embedded.mobileprovision")))
            errors += check_signing(info, signed, profile)
    except (OSError, ValueError, plistlib.InvalidFileException) as error:
        errors = [str(error)]
    if errors:
        for error in errors:
            print(f"FAIL: {error}", file=sys.stderr)
        return 1
    print(f"PASS: build {info.get('CFBundleVersion')} / {info.get('GrandTourCarPlayMode')} configuration.")
    if args.configuration_only:
        print("Unsigned inspection only. Device signing and in-car operation remain unverified.")
    else:
        print("PASS: signature and provisioning permit this CarPlay category.")
        print("Still required: install on iPhone and listen/control playback in the actual car.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
