import Foundation
import CoreLocation

/// A demo: one track's route travelled as a simulated trip, the same tour
/// logic playing the stories as the car reaches them — the Tracks sheet's
/// Demo button. The web app has the same feature (its Demo button and
/// `?simulate=`; packages/tour-viewer/src/simulate.ts), and the two are
/// meant to behave alike: the route is the bundle's authored `routePath`,
/// else roads through every spot (nearest first, then the OSRM demo router,
/// straight lines when it is unreachable); the pace is the explicit mode's,
/// else set by the track's size; the play history lives in memory; ending
/// the demo restores whatever the real tour had.
///
/// The geometry mirrors `cumulativeMeters`, `pointAlong` and
/// `nearestNeighborOrder` in packages/shared/src/geo.ts.
enum DemoRoute {
    private static let earthRadiusM = 6_371_000.0

    static func haversineM(_ a: CLLocationCoordinate2D, _ b: CLLocationCoordinate2D) -> Double {
        let dLat = (b.latitude - a.latitude) * .pi / 180
        let dLng = (b.longitude - a.longitude) * .pi / 180
        let s = sin(dLat / 2) * sin(dLat / 2)
            + cos(a.latitude * .pi / 180) * cos(b.latitude * .pi / 180) * sin(dLng / 2) * sin(dLng / 2)
        return 2 * earthRadiusM * asin(min(1, s.squareRoot()))
    }

    static func bearingDeg(_ a: CLLocationCoordinate2D, _ b: CLLocationCoordinate2D) -> Double {
        let dLng = (b.longitude - a.longitude) * .pi / 180
        let lat1 = a.latitude * .pi / 180
        let lat2 = b.latitude * .pi / 180
        let y = sin(dLng) * cos(lat2)
        let x = cos(lat1) * sin(lat2) - sin(lat1) * cos(lat2) * cos(dLng)
        let deg = atan2(y, x) * 180 / .pi
        return (deg + 360).truncatingRemainder(dividingBy: 360)
    }

    /// Cumulative length in meters, one entry per vertex (the first is 0).
    static func cumulativeMeters(_ path: [CLLocationCoordinate2D]) -> [Double] {
        guard !path.isEmpty else { return [] }
        var out = [0.0]
        out.reserveCapacity(path.count)
        for i in 1..<path.count { out.append(out[i - 1] + haversineM(path[i - 1], path[i])) }
        return out
    }

    /// The point `distanceM` along the path and the heading of its segment; clamped to the ends.
    static func point(
        along path: [CLLocationCoordinate2D], cumulativeM: [Double], distanceM: Double
    ) -> (coordinate: CLLocationCoordinate2D, headingDeg: Double) {
        guard let first = path.first else { return (CLLocationCoordinate2D(latitude: 0, longitude: 0), 0) }
        guard path.count > 1, let total = cumulativeM.last else { return (first, 0) }
        let d = max(0, min(distanceM, total))
        var i = 1
        while i < cumulativeM.count && cumulativeM[i] < d { i += 1 }
        i = min(i, path.count - 1)
        let start = path[i - 1]
        let end = path[i]
        let segment = cumulativeM[i] - cumulativeM[i - 1]
        let t = segment > 0 ? (d - cumulativeM[i - 1]) / segment : 0
        let coordinate = CLLocationCoordinate2D(
            latitude: start.latitude + (end.latitude - start.latitude) * t,
            longitude: start.longitude + (end.longitude - start.longitude) * t
        )
        return (coordinate, bearingDeg(start, end))
    }

    /// Visit every point from the first, hopping to the nearest unvisited one. Indices into the input.
    static func nearestNeighborOrder(_ points: [CLLocationCoordinate2D]) -> [Int] {
        guard points.count > 2 else { return Array(points.indices) }
        var order = [0]
        var seen: Set<Int> = [0]
        while order.count < points.count {
            let from = points[order[order.count - 1]]
            var best = -1
            var bestD = Double.infinity
            for i in points.indices where !seen.contains(i) {
                let d = haversineM(from, points[i])
                if d < bestD {
                    bestD = d
                    best = i
                }
            }
            order.append(best)
            seen.insert(best)
        }
        return order
    }

    /// Rough diameter of a set of points, in km: the diagonal of their box.
    static func spanKm(of points: [CLLocationCoordinate2D]) -> Double {
        guard let first = points.first else { return 0 }
        var minLat = first.latitude, maxLat = first.latitude
        var minLng = first.longitude, maxLng = first.longitude
        for p in points {
            minLat = min(minLat, p.latitude); maxLat = max(maxLat, p.latitude)
            minLng = min(minLng, p.longitude); maxLng = max(maxLng, p.longitude)
        }
        return haversineM(
            CLLocationCoordinate2D(latitude: minLat, longitude: minLng),
            CLLocationCoordinate2D(latitude: maxLat, longitude: maxLng)
        ) / 1_000
    }

