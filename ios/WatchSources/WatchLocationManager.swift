import CoreLocation
import Combine

/// Publishes the watch's own position. Same two service levels as the phone:
/// browsing (foreground, coarse) and touring (best accuracy, background
/// delivery — the workout session keeps the process alive to receive it).
@MainActor
final class WatchLocationManager: NSObject, ObservableObject, CLLocationManagerDelegate {
    @Published var location: CLLocation?
    @Published var authorized = false
    @Published var denied = false
    @Published private(set) var isTouring = false

    private let manager = CLLocationManager()
    /// Set when startTour() ran before authorization arrived, so the delegate
    /// callback can finish enabling background updates once it does.
    private var wantsBackground = false

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
        manager.distanceFilter = 10
    }

    /// Foreground-only location, for the "nearest spot" status line.
    func startBrowsing() {
        manager.requestWhenInUseAuthorization()
        manager.startUpdatingLocation()
    }

    /// Tour ON: every fix, best accuracy — trigger radii go down to 35 m and
    /// the local trigger check runs on each fix.
    func startTour() {
        wantsBackground = true
        isTouring = true
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.distanceFilter = kCLDistanceFilterNone
        if manager.authorizationStatus == .notDetermined {
            manager.requestWhenInUseAuthorization()
        }
        manager.startUpdatingLocation()
        applyBackgroundUpdates()
    }

    func stopTour() {
        wantsBackground = false
        isTouring = false
        manager.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
        manager.distanceFilter = 10
        applyBackgroundUpdates()
    }

    /// `allowsBackgroundLocationUpdates` throws if set without authorization,
    /// so it's applied only when both hold. On watchOS, When-In-Use plus the
    /// running workout session is enough for continuous delivery.
    private func applyBackgroundUpdates() {
        let status = manager.authorizationStatus
        let can = status == .authorizedWhenInUse || status == .authorizedAlways
        manager.allowsBackgroundLocationUpdates = wantsBackground && can
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        authorized = status == .authorizedWhenInUse || status == .authorizedAlways
        denied = status == .denied || status == .restricted
        if authorized {
            manager.startUpdatingLocation()
        }
        applyBackgroundUpdates()
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        if let last = locations.last {
            location = last
        }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        // Non-fatal; keep last known location.
        print("WatchLocationManager: gps error: \(error.localizedDescription)")
    }
}
