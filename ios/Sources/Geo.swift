import CoreLocation

/// The one distance the tour logic measures with, on every platform.
///
/// It is the flat-earth distance on the WGS84 ellipsoid with the meridional
/// and prime-vertical radii taken at the *observer's* latitude — which is
/// exactly what `CLLocation.distance(from:)` returns when its internal local
/// projection is fresh at the observer. CoreLocation keeps that projection
/// in a cache it re-anchors as calls come in, so the same two coordinates
/// can measure differently by ~1e-5 depending on what was asked before
/// (verified while building scripts/scheduler-parity). Scheduling wants a
/// pure function: the web app (`localDistanceM` in @grandtour/shared) is
/// this same arithmetic in the same order, so both clients decide alike.
///
/// Accuracy: within 1e-6 of a true geodesic at nearby scale (under 5 km),
/// which is all triggers and scheduling ever look at. Not for long spans.
enum Geo {
    private static let a = 6_378_137.0
    private static let f = 1 / 298.257_223_563
    private static let e2 = f * (2 - f)

    static func localDistanceM(from observer: CLLocationCoordinate2D, to target: CLLocationCoordinate2D) -> Double {
        let phi = observer.latitude * .pi / 180
        let s = sin(phi)
        let w = 1 - e2 * s * s
        let n = a / w.squareRoot()
        let m = a * (1 - e2) / (w * w.squareRoot())
        var dLng = target.longitude - observer.longitude
        if dLng > 180 { dLng -= 360 } else if dLng < -180 { dLng += 360 }
        let x = n * cos(phi) * dLng * .pi / 180
        let y = m * (target.latitude - observer.latitude) * .pi / 180
        return (x * x + y * y).squareRoot()
    }

    static func localDistanceM(from observer: CLLocationCoordinate2D, to target: LngLat) -> Double {
        localDistanceM(from: observer, to: CLLocationCoordinate2D(latitude: target.lat, longitude: target.lng))
    }
}
