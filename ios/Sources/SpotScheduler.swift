import CoreLocation
import Foundation

/// The wander-mode decision core: given where the traveler is, where they're
/// heading, and how long the player stays busy, name the ONE spot the tour is
/// heading for (`Plan.target` — what "Up next" shows) and, when the player is
/// idle, what to start right now (`Plan.playNow`).
///
/// There is no queue and no pool. Every decision is recomputed from scratch
/// against a *predicted* position — where the traveler will be when the
/// player is next free — so a spot they will have passed by then is never
/// promised after leaving its trigger. Two rules shape everything:
///
/// 1. **Arrival takes priority.** An unheard point inside its authored trigger
///    plays before a farther target. Passing its center does not discard it
///    while the traveler is still inside. Outside the trigger, early starts
///    still require an approach toward the spot.
/// 2. **Unheard beats everything.** The target is the least-played eligible
///    spot ahead — a never-heard story on a lower-ranked track beats a heard
///    one on a preferred track; track preference orders equally-fresh spots,
///    and distance only breaks ties. Played spots still get their turn as *fillers* — but only
///    when their narration fits before the target's start window opens, so
///    they never cost an unheard story.
///
/// Pure: no clocks, no audio, no networking. A simulated journey drives it
/// deterministically in tests (SpotSchedulerTests / JourneySimulator).
final class SpotScheduler {
    /// Everything a decision depends on, snapshotted by the caller. The
    /// scheduler never reaches out for state, which is what keeps it
    /// simulable.
    struct Context {
        var location: CLLocation?
        var courseDeg: Double?
        var mode: String
        var journeyRoute: [CLLocationCoordinate2D]
        /// Preferred track slugs in order (Tracks sheet, drag to reorder).
        var trackOrder: [String]
        var trackIdToSlug: [String: String]
        /// The decision's "now" — injected, so simulated journeys can advance
        /// a virtual clock instead of waiting out real cooldowns.
        var now: Date
        /// Play-history lookups (backed by PlayHistory in the app; the
        /// scheduler only ever reads). Defaults say "never played".
        var lastPlayedAt: (String) -> Date?
        var playCount: (String) -> Int
        /// Sequence gate: false while earlier parts of the spot's story are
        /// unheard. Such a spot can't be the target yet; it becomes one the
        /// moment its predecessor plays.
        var isEligible: (String) -> Bool
        /// Series-track membership: a played unit never auto-replays (the
        /// cooldown never expires for it). Evergreen tracks keep the plain
        /// cooldown.
        var neverReplays: (String) -> Bool
        /// Seconds until the player is free — 0 when idle. The prediction
        /// horizon: the target is chosen from where the traveler will be
        /// THEN, not now.
        var busyForS: TimeInterval
        /// What's playing, so it never competes with itself.
        var nowPlayingId: String?
        /// How long a spot's narration runs (intro included), for the lead
        /// window and the "does this filler fit" test.
        var durationS: (NearbySpot) -> TimeInterval

        init(
            location: CLLocation? = nil,
            courseDeg: Double? = nil,
            mode: String = "walking",
            journeyRoute: [CLLocationCoordinate2D] = [],
            trackOrder: [String] = [],
            trackIdToSlug: [String: String] = [:],
            now: Date = Date(),
            lastPlayedAt: @escaping (String) -> Date? = { _ in nil },
            playCount: @escaping (String) -> Int = { _ in 0 },
            isEligible: @escaping (String) -> Bool = { _ in true },
            neverReplays: @escaping (String) -> Bool = { _ in false },
            busyForS: TimeInterval = 0,
            nowPlayingId: String? = nil,
            durationS: @escaping (NearbySpot) -> TimeInterval = { NarrationDuration.seconds(for: $0) }
        ) {
            self.location = location
            self.courseDeg = courseDeg
            self.mode = mode
            self.journeyRoute = journeyRoute
            self.trackOrder = trackOrder
            self.trackIdToSlug = trackIdToSlug
            self.now = now
            self.lastPlayedAt = lastPlayedAt
            self.playCount = playCount
            self.isEligible = isEligible
            self.neverReplays = neverReplays
            self.busyForS = busyForS
            self.nowPlayingId = nowPlayingId
            self.durationS = durationS
        }
    }

