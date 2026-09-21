import Foundation
import MapKit

/// Plans a journey: search a destination, compute a route to it on-device
/// (MKDirections — no server round-trip for routing), and hand the polyline to
/// the tour for corridor prefetch.
@MainActor
final class JourneyPlanner: ObservableObject {
    struct Destination: Identifiable {
        let id = UUID()
        let name: String
        let subtitle: String
        let coordinate: CLLocationCoordinate2D
    }

    @Published var query = ""
    @Published private(set) var results: [Destination] = []
    @Published private(set) var isSearching = false
    @Published private(set) var isRouting = false
    @Published private(set) var routeError: String?
    /// The computed route awaiting confirmation.
    @Published private(set) var plannedRoute: MKRoute?
    @Published private(set) var plannedDestination: Destination?

    func search(near center: CLLocationCoordinate2D?) async {
        let trimmed = query.trimmingCharacters(in: .whitespaces)
        guard trimmed.count >= 2 else { results = []; return }
        isSearching = true
        defer { isSearching = false }
        let req = MKLocalSearch.Request()
        req.naturalLanguageQuery = trimmed
        if let center {
            req.region = MKCoordinateRegion(
                center: center,
                span: MKCoordinateSpan(latitudeDelta: 0.3, longitudeDelta: 0.3)
            )
        }
        guard let resp = try? await MKLocalSearch(request: req).start() else {
            results = []
            return
        }
        results = resp.mapItems.map {
            Destination(
                name: $0.name ?? "Unnamed place",
                subtitle: $0.placemark.title ?? "",
                coordinate: $0.placemark.coordinate
            )
        }
    }

    /// Compute the route from the traveler's position to the picked place.
    /// The activity mode picks the transport shape; cycling/hiking fall back
    /// to walking, which follows the same paths.
    func planRoute(
        to dest: Destination,
        from origin: CLLocationCoordinate2D,
        mode: String
    ) async {
        isRouting = true
        routeError = nil
        plannedRoute = nil
        plannedDestination = nil
        defer { isRouting = false }

        let req = MKDirections.Request()
        req.source = MKMapItem(placemark: MKPlacemark(coordinate: origin))
        req.destination = MKMapItem(placemark: MKPlacemark(coordinate: dest.coordinate))
        switch mode {
        case "driving": req.transportType = .automobile
        case "transit": req.transportType = .transit
        default: req.transportType = .walking
        }

        do {
            let resp = try await MKDirections(request: req).calculate()
            guard let route = resp.routes.first else {
                routeError = "No route found."
                return
            }
            plannedRoute = route
            plannedDestination = dest
        } catch {
            routeError = "Couldn't compute a route: \(error.localizedDescription)"
        }
    }

    func reset() {
        query = ""
        results = []
        plannedRoute = nil
        plannedDestination = nil
        routeError = nil
    }

    /// The route's coordinates, decimated to the server's 500-point cap.
    /// MKPolyline for a long drive can carry thousands of points; every Nth
    /// point plus the endpoint preserves the corridor shape fine at a 300m
    /// half-width.
    static func decimated(_ polyline: MKPolyline, maxPoints: Int = 500) -> [CLLocationCoordinate2D] {
        let n = polyline.pointCount
        guard n > 0 else { return [] }
        var coords = [CLLocationCoordinate2D](
            repeating: kCLLocationCoordinate2DInvalid, count: n
        )
        polyline.getCoordinates(&coords, range: NSRange(location: 0, length: n))
        guard n > maxPoints else { return coords }
        let stride = Int((Double(n) / Double(maxPoints)).rounded(.up))
        var out: [CLLocationCoordinate2D] = []
        var i = 0
        while i < n { out.append(coords[i]); i += stride }
        if let last = coords.last,
           out.last.map({ $0.latitude != last.latitude || $0.longitude != last.longitude }) ?? true {
            out.append(last)
        }
        return out
    }
}
