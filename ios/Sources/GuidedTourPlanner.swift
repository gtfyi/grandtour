import CoreLocation
import Foundation

/// The guided-tour ("walking tour") decision core. One track, a fixed set of
/// stops, and a traveler who is *following directions* rather than passing
/// by — so the rules invert from wander mode:
///
/// - The next stop is the one to walk to, not the one ahead. Stops with an
///   authored sequence go in index order; otherwise the nearest unvisited
///   stop is next (a greedy chain that reads well on foot).
/// - Direction of travel never disqualifies a stop: the traveler will turn
///   toward it. Arrival — entering the trigger radius — is what starts it.
/// - No early lead: a stop narrates once you're standing at it.
///
/// Pure: the view model keeps the session's visited set and the spoken-cue
/// bookkeeping; this only answers "where next, how far, have we arrived?"
enum GuidedTourPlanner {
    struct Plan {
        /// The stop the traveler should head to; nil when every stop is
        /// visited (or none is in range).
        var nextStop: NearbySpot?
        /// The traveler is inside the next stop's trigger: narrate it.
        var arrived: Bool
        /// Straight-line meters to the next stop from the current fix.
        var distanceM: Double?
        /// Spoken/displayed directions ("About 200 meters to the northeast",
        /// "Coming up in 90 meters on your left"). Nil without a fix.
        var directions: String?
        /// Unvisited, eligible stops still in range, next first.
        var remaining: [NearbySpot]
    }

    /// `stops`: the guided track's point spots currently in range.
    /// `visited`: stop ids already narrated this outing.
    /// `isEligible`: the sequence gate (earlier parts heard).
    static func plan(
        stops: [NearbySpot],
        visited: Set<String>,
        location: CLLocation?,
        courseDeg: Double?,
        isEligible: (String) -> Bool = { _ in true },
        metric: Bool = true
    ) -> Plan {
        let candidates = stops.filter {
            !visited.contains($0.spot.id) && !$0.spot.trigger.isArea && $0.isNarratable
                && isEligible($0.spot.id)
        }
        let ordered = order(candidates, from: location?.coordinate)
        guard let next = ordered.first else {
            return Plan(nextStop: nil, arrived: false, distanceM: nil, directions: nil, remaining: [])
        }
        let dist = location.map { SpotScheduler.distanceM(next, from: $0.coordinate) } ?? next.distanceM
        let directions: String? = location.map { loc in
            SpotLocator.describe(
                spotLat: next.spot.trigger.center.lat,
                spotLng: next.spot.trigger.center.lng,
                userLat: loc.coordinate.latitude,
                userLng: loc.coordinate.longitude,
                courseDeg: courseDeg,
                anchor: next.spot.locating?.anchor,
                metric: metric
            )
        }
        return Plan(
            nextStop: next,
            arrived: next.triggered,
            distanceM: dist,
            directions: directions,
            remaining: ordered
        )
    }

    /// Authored order when the stops carry one sequence; otherwise nearest
    /// first. Mixed sets (some sequenced, some not) fall back to nearest —
    /// the sequence gate still holds later parts back.
    static func order(_ stops: [NearbySpot], from c: CLLocationCoordinate2D?) -> [NearbySpot] {
        let keys = Set(stops.compactMap { $0.spot.sequence?.key })
        if keys.count == 1, stops.allSatisfy({ $0.spot.sequence != nil }) {
            return stops.sorted { ($0.spot.sequence?.index ?? 0) < ($1.spot.sequence?.index ?? 0) }
        }
        return stops.sorted { a, b in
            let da = c.map { SpotScheduler.distanceM(a, from: $0) } ?? a.distanceM
            let db = c.map { SpotScheduler.distanceM(b, from: $0) } ?? b.distanceM
            return da != db ? da < db : a.spot.title < b.spot.title
        }
    }

    /// The spoken cue that sends the traveler to the next stop.
    static func cue(for stop: NearbySpot, directions: String?) -> String {
        guard let directions else { return "Next stop: \(stop.spot.title)." }
        return "Next stop: \(stop.spot.title). \(directions)"
    }

    /// The traveler has walked away from the stop since the last cue.
    static func isHeadingAway(distanceM: Double, sinceCueM: Double) -> Bool {
        distanceM > sinceCueM + headingAwayM
    }

    /// How much farther than at the last cue counts as going the wrong way.
    static let headingAwayM: Double = 40
    /// Re-cue at least this often while a stop is still ahead.
    static let reminderIntervalS: TimeInterval = 150
    /// Never nag inside this distance — they're about to trigger.
    static let noReminderWithinM: Double = 60
}