    /// Where the traveler will be when the player is next free.
    struct Prediction {
        let coordinate: CLLocationCoordinate2D
        /// Heading at that point (route bearing on a journey, else the
        /// current course); nil when direction is unknown.
        let courseDeg: Double?
        /// nil = stationary (or no usable fix): nothing is dead-reckoned and
        /// no lead window opens early.
        let speedMps: Double?
    }

    /// One decision. Recomputed at every poll and every player-idle moment.
    struct Plan {
        /// The spot the tour is heading for: least-played eligible spot ahead
        /// of the predicted position. What "Up next" displays and what plays
        /// when its start window opens. Nil: nothing eligible ahead.
        var target: NearbySpot?
        /// Seconds until the target's start window opens; 0 = open now. Nil
        /// when unknowable (no target, or direction/speed unknown).
        var targetOpensInS: TimeInterval?
        /// What to start now, if the player is idle: the target when its
        /// window is open, else a filler whose narration fits before the
        /// target's window. Nil: silence (the gap planner may fill it).
        var playNow: NearbySpot?
        /// How long gap content may run without delaying the target. Nil =
        /// unbounded (no target, or its ETA is unknowable).
        var gapBudgetS: TimeInterval?
        var prediction: Prediction?
    }

    /// Diagnostics hook; the view model routes this into TourDiagnostics.
    var log: (String, [String: Any]) -> Void = { _, _ in }
    /// For change-only logging of the target.
    private var lastTargetId: String?

    /// A spot heard this recently doesn't auto-play again — silence (or a
    /// fill-in) beats reopening with the story from a few hours ago. Long
    /// enough to cover a lunch loop or an errand doubling back; short enough
    /// that tomorrow's commute can revisit a favorite. Beyond the cooldown a
    /// played spot is eligible again, but `freshnessRank` keeps it behind
    /// anything never heard. Manual taps bypass the scheduler entirely, so
    /// asking for a story always plays it.
    static let replayCooldownS: TimeInterval = 6 * 3600

    /// "Right here": within this of the spot's coordinates, ahead/behind is
    /// meaningless (GPS jitter alone spans it) and the spot still counts as
    /// in front. Matches SpotLocator's "Right here" threshold.
    static let hereM: Double = 15

    /// Narration may start this long before the traveler reaches the spot,
    /// so a story ends about as they arrive rather than starting as they
    /// leave. The lead is the narration length, capped here — a three-minute
    /// story still shouldn't open three minutes early.
    static let maxLeadS: TimeInterval = 60
    /// Slack on the lead so the closing words land a beat after arrival.
    static let arriveMarginS: TimeInterval = 5
    /// An early (pre-radius) start also requires the traveler's straight
    /// path to actually pass through the trigger — within the radius plus
    /// this much lateral slack. Otherwise only entering the radius starts it.
    static let laneSlackM: Double = 10
    /// A filler must end this long before the target's window opens.
    static let fillerMarginS: TimeInterval = 8

    // ─── The decision ────────────────────────────────────────────────────────

    func plan(nearby: [NearbySpot], ctx: Context) -> Plan {
        let eligible = nearby.filter { isEligible($0, ctx: ctx) }
        let pred = prediction(ctx: ctx)
        let from = pred?.coordinate
        let ahead: [NearbySpot]
        if let from {
            ahead = eligible.filter {
                isAhead($0, from: from, courseDeg: pred?.courseDeg)
                    && isOnApproach($0, from: from, courseDeg: pred?.courseDeg)
            }
        } else {
            ahead = eligible
        }
        // Do not reserve silence for a preferred story farther away while
        // an unheard story at the current location is about to be missed.
        // While busy, retain prediction instead of promising today's trigger
        // at a future position where it may no longer be relevant.
        let arrived = ctx.busyForS <= 0
            ? eligible.filter { $0.triggered && ctx.playCount($0.spot.id) == 0 }
            : []
        let target = ranked(arrived, from: from, ctx: ctx).first
            ?? ranked(ahead, from: from, ctx: ctx).first
        logTargetChange(target, nearby: nearby, ctx: ctx)

        let opens = target.flatMap { opensInS($0, ctx: ctx) }
        var playNow: NearbySpot?
        var budget: TimeInterval? = opens
        if ctx.busyForS <= 0 {
            if let t = target, isStartable(t, ctx: ctx) {
                playNow = t
                budget = 0
            } else {
                let fillers = eligible.filter {
                    isStartable($0, ctx: ctx) && fits(duration: ctx.durationS($0), budget: budget)
                }
                playNow = ranked(fillers, from: from, ctx: ctx).first
            }
        }
        return Plan(
            target: target,
            targetOpensInS: opens,
            playNow: playNow,
            gapBudgetS: budget,
            prediction: pred
        )
    }

