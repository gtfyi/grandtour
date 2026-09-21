import CoreLocation
import Combine

/// Publishes the user's location and heading. Drives the nearby polling.
///
/// Two levels of service:
///   - `startBrowsing()` — "When In Use" only, foreground. Enough to center
///     the map and browse; no background delivery.
///   - `startTour()` — the ON switch. Requests "Always", turns on background
///     location delivery, and keeps updates flowing with the app backgrounded
///     and the screen locked. This is what makes a pocketed phone narrate.
@MainActor
final class LocationManager: NSObject, ObservableObject, CLLocationManagerDelegate {
    @Published var location: CLLocation?
    @Published var heading: CLHeading?
    @Published var authorized = false
    /// True once the user has granted "Always". An active tour started while
    /// in use can also continue in the background with When-In-Use access.
    @Published var alwaysAuthorized = false
    /// Set when the user has denied location outright, so the UI can point
    /// them at Settings instead of silently doing nothing.
    @Published var denied = false
    /// True while background delivery is active (tour is ON).
    @Published private(set) var isTouring = false

    private let manager = CLLocationManager()
    /// Set when startTour() ran before authorization arrived, so the delegate
    /// callback can finish enabling background updates once it does.
    private var wantsBackground = false

    override init() {
        super.init()
        manager.delegate = self
        // Browsing accuracy. A tour tightens both of these (see startTour):
        // trigger radii are as small as 35 m, so ±10 m of GPS error and 10 m
        // of movement slack can straddle a whole trigger.
        manager.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
        manager.distanceFilter = 10
        // Keep the blue-bar/arrow indicator honest while touring.
        manager.pausesLocationUpdatesAutomatically = false
    }

    /// Foreground-only location, for map centering and browsing.
    func startBrowsing() {
        manager.requestWhenInUseAuthorization()
        manager.startUpdatingLocation()
        if CLLocationManager.headingAvailable() {
            manager.startUpdatingHeading()
        }
    }

    /// Tour ON: full background tracking.
    func startTour() {
        wantsBackground = true
        isTouring = true
        // Best accuracy and every update: spots trigger on a 35 m radius, and
        // a walker crossing one gets only a handful of fixes to notice it.
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.distanceFilter = kCLDistanceFilterNone
        // "Always" can only be requested once we already hold "When In Use";
        // asking cold shows the When-In-Use prompt first, then this promotes.
        if manager.authorizationStatus == .notDetermined {
            manager.requestWhenInUseAuthorization()
        } else {
            manager.requestAlwaysAuthorization()
        }
        manager.startUpdatingLocation()
        if CLLocationManager.headingAvailable() {
            manager.startUpdatingHeading()
        }
        applyBackgroundUpdates()
    }

    /// Tour OFF: drop back to foreground-only. Location keeps flowing while
    /// the app is open (the map still follows you), but the device stops
    /// waking us in the background.
    func stopTour() {
        wantsBackground = false
        isTouring = false
        // Back to the cheaper browsing cadence.
        manager.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
        manager.distanceFilter = 10
        applyBackgroundUpdates()
    }

    /// With the location background mode, a tour started while the app is in
    /// use can keep receiving fixes under either authorization level. Requiring
    /// Always here silently stopped When-In-Use tours when the phone locked.
    /// Keep the location indicator visible for the whole active tour.
    private func applyBackgroundUpdates() {
        let status = manager.authorizationStatus
        let canBackground = status == .authorizedAlways || status == .authorizedWhenInUse
        manager.allowsBackgroundLocationUpdates = wantsBackground && canBackground
        // Show the in-use indicator rather than silently tracking.
        manager.showsBackgroundLocationIndicator = wantsBackground && canBackground
        TourDiagnostics.shared.log("auth_state", [
            "status": status.rawValue,
            "always": status == .authorizedAlways,
            "backgroundUpdates": wantsBackground && canBackground,
        ])
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        authorized = status == .authorizedWhenInUse || status == .authorizedAlways
        alwaysAuthorized = status == .authorizedAlways
        denied = status == .denied || status == .restricted

        // A tour that was started before the prompt was answered: now that we
        // hold When-In-Use, offer the existing Always authorization request.
        // The active tour can continue in the background with either grant.
        if wantsBackground, status == .authorizedWhenInUse {
            manager.requestAlwaysAuthorization()
        }
        if authorized {
            manager.startUpdatingLocation()
        }
        applyBackgroundUpdates()
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        if let last = locations.last {
            location = last
            TourDiagnostics.shared.logFix(last, extra: ["batch": locations.count])
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateHeading newHeading: CLHeading) {
        heading = newHeading
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        // Non-fatal; keep last known location.
        TourDiagnostics.shared.log("gps_error", ["error": error.localizedDescription])
    }
}