    /// The pace a demo travels at, in mph: the explicit mode's, else by the
    /// track's size — a village tour is walked, a park road is driven.
    /// Mirrors `demoPace` on the web.
    static func pace(spanKm: Double, preference: String) -> Double {
        switch preference {
        case "walking", "hiking": return 3
        case "cycling": return 10
        case "driving", "transit": return 25
        default: return spanKm < 3 ? 3 : 25
        }
    }

    /// The activity mode a pace implies: the detector's own line (7 m/s
    /// sustained), with a declared pace needing no window to infer it over.
    static func mode(forMph mph: Double) -> String {
        mph * 0.44704 >= 7 ? "driving" : "walking"
    }

    // ─── Stops, and the driver ───────────────────────────────────────────────

    /// Seconds of travel the car is put before a stop, so it is seen arriving.
    static let leadS: TimeInterval = 8
    static func leadM(mph: Double) -> Double { max(15, mph * 0.44704 * leadS) }

    /// Every narratable spot as a stop on the route, in travel order: the
    /// distance along the route where it comes closest. (The web app's
    /// `planNarrationStops` cuts at trigger boundaries instead; for a route
    /// that passes through its spots the two agree closely enough.)
    static func stops(for spots: [NearbySpot], along route: [CLLocationCoordinate2D], cumulativeM: [Double]) -> [DemoStop] {
        guard route.count >= 2, cumulativeM.count == route.count else { return [] }
        var out: [DemoStop] = []
        for s in spots where s.isNarratable {
            let anchor = CLLocationCoordinate2D(latitude: s.spot.trigger.center.lat, longitude: s.spot.trigger.center.lng)
            let scale = cos(anchor.latitude * .pi / 180)
            var best = (distance: Double.infinity, alongM: 0.0)
            for i in 1..<route.count {
                let a = route[i - 1], b = route[i]
                let length = cumulativeM[i] - cumulativeM[i - 1]
                if length == 0 { continue }
                let dx = (b.longitude - a.longitude) * scale, dy = b.latitude - a.latitude
                let along = ((anchor.longitude - a.longitude) * scale) * dx + (anchor.latitude - a.latitude) * dy
                let fraction = max(0, min(1, along / (dx * dx + dy * dy)))
                let projected = CLLocationCoordinate2D(
                    latitude: a.latitude + dy * fraction,
                    longitude: a.longitude + (b.longitude - a.longitude) * fraction
                )
                let distance = haversineM(anchor, projected)
                if distance < best.distance { best = (distance, cumulativeM[i - 1] + length * fraction) }
            }
            out.append(DemoStop(spot: s, distanceM: best.alongM))
        }
        return out.sorted { $0.distanceM != $1.distanceM ? $0.distanceM < $1.distanceM : $0.spot.spot.title < $1.spot.spot.title }
    }

    /// What the demo's car does next. A demo is the stories, not the miles
    /// between them: while a story plays the car keeps its pace but never
    /// drives past the next stop — it waits there; once the player is idle
    /// for the story spacing, the car jumps to just before the next unheard
    /// stop, drives in, and the stop is played if the scheduler did not start
    /// it on the way; after the last stop it parks at the end of the route.
    /// Line for line `demoStep` in packages/tour-viewer/src/simulate.ts.
    static func step(
        item: Bool, playing: Bool, moving: Bool, distanceM: Double, totalM: Double,
        nextM: Double?, idleS: TimeInterval?, gapS: TimeInterval, leadM: Double
    ) -> DemoStep {
        if item {
            if let nextM, distanceM >= nextM { return moving ? .park : .none }
            if playing, !moving, distanceM < totalM { return .resume }
            return .none
        }
        guard let idleS, idleS >= gapS else { return .none }
        guard let nextM else { return distanceM < totalM ? .finish : .none }
        let approach = nextM - leadM
        if distanceM < approach { return .seek(approach) }
        if distanceM < nextM { return moving ? .none : .resume }
        return .play
    }

    // ─── Planning ────────────────────────────────────────────────────────────

    /// Road geometry through the ordered anchors from the public OSRM demo
    /// router — the same server the web app asks, no key, rate-limited —
    /// or nil when it has nothing within 8 seconds.
    static func osrmRoute(through anchors: [CLLocationCoordinate2D], session: URLSession = .shared) async -> [CLLocationCoordinate2D]? {
        let coords = anchors.map { "\($0.longitude),\($0.latitude)" }.joined(separator: ";")
        guard let url = URL(string: "https://router.project-osrm.org/route/v1/driving/\(coords)?overview=full&geometries=geojson") else { return nil }
        var request = URLRequest(url: url)
        request.timeoutInterval = 8
        guard let (data, response) = try? await session.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        struct Reply: Decodable {
            struct Route: Decodable {
                struct Geometry: Decodable { let coordinates: [[Double]] }
                let geometry: Geometry?
            }
            let routes: [Route]?
        }
        guard let reply = try? JSONDecoder().decode(Reply.self, from: data),
              let line = reply.routes?.first?.geometry?.coordinates, line.count >= 2 else { return nil }
        return line.compactMap { $0.count >= 2 ? CLLocationCoordinate2D(latitude: $0[1], longitude: $0[0]) : nil }
    }