    /// Does something `duration` long fit in the gap before the target opens?
    func fits(duration: TimeInterval, budget: TimeInterval?) -> Bool {
        guard let budget else { return true }
        return duration + Self.fillerMarginS <= budget
    }

    // ─── Eligibility ─────────────────────────────────────────────────────────

    /// Could this spot honestly auto-play at all (geometry aside)? Point
    /// kind, narratable, not what's playing, sequence-released, and not
    /// replay-blocked.
    func isEligible(_ s: NearbySpot, ctx: Context) -> Bool {
        guard !s.spot.trigger.isArea, s.content != nil, s.isNarratable,
              s.spot.id != ctx.nowPlayingId,
              ctx.isEligible(s.spot.id) else { return false }
        if let last = ctx.lastPlayedAt(s.spot.id) {
            if ctx.neverReplays(s.spot.id) { return false }
            if ctx.now.timeIntervalSince(last) < Self.replayCooldownS { return false }
        }
        return true
    }

    /// In front of the traveler: the spot's own coordinates lie ahead along
    /// the course, or within `hereM`. Unknown course: can't tell, so yes.
    func isAhead(_ s: NearbySpot, from c: CLLocationCoordinate2D, courseDeg: Double?) -> Bool {
        guard let course = courseDeg else { return true }
        if Self.distanceM(s, from: c) <= Self.hereM { return true }
        return Self.alongCross(s, from: c, courseDeg: course).along > 0
    }

    /// Don't reserve airtime for a place on a parallel street. Reconsider it
    /// when the course changes; without a course we cannot exclude it.
    func isOnApproach(_ s: NearbySpot, from c: CLLocationCoordinate2D, courseDeg: Double?) -> Bool {
        if TriggerEvaluator.inside(c, ring: s.spot.trigger.region) { return true }
        guard let course = courseDeg else { return true }
        return abs(Self.alongCross(s, from: c, courseDeg: course).cross)
            <= s.spot.trigger.radiusM + Self.laneSlackM
    }

    /// Lead window in seconds for this spot: start when it's this far ahead
    /// (in time), so narration wraps up about on arrival.
    func leadS(_ s: NearbySpot, ctx: Context) -> TimeInterval {
        min(ctx.durationS(s), Self.maxLeadS) + Self.arriveMarginS
    }

    /// Arrival remains valid throughout the authored trigger, including just
    /// beyond its center. Only an early start outside the trigger needs an
    /// ahead-of-travel check.
    func isStartable(_ s: NearbySpot, ctx: Context) -> Bool {
        if s.triggered { return true }
        guard let loc = ctx.location else { return false }
        let c = loc.coordinate
        guard isAhead(s, from: c, courseDeg: ctx.courseDeg) else { return false }
        guard let course = ctx.courseDeg, let speed = movingSpeed(ctx) else { return false }
        let (along, cross) = Self.alongCross(s, from: c, courseDeg: course)
        guard along > 0, abs(cross) <= s.spot.trigger.radiusM + Self.laneSlackM else { return false }
        return along / speed <= leadS(s, ctx: ctx)
    }

