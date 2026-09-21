import UIKit
import MapKit
import Combine

/// The CarPlay window's content: a real MKMapView that follows the car and
/// draws what the tour knows — a track-colored marker per highlight (dimmed
/// when it's a journey spot still beyond nearby range), the journey corridor
/// polyline, the previewed/active navigation route, and a pulseless circle on
/// whatever spot is narrating.
final class CarPlayMapViewController: UIViewController {
    private let mapView = MKMapView()
    private var cancellables: Set<AnyCancellable> = []

    /// Cache keyed by "spotId|dimmed" so the tour's 1.5s polls don't
    /// remove-and-re-add every marker — that flickers on the car screen.
    private var spotAnnotations: [String: SpotAnnotation] = [:]
    private var journeyLine: MKPolyline?
    private var routeLine: MKPolyline?
    /// The now-playing highlight: an MKCircle for a point spot, or an
    /// MKPolygon of the fence for an area spot (whose radiusM is a meaningless
    /// default — a circle there would look arbitrary).
    private var playingOverlay: MKOverlay?

    override func viewDidLoad() {
        super.viewDidLoad()
        mapView.frame = view.bounds
        mapView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        mapView.delegate = self
        mapView.showsUserLocation = true
        mapView.userTrackingMode = .follow
        // Apple's own POI pins would drown our highlights on a 7-inch screen.
        mapView.pointOfInterestFilter = .excludingAll
        view.addSubview(mapView)
        bind()
    }

    private func bind() {
        let tour = AppServices.shared.tour
        tour.$nearby.combineLatest(tour.$journeySpots)
            .receive(on: RunLoop.main)
            .sink { [weak self] nearby, journey in
                self?.syncSpots(nearby: nearby, journey: journey)
            }
            .store(in: &cancellables)
        tour.$journeyRoute
            .receive(on: RunLoop.main)
            .sink { [weak self] coords in self?.syncJourneyLine(coords) }
            .store(in: &cancellables)
        tour.player.$nowPlayingSpotId
            .removeDuplicates()
            .receive(on: RunLoop.main)
            .sink { [weak self] id in self?.syncPlayingCircle(id) }
            .store(in: &cancellables)
    }

    // ─── Highlights ──────────────────────────────────────────────────────────

    private func syncSpots(nearby: [NearbySpot], journey: [NearbySpot]) {
        // Nearby wins over the dimmed journey rendering of the same spot.
        var desired: [String: (spot: NearbySpot, dimmed: Bool)] = [:]
        for s in journey { desired[s.spot.id] = (s, true) }
        for s in nearby { desired[s.spot.id] = (s, false) }

        for (key, ann) in spotAnnotations where desired[ann.spotId]?.dimmed != ann.dimmed {
            mapView.removeAnnotation(ann)
            spotAnnotations.removeValue(forKey: key)
        }
        for (id, want) in desired {
            let key = "\(id)|\(want.dimmed)"
            guard spotAnnotations[key] == nil else { continue }
            let ann = SpotAnnotation(want.spot, dimmed: want.dimmed)
            spotAnnotations[key] = ann
            mapView.addAnnotation(ann)
        }
    }

    // ─── Overlays ────────────────────────────────────────────────────────────

    private func syncJourneyLine(_ coords: [CLLocationCoordinate2D]) {
        if let line = journeyLine {
            mapView.removeOverlay(line)
            journeyLine = nil
        }
        guard coords.count >= 2 else { return }
        let line = MKPolyline(coordinates: coords, count: coords.count)
        journeyLine = line
        mapView.addOverlay(line, level: .aboveRoads)
    }

    private func syncPlayingCircle(_ id: String?) {
        if let o = playingOverlay {
            mapView.removeOverlay(o)
            playingOverlay = nil
        }
        let tour = AppServices.shared.tour
        guard let id,
              let s = (tour.nearby + tour.journeySpots).first(where: { $0.spot.id == id })
        else { return }
        let trigger = s.spot.trigger
        let overlay: MKOverlay
        if trigger.isArea, let ring = trigger.region, ring.count >= 3 {
            // Draw the actual fence: the centroid+default-radius circle would
            // sit arbitrarily inside a town-sized region.
            let coords = ring.map { CLLocationCoordinate2D(latitude: $0.lat, longitude: $0.lng) }
            overlay = MKPolygon(coordinates: coords, count: coords.count)
        } else {
            overlay = MKCircle(center: s.coordinate, radius: max(trigger.radiusM, 30))
        }
        playingOverlay = overlay
        mapView.addOverlay(overlay, level: .aboveRoads)
    }

    // ─── Route drawing, called by CarPlayController ──────────────────────────