    /// The route a demo of this bundle follows: the authored `routePath`,
    /// else roads through every spot, else straight lines between them.
    /// Fewer than two points means there is nothing to drive.
    static func plan(
        for bundle: TrackDownloadBundle,
        router: ([CLLocationCoordinate2D]) async -> [CLLocationCoordinate2D]? = { await DemoRoute.osrmRoute(through: $0) }
    ) async -> [CLLocationCoordinate2D] {
        if let authored = bundle.routePath, authored.count >= 2 {
            return authored.map { CLLocationCoordinate2D(latitude: $0.lat, longitude: $0.lng) }
        }
        let anchors = bundle.spots.map {
            CLLocationCoordinate2D(latitude: $0.spot.trigger.center.lat, longitude: $0.spot.trigger.center.lng)
        }
        guard anchors.count >= 2 else { return anchors }
        let ordered = nearestNeighborOrder(anchors).map { anchors[$0] }
        if let roads = await router(ordered) { return roads }
        return ordered
    }
}

/// A stop on a demo's route: a narratable spot and where along the route the car reaches it.
struct DemoStop {
    let spot: NearbySpot
    let distanceM: Double
}

/// What the driver does on a tick (`DemoRoute.step`).
enum DemoStep: Equatable {
    case none, park, resume, play, finish
    case seek(Double)
}

/// The car: a position along the route advancing at the pace, one synthetic
/// fix per second while moving — the cadence GPS delivers — handed to the
/// tour exactly as a real fix would be.
@MainActor
final class DemoDrive {
    let track: Track
    let route: [CLLocationCoordinate2D]
    let cumulativeM: [Double]
    let totalM: Double
    let mph: Double
    /// The route's stops in travel order.
    let stops: [DemoStop]
    private(set) var distanceM: Double = 0
    private(set) var isMoving = false
    /// Every fix, including the one `start()` sends at once.
    var onFix: ((CLLocation) -> Void)?
    private let now: () -> Date
    private var timer: Timer?
    private var lastTick: Date?

    init(track: Track, route: [CLLocationCoordinate2D], spots: [NearbySpot] = [], mph: Double, now: @escaping () -> Date = Date.init) {
        self.track = track
        self.route = route
        self.mph = mph
        self.now = now
        cumulativeM = DemoRoute.cumulativeMeters(route)
        totalM = cumulativeM.last ?? 0
        stops = DemoRoute.stops(for: spots, along: route, cumulativeM: cumulativeM)
    }

    /// The next stop at or beyond `distanceM` that may still play.
    func nextStop(after distanceM: Double, available: (NearbySpot) -> Bool) -> DemoStop? {
        stops.first { $0.distanceM >= distanceM && available($0.spot) }
    }

    /// Move the car along the route at once — the demo jumping ahead. A fix follows.
    func seek(to distance: Double) {
        distanceM = max(0, min(distance, totalM))
        lastTick = now()
        onFix?(fix())
    }

    var atEnd: Bool { totalM > 0 && distanceM >= totalM }
    /// Ground speed as a fix reports it: the pace while moving, 0 parked.
    var speedMps: Double { isMoving ? mph * 0.44704 : 0 }

    /// Where the car is, as a fix: course along its segment, the pace as speed.
    func fix(at date: Date? = nil) -> CLLocation {
        let p = DemoRoute.point(along: route, cumulativeM: cumulativeM, distanceM: distanceM)
        return CLLocation(
            coordinate: p.coordinate, altitude: 0, horizontalAccuracy: 5, verticalAccuracy: -1,
            course: p.headingDeg, speed: speedMps, timestamp: date ?? now()
        )
    }

    /// Set off — from the beginning again once the route was driven to its end.
    func start() {
        if atEnd { distanceM = 0 }
        guard !isMoving else { return }
        isMoving = true
        lastTick = now()
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
        onFix?(fix())
    }

    func pause() {
        isMoving = false
        lastTick = nil
        timer?.invalidate()
        timer = nil
    }

    /// Advance by the time since the last tick. The timer calls this every
    /// second; tests call it against a virtual clock.
    func tick() {
        guard isMoving else { return }
        let at = now()
        let dt = lastTick.map { at.timeIntervalSince($0) } ?? 0
        lastTick = at
        distanceM = min(totalM, distanceM + mph * 0.44704 * max(0, dt))
        if atEnd { pause() } // the car parks at the end of the route
        onFix?(fix(at: at))
    }
}