    /// Seconds until `isStartable` would turn true on the current heading.
    /// Nil when unknowable (no fix, no course, standing still, or the spot is
    /// not ahead).
    func opensInS(_ s: NearbySpot, ctx: Context) -> TimeInterval? {
        if isStartable(s, ctx: ctx) { return 0 }
        guard let loc = ctx.location, let course = ctx.courseDeg,
              let speed = movingSpeed(ctx) else { return nil }
        let (along, cross) = Self.alongCross(s, from: loc.coordinate, courseDeg: course)
        guard along > 0, abs(cross) <= s.spot.trigger.radiusM + Self.laneSlackM else { return nil }
        // The circle opens at its intersection with the travel line, not
        // radius meters before its center when the spot is off to the side.
        let radiusEntryM = sqrt(max(0, pow(s.spot.trigger.radiusM, 2) - pow(cross, 2)))
        let startAlongM = max(radiusEntryM, speed * leadS(s, ctx: ctx))
        return max(0, (along - startAlongM) / speed)
    }

    // ─── Ranking ─────────────────────────────────────────────────────────────

    /// Best-first: freshness (never heard first, then day-sized recency
    /// tiers), then preferred track, then play count, then distance from
    /// the predicted position. Freshness outranks preference on purpose: a
    /// never-heard story from any track beats a heard one from the favorite.
    /// Distance is only ever the tie-breaker — the objective is the most
    /// unheard stories over the journey, not the nearest one now.
    func ranked(_ spots: [NearbySpot], from c: CLLocationCoordinate2D?, ctx: Context) -> [NearbySpot] {
        spots.sorted { a, b in
            let fa = freshnessRank(a, ctx: ctx), fb = freshnessRank(b, ctx: ctx)
            if fa != fb { return fa < fb }
            let ra = trackRank(a, ctx: ctx), rb = trackRank(b, ctx: ctx)
            if ra != rb { return ra < rb }
            let ca = ctx.playCount(a.spot.id), cb = ctx.playCount(b.spot.id)
            if ca != cb { return ca < cb }
            return distanceM(a, from: c) < distanceM(b, from: c)
        }
    }

    /// Coarse recency tier, lower = fresher experience: 0 = never played;
    /// otherwise counts down day by day from 31 (played today) to 1 (played
    /// a month or more ago). Day-sized buckets on purpose: between two spots
    /// last heard the same day — or both long ago — which one is coming up
    /// ahead matters more than a few hours' difference in memory, so the
    /// geometry keeps the final say within a tier.
    func freshnessRank(_ s: NearbySpot, ctx: Context) -> Int {
        guard let last = ctx.lastPlayedAt(s.spot.id) else { return 0 }
        let days = Int(ctx.now.timeIntervalSince(last) / 86_400)
        return max(1, 31 - min(days, 30))
    }

    /// Position in the user's optional track ordering. Unlisted tracks — and
    /// every track, when no order is set — rank equal.
    func trackRank(_ s: NearbySpot, ctx: Context) -> Int {
        guard !ctx.trackOrder.isEmpty,
              let slug = ctx.trackIdToSlug[s.spot.trackId],
              let i = ctx.trackOrder.firstIndex(of: slug) else { return Int.max }
        return i
    }

    // ─── Prediction ──────────────────────────────────────────────────────────

    /// Where the traveler will be when the player is free: along the journey
    /// route when one is active, else dead-reckoned from course and speed,
    /// else right here. Idle player ⇒ here, now.
    func prediction(ctx: Context) -> Prediction? {
        guard let loc = ctx.location else { return nil }
        let speed = movingSpeed(ctx)
        guard ctx.busyForS > 0, let speed else {
            return Prediction(coordinate: loc.coordinate, courseDeg: ctx.courseDeg, speedMps: speed)
        }
        let aheadM = speed * ctx.busyForS
        if ctx.journeyRoute.count > 1,
           let onRoute = Self.pointAlongRoute(from: loc.coordinate, aheadM: aheadM, route: ctx.journeyRoute) {
            return Prediction(coordinate: onRoute.coordinate, courseDeg: onRoute.bearingDeg, speedMps: speed)
        }
        guard let course = ctx.courseDeg else {
            return Prediction(coordinate: loc.coordinate, courseDeg: nil, speedMps: speed)
        }
        return Prediction(
            coordinate: Self.project(loc.coordinate, meters: aheadM, bearingDeg: course),
            courseDeg: course,
            speedMps: speed
        )
    }

