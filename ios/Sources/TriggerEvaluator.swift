import CoreLocation
import Foundation

/// On-device trigger math, shared by every place that must decide "am I in
/// this spot?" without asking the server: the phone's `unchanged`-poll
/// re-evaluation, the offline cache rebuild, and the watch's per-fix check
/// between (much sparser) network polls.
///
/// The server invariant is that PostGIS owns geo math — on-device evaluation
/// is the one place that can't hold. We lean on CoreLocation's geodesic
/// `distance(from:)` rather than hand-rolling haversine, plus a small
/// ray-cast for region polygons.
enum TriggerEvaluator {
    /// Recompute `triggered` and `distanceM` for a held nearby list from a
    /// fresh fix. Everything else — locating included — is kept as last
    /// resolved: a course-specific side can go stale, but that beats
    /// dropping "where to look" for everyone standing still.
    ///
    /// Kind-aware, mirroring the server: a `point` spot triggers within its
    /// radius (or inside its precise boundary); an `area` spot triggers only
    /// by fence containment — its center is a map anchor, never a trigger,
    /// and its distance is 0 while inside (matching the server's
    /// distance-to-fence, so ambient spots never read as "far away").
    static func reevaluate(_ spots: [NearbySpot], at loc: CLLocation) -> [NearbySpot] {
        spots.map { s in
            let (triggered, d) = evaluate(s.spot.trigger, at: loc)
            return NearbySpot(
                spot: s.spot,
                track: s.track,
                locating: s.locating,
                distanceM: d,
                triggered: triggered,
                content: s.content,
                guide: s.guide
            )
        }
    }

    /// The single on-device in/out + distance decision for one trigger — the
    /// client-side mirror of `findNearby`'s SQL. Everything that evaluates
    /// triggers locally (reevaluate, the offline cache rebuild, the watch)
    /// goes through here.
    static func evaluate(
        _ trigger: GeoTrigger, at loc: CLLocation
    ) -> (triggered: Bool, distanceM: Double) {
        let centerD = Geo.localDistanceM(from: loc.coordinate, to: trigger.center)
        if trigger.isArea {
            // Containment only — the centroid is a map anchor, not a trigger.
            // Outside the fence the centroid is all we can measure to: an
            // overestimate, but it's display/pruning data, and inside reads 0
            // like the server's distance-to-fence.
            let insideFence = inside(loc.coordinate, ring: trigger.region)
            return (insideFence, insideFence ? 0 : centerD)
        }
        let triggered = centerD <= trigger.radiusM
            || inside(loc.coordinate, ring: trigger.region)
        return (triggered, centerD)
    }

    /// Approximate area (m²) of a lat/lng ring — shoelace with a cosine
    /// latitude correction, fine at town scale. The gap planner uses it to
    /// prefer the most specific ambient fence (a neighborhood over a county).
    static func approxAreaM2(ring: [LngLat]?) -> Double {
        guard let ring, ring.count >= 3 else { return .infinity }
        let mPerDegLat = 111_320.0
        let midLat = ring.reduce(0.0) { $0 + $1.lat } / Double(ring.count)
        let mPerDegLng = mPerDegLat * cos(midLat * .pi / 180)
        var sum = 0.0
        for i in 0..<ring.count {
            let p = ring[i], q = ring[(i + 1) % ring.count]
            sum += (p.lng * mPerDegLng) * (q.lat * mPerDegLat)
                 - (q.lng * mPerDegLng) * (p.lat * mPerDegLat)
        }
        return abs(sum) / 2
    }

    /// Ray-cast point-in-polygon over a lat/lng ring. Fine at spot scales.
    static func inside(_ p: CLLocationCoordinate2D, ring: [LngLat]?) -> Bool {
        guard let ring, ring.count >= 3 else { return false }
        var hit = false
        var j = ring.count - 1
        for i in 0..<ring.count {
            let a = ring[i], b = ring[j]
            if (a.lat > p.latitude) != (b.lat > p.latitude),
               p.longitude < (b.lng - a.lng) * (p.latitude - a.lat) / (b.lat - a.lat) + a.lng {
                hit.toggle()
            }
            j = i
        }
        return hit
    }
}