    /// Show a candidate route and frame it whole, for the trip preview panel.
    func previewRoute(_ route: MKRoute) {
        setRouteLine(route.polyline)
        mapView.setUserTrackingMode(.none, animated: false)
        mapView.setVisibleMapRect(
            route.polyline.boundingMapRect,
            edgePadding: UIEdgeInsets(top: 60, left: 60, bottom: 60, right: 60),
            animated: true
        )
    }

    /// Navigation started: keep the line, snap back to following the car.
    func showActiveRoute(_ route: MKRoute) {
        setRouteLine(route.polyline)
        mapView.setUserTrackingMode(.follow, animated: true)
    }

    func clearRoute() {
        if let line = routeLine {
            mapView.removeOverlay(line)
            routeLine = nil
        }
        mapView.setUserTrackingMode(.follow, animated: true)
    }

    private func setRouteLine(_ polyline: MKPolyline) {
        if let line = routeLine { mapView.removeOverlay(line) }
        routeLine = polyline
        mapView.addOverlay(polyline, level: .aboveRoads)
    }

    // ─── Map buttons ─────────────────────────────────────────────────────────

    func recenter() {
        mapView.setUserTrackingMode(.follow, animated: true)
    }

    func zoom(by factor: Double) {
        var region = mapView.region
        region.span.latitudeDelta = min(max(region.span.latitudeDelta * factor, 0.0005), 120)
        region.span.longitudeDelta = min(max(region.span.longitudeDelta * factor, 0.0005), 120)
        mapView.setRegion(region, animated: true)
    }
}

extension CarPlayMapViewController: MKMapViewDelegate {
    func mapView(_ mapView: MKMapView, viewFor annotation: MKAnnotation) -> MKAnnotationView? {
        guard let spot = annotation as? SpotAnnotation else { return nil } // user dot
        let reuseId = "spot"
        let view = (mapView.dequeueReusableAnnotationView(withIdentifier: reuseId) as? MKMarkerAnnotationView)
            ?? MKMarkerAnnotationView(annotation: spot, reuseIdentifier: reuseId)
        view.annotation = spot
        view.markerTintColor = spot.dimmed ? spot.color.withAlphaComponent(0.45) : spot.color
        view.glyphImage = UIImage(systemName: spot.isNarratable ? "waveform" : "mappin")
        view.displayPriority = spot.dimmed ? .defaultLow : .defaultHigh
        return view
    }

    func mapView(_ mapView: MKMapView, rendererFor overlay: MKOverlay) -> MKOverlayRenderer {
        if let line = overlay as? MKPolyline {
            let r = MKPolylineRenderer(polyline: line)
            if line === routeLine {
                r.strokeColor = .systemBlue
                r.lineWidth = 7
            } else {
                r.strokeColor = UIColor.systemTeal.withAlphaComponent(0.7)
                r.lineWidth = 5
            }
            return r
        }
        if let circle = overlay as? MKCircle {
            let r = MKCircleRenderer(circle: circle)
            r.fillColor = UIColor.systemGreen.withAlphaComponent(0.15)
            r.strokeColor = .systemGreen
            r.lineWidth = 1
            return r
        }
        if let polygon = overlay as? MKPolygon {
            let r = MKPolygonRenderer(polygon: polygon)
            r.fillColor = UIColor.systemGreen.withAlphaComponent(0.15)
            r.strokeColor = .systemGreen
            r.lineWidth = 1
            return r
        }
        return MKOverlayRenderer(overlay: overlay)
    }
}

/// A highlight marker: one spot, colored by its track.
final class SpotAnnotation: NSObject, MKAnnotation {
    let spotId: String
    let dimmed: Bool
    let color: UIColor
    let isNarratable: Bool
    let coordinate: CLLocationCoordinate2D
    let title: String?

    init(_ s: NearbySpot, dimmed: Bool) {
        spotId = s.spot.id
        self.dimmed = dimmed
        color = UIColor(hexColor: s.track.color) ?? .systemTeal
        isNarratable = s.isNarratable
        coordinate = s.coordinate
        title = s.spot.title
    }
}

extension UIColor {
    /// Parses the track palette's "#RRGGBB" strings (UIKit twin of the
    /// SwiftUI Color(hex:) used by TourMapView).
    convenience init?(hexColor: String?) {
        guard var s = hexColor?.trimmingCharacters(in: .whitespaces), !s.isEmpty else { return nil }
        if s.hasPrefix("#") { s.removeFirst() }
        guard s.count == 6, let v = UInt32(s, radix: 16) else { return nil }
        self.init(
            red: CGFloat((v >> 16) & 0xff) / 255,
            green: CGFloat((v >> 8) & 0xff) / 255,
            blue: CGFloat(v & 0xff) / 255,
            alpha: 1
        )
    }
}