    /// Speed to reckon with: the GPS speed when it's a real moving figure;
    /// the mode's typical speed when the fix has none (invalid); nil when the
    /// fix says the traveler is standing still — then nothing is projected
    /// and no lead window opens early (a red light must not start a story
    /// meant for 500 m down the road).
    func movingSpeed(_ ctx: Context) -> Double? {
        guard let loc = ctx.location else { return nil }
        if loc.speed < 0 { return Self.assumedSpeedMps(mode: ctx.mode) }
        return loc.speed >= Self.stationaryBelowMps ? loc.speed : nil
    }

    /// A valid GPS speed under this counts as standing still.
    static let stationaryBelowMps: Double = 0.3

    /// Typical speeds when GPS reports none (poor fix, simulator).
    static func assumedSpeedMps(mode: String) -> Double {
        switch mode {
        case "driving": 12
        case "cycling": 4.5
        case "transit": 10
        case "boating": 5
        case "aviation": 60
        case "museum": 0.5
        default: 1.4 // walking, hiking
        }
    }

    // ─── Geometry ────────────────────────────────────────────────────────────

    func distanceM(_ s: NearbySpot, from c: CLLocationCoordinate2D?) -> Double {
        guard let c else { return s.distanceM }
        return Self.distanceM(s, from: c)
    }

    static func distanceM(_ s: NearbySpot, from c: CLLocationCoordinate2D) -> Double {
        Geo.localDistanceM(from: c, to: s.spot.trigger.center)
    }

    /// The traveler→spot vector decomposed on the course: `along` positive =
    /// ahead, negative = behind; `cross` positive = right of the line of
    /// travel.
    static func alongCross(
        _ s: NearbySpot, from c: CLLocationCoordinate2D, courseDeg: Double
    ) -> (along: Double, cross: Double) {
        let d = distanceM(s, from: c)
        let bearing = bearingDeg(
            from: c,
            to: CLLocationCoordinate2D(latitude: s.spot.trigger.center.lat, longitude: s.spot.trigger.center.lng)
        )
        let delta = (bearing - courseDeg) * .pi / 180
        return (d * cos(delta), d * sin(delta))
    }

    /// Signed along-course distance from the current fix, for diagnostics
    /// and tests. Nil without a course.
    func alongCourseM(_ s: NearbySpot, ctx: Context) -> Double? {
        guard let loc = ctx.location, let course = ctx.courseDeg else { return nil }
        return Self.alongCross(s, from: loc.coordinate, courseDeg: course).along
    }

    /// Advance along the journey polyline: project the traveler onto the
    /// nearest segment, then walk `aheadM` meters of route forward. Returns
    /// where that lands and the bearing there. Nil when the traveler is more
    /// than 500 m off the route (a detour): it no longer predicts.
    static func pointAlongRoute(
        from pos: CLLocationCoordinate2D, aheadM: Double, route: [CLLocationCoordinate2D]
    ) -> (coordinate: CLLocationCoordinate2D, bearingDeg: Double)? {
        guard route.count > 1 else { return nil }
        // Nearest segment by perpendicular projection (equirectangular is
        // fine at route scales).
        var bestIdx = 0
        var bestDist = Double.greatestFiniteMagnitude
        var bestPoint = route[0]
        for i in 0..<(route.count - 1) {
            let (p, d) = projectOntoSegment(pos, route[i], route[i + 1])
            if d < bestDist { bestDist = d; bestIdx = i; bestPoint = p }
        }
        guard bestDist < 500 else { return nil }
        var remaining = aheadM
        var i = bestIdx
        var a = bestPoint
        while i + 1 < route.count {
            let b = route[i + 1]
            let seg = Geo.localDistanceM(from: a, to: b)
            if seg >= remaining, seg > 0 {
                let f = remaining / seg
                return (
                    CLLocationCoordinate2D(
                        latitude: a.latitude + (b.latitude - a.latitude) * f,
                        longitude: a.longitude + (b.longitude - a.longitude) * f
                    ),
                    bearingDeg(from: a, to: b)
                )
            }
            remaining -= seg
            a = b
            i += 1
        }
        let last = route[route.count - 1]
        return (last, bearingDeg(from: route[route.count - 2], to: last))
    }

