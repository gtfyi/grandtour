import importlib.util
from datetime import datetime, timedelta, timezone
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("carplay_check", Path(__file__).parents[1] / "check-carplay.py")
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)


class CarPlaySigningTests(unittest.TestCase):
    def setUp(self):
        self.info = {
            "GrandTourCarPlayMode": "audio", "CFBundleIdentifier": "fyi.grandtour.app",
            "CFBundleSupportedPlatforms": ["iPhoneOS"], "GrandTourAPIBaseURL": "https://tour.example.com",
            "UIBackgroundModes": ["audio", "location"],
            "NSLocationWhenInUseUsageDescription": "Tour location",
            "NSLocationAlwaysAndWhenInUseUsageDescription": "Background tour location",
            "UIApplicationSceneManifest": {
                "UIApplicationSupportsMultipleScenes": True,
                "UISceneConfigurations": {"CPTemplateApplicationSceneSessionRoleApplication": [{
                    "UISceneClassName": "CPTemplateApplicationScene",
                    "UISceneDelegateClassName": "GrandTour.CarPlaySceneDelegate",
                }]},
            },
        }
        self.signed = {"application-identifier": "TEAM.fyi.grandtour.app", check.ENTITLEMENTS["audio"]: True}
        self.profile = {"Entitlements": self.signed.copy(),
                        "ExpirationDate": datetime.now(timezone.utc) + timedelta(days=30)}

    def test_correct_device_build_passes(self):
        self.assertEqual(check.check_configuration(self.info), [])
        self.assertEqual(check.check_signing(self.info, self.signed, self.profile), [])

    def test_source_entitlement_without_profile_grant_fails(self):
        del self.profile["Entitlements"][check.ENTITLEMENTS["audio"]]
        self.assertIn("Provisioning profile lacks", " ".join(check.check_signing(self.info, self.signed, self.profile)))

    def test_expired_personal_team_profile_fails(self):
        self.profile.update(LocalProvision=True, ExpirationDate=datetime(2020, 1, 1))
        errors = " ".join(check.check_signing(self.info, self.signed, self.profile))
        self.assertIn("Personal Team", errors)
        self.assertIn("expired", errors)

    def test_wrong_or_mixed_category_fails(self):
        self.signed[check.ENTITLEMENTS["navigation"]] = True
        self.assertIn("mixes", " ".join(check.check_signing(self.info, self.signed, self.profile)))
        del self.signed[check.ENTITLEMENTS["audio"]]
        self.assertIn("App signature lacks", " ".join(check.check_signing(self.info, self.signed, self.profile)))

    def test_missing_scene_class_fails(self):
        scene = self.info["UIApplicationSceneManifest"]["UISceneConfigurations"]["CPTemplateApplicationSceneSessionRoleApplication"][0]
        del scene["UISceneClassName"]
        self.assertIn("Missing CarPlay scene class", " ".join(check.check_configuration(self.info)))

    def test_phone_only_and_simulator_builds_fail(self):
        self.info.update(GrandTourCarPlayMode="none", CFBundleSupportedPlatforms=["iPhoneSimulator"])
        self.assertEqual(len(check.check_configuration(self.info)), 2)

    def test_localhost_and_missing_background_delivery_fail(self):
        self.info.update(GrandTourAPIBaseURL="http://localhost:8787", UIBackgroundModes=["audio"])
        self.assertEqual(len(check.check_configuration(self.info)), 2)

    def test_wrong_app_profile_fails(self):
        self.profile["Entitlements"]["application-identifier"] = "TEAM.other.app"
        self.assertIn("does not match", " ".join(check.check_signing(self.info, self.signed, self.profile)))


if __name__ == "__main__":
    unittest.main()