    /// Nearest point on segment ab to p, and the distance to it (meters).
    private static func projectOntoSegment(
        _ p: CLLocationCoordinate2D, _ a: CLLocationCoordinate2D, _ b: CLLocationCoordinate2D
    ) -> (CLLocationCoordinate2D, Double) {
        let mPerLat = 111_320.0
        let mPerLng = 111_320.0 * cos(a.latitude * .pi / 180)
        let ax = 0.0, ay = 0.0
        let bx = (b.longitude - a.longitude) * mPerLng, by = (b.latitude - a.latitude) * mPerLat
        let px = (p.longitude - a.longitude) * mPerLng, py = (p.latitude - a.latitude) * mPerLat
        let len2 = (bx - ax) * (bx - ax) + (by - ay) * (by - ay)
        let t = len2 > 0 ? max(0, min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / len2)) : 0
        let qx = ax + t * (bx - ax), qy = ay + t * (by - ay)
        let q = CLLocationCoordinate2D(
            latitude: a.latitude + qy / mPerLat,
            longitude: a.longitude + qx / mPerLng
        )
        return (q, ((px - qx) * (px - qx) + (py - qy) * (py - qy)).squareRoot())
    }

    /// Great-circle destination point: `meters` from `c` along `bearingDeg`.
    static func project(
        _ c: CLLocationCoordinate2D, meters: Double, bearingDeg: Double
    ) -> CLLocationCoordinate2D {
        let r = 6_371_000.0
        let d = meters / r
        let brg = bearingDeg * .pi / 180
        let lat1 = c.latitude * .pi / 180
        let lon1 = c.longitude * .pi / 180
        let lat2 = asin(sin(lat1) * cos(d) + cos(lat1) * sin(d) * cos(brg))
        let lon2 = lon1 + atan2(
            sin(brg) * sin(d) * cos(lat1),
            cos(d) - sin(lat1) * sin(lat2)
        )
        return CLLocationCoordinate2D(
            latitude: lat2 * 180 / .pi, longitude: lon2 * 180 / .pi
        )
    }

    /// Initial great-circle bearing from `a` to `b`, degrees clockwise from
    /// north — the same formula the view model uses to derive a course from
    /// movement history.
    static func bearingDeg(
        from a: CLLocationCoordinate2D, to b: CLLocationCoordinate2D
    ) -> Double {
        let lat1 = a.latitude * .pi / 180
        let lat2 = b.latitude * .pi / 180
        let dLon = (b.longitude - a.longitude) * .pi / 180
        let y = sin(dLon) * cos(lat2)
        let x = cos(lat1) * sin(lat2) - sin(lat1) * cos(lat2) * cos(dLon)
        let deg = atan2(y, x) * 180 / .pi
        return (deg + 360).truncatingRemainder(dividingBy: 360)
    }

    // ─── Diagnostics ─────────────────────────────────────────────────────────

    /// One line per change of target — the field log's answer to "what did
    /// it think was coming, and why did that change?"
    private func logTargetChange(_ target: NearbySpot?, nearby: [NearbySpot], ctx: Context) {
        guard target?.spot.id != lastTargetId else { return }
        if let prevId = lastTargetId, let prev = nearby.first(where: { $0.spot.id == prevId }) {
            let along = alongCourseM(prev, ctx: ctx)
            let passed = along.map { $0 < 0 && distanceM(prev, from: ctx.location?.coordinate) > Self.hereM } ?? false
            log(passed ? "spot_passed" : "target_replaced", [
                "title": prev.spot.title,
                "behindM": (-(along ?? 0)).rounded(),
                "played": ctx.lastPlayedAt(prevId) != nil,
            ])
        }
        lastTargetId = target?.spot.id
        if let t = target {
            log("up_next", [
                "title": t.spot.title,
                "distanceM": distanceM(t, from: ctx.location?.coordinate).rounded(),
                "opensInS": opensInS(t, ctx: ctx).map { $0.rounded() } ?? -1,
                "playCount": ctx.playCount(t.spot.id),
                "busyForS": ctx.busyForS.rounded(),
            ])
        } else {
            log("up_next_none", ["eligibleNearby": nearby.filter { isEligible($0, ctx: ctx) }.count])
        }
    }
}
