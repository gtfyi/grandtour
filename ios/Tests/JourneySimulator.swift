import CoreLocation
import Foundation

/// Deterministic journey simulation for SpotScheduler: a traveler moves along
/// a waypoint path at constant speed while the harness replays the app's real
/// cadence — a nearby "poll" every 1.5s (the touring throttle), trigger
/// evaluation against each spot's radius, and a fresh plan at every poll and
/// at every narration end. A plan's `playNow` starts against an idle player
/// only; narration occupies the player for its scripted duration and the
/// scheduler predicts across the remainder. Nothing preempts, exactly like
/// the app.
///
/// What it does NOT model: the network (nearby is computed from geometry, as
/// the offline path does), locating clips, and fill-ins — those live outside
/// the scheduler under test.
final class JourneySimulator {
    struct SimSpot {
        let id: String
        let title: String
        let coordinate: CLLocationCoordinate2D
        let radiusM: Double
        var narrationS: Double
        var trackId: String = "track-1"
        var trackSlug: String = "test-track"
        var narratable: Bool = true
    }

    struct PlayEvent {
        let spotId: String
        let title: String
        /// Simulation clock when narration started.
        let timeS: Double
        /// Traveler→spot distance at start (measured fix, like the app sees).
        let distanceM: Double
        /// Signed along-course distance at start: positive = the spot was
        /// still ahead of the traveler, negative = already behind.
        let alongM: Double?
        /// The locator sentence the traveler would hear at this moment —
        /// SpotLocator.describe on the same fix and course the decision used
        /// (metric, no anchor). Lets walkthrough tests assert directionality.
        let locator: String
    }

    struct Config {
        var speedMps: Double
        var mode: String
        var pollIntervalS: Double = 1.5
        var tickS: Double = 0.5
        /// GPS noise amplitude; 0 = perfect fixes. Deterministic (seeded).
        var jitterM: Double = 0
        var seed: UInt64 = 42
        var trackOrder: [String] = []
        var journeyRoute: [CLLocationCoordinate2D] = []
        /// Play history carried into the journey: spotId → how many seconds
        /// BEFORE the simulation starts the spot last played (a prior outing,
        /// yesterday's commute). Counts as one prior play.
        var preplayed: [String: Double] = [:]
        /// Absolute start time when carrying real persisted history between visits.
        var startDate = Date(timeIntervalSince1970: 1_000_000_000)
    }

    /// One spot's history on the simulation clock (`atS` < 0 = before start).
    struct PlayedRecord {
        var count: Int
        var atS: Double
    }

    let scheduler = SpotScheduler()
    /// Every change of target, on the sim clock — what "Up next" would have
    /// shown and when.
    private(set) var targetLog: [(timeS: Double, spotId: String?)] = []
    private let spots: [SimSpot]
    private let path: [CLLocationCoordinate2D]
    private let config: Config
    private let persistentHistory: PlayHistory?
    private var rng: SplitMix64

    private(set) var events: [PlayEvent] = []
    private(set) var nowPlayingId: String?
    private var busyUntilS: Double = -1
    /// The PlayHistory analogue, on the virtual clock: every play the sim
    /// starts is recorded here and fed back through the context, exactly as
    /// TourViewModel feeds PlayHistory into SpotScheduler.Context.
    private(set) var playHistory: [String: PlayedRecord] = [:]

    init(spots: [SimSpot], path: [CLLocationCoordinate2D], config: Config, history: PlayHistory? = nil) {
        self.spots = spots
        self.path = path
        self.config = config
        self.persistentHistory = history
        if let history {
            for spot in spots {
                if let last = history.lastPlayedAt(spot.id) {
                    playHistory[spot.id] = PlayedRecord(
                        count: history.playCount(spot.id), atS: last.timeIntervalSince(config.startDate)
                    )
                }
            }
        }
        self.rng = SplitMix64(seed: config.seed)
        for (id, agoS) in config.preplayed {
            playHistory[id] = PlayedRecord(count: 1, atS: -agoS)
        }
    }

    /// IDs of spots that never played — skipped, which is allowed; the tests
    /// assert about what DID play.
    var skippedSpotIds: [String] {
        let played = Set(events.map(\.spotId))
        return spots.map(\.id).filter { !played.contains($0) }
    }

    /// Run the whole path, then idle in place long enough to drain any
    /// narration still going when the traveler arrives.
    func run(extraIdleS: Double = 0) {
        let total = pathLengthM() / config.speedMps
        var t: Double = 0
        var nextPollAt: Double = 0
        while t <= total + extraIdleS {
            let truePos = position(at: min(t, total))
            let course: Double? = t < total ? courseDeg(at: t) : nil
            let speed: Double = t < total ? config.speedMps : 0

            // Narration end is its own decision point (the player-idle sink).
            if nowPlayingId != nil, t >= busyUntilS {
                nowPlayingId = nil
                decide(at: t, pos: measured(truePos), course: course, speed: speed)
            }

            if t >= nextPollAt {
                nextPollAt = t + config.pollIntervalS
                decide(at: t, pos: measured(truePos), course: course, speed: speed)
            }
            t += config.tickS
        }
    }

    /// One poll: recompute triggers from geometry (the app's offline/local
    /// path does exactly this) and plan. The plan re-aims "up next" whether
    /// or not the player is busy; it starts something only when idle.
    func decide(at t: Double, pos: CLLocationCoordinate2D, course: Double?, speed: Double) {
        let nearby = nearbyList(from: pos)
        let ctx = context(pos: pos, course: course, speed: speed, atS: t)
        let plan = scheduler.plan(nearby: nearby, ctx: ctx)
        if targetLog.last?.spotId != plan.target?.spot.id {
            targetLog.append((t, plan.target?.spot.id))
        }
        guard nowPlayingId == nil, let best = plan.playNow else { return }
        let along = scheduler.alongCourseM(best, ctx: ctx)
        events.append(PlayEvent(
            spotId: best.spot.id,
            title: best.spot.title,
            timeS: t,
            distanceM: scheduler.distanceM(best, from: pos),
            alongM: along,
            locator: SpotLocator.describe(
                spotLat: best.spot.trigger.center.lat,
                spotLng: best.spot.trigger.center.lng,
                userLat: pos.latitude,
                userLng: pos.longitude,
                courseDeg: course,
                anchor: nil,
                metric: true
            )
        ))
        var record = playHistory[best.spot.id] ?? PlayedRecord(count: 0, atS: t)
        record.count += 1
        record.atS = t
        playHistory[best.spot.id] = record
        persistentHistory?.recordPlay(spotId: best.spot.id, at: config.startDate.addingTimeInterval(t))
        nowPlayingId = best.spot.id
        let dur = spots.first { $0.id == best.spot.id }?.narrationS ?? 30
        busyUntilS = t + dur
    }

    // ─── Geometry ────────────────────────────────────────────────────────────

    func context(
        pos: CLLocationCoordinate2D, course: Double?, speed: Double, atS: Double = 0
    ) -> SpotScheduler.Context {
        let startDate = config.startDate
        return SpotScheduler.Context(
            location: CLLocation(
                coordinate: pos,
                altitude: 0,
                horizontalAccuracy: 5,
                verticalAccuracy: 5,
                course: course ?? -1,
                speed: speed,
                timestamp: Date(timeIntervalSince1970: 0)
            ),
            courseDeg: course,
            mode: config.mode,
            journeyRoute: config.journeyRoute,
            trackOrder: config.trackOrder,
            trackIdToSlug: Dictionary(
                spots.map { ($0.trackId, $0.trackSlug) },
                uniquingKeysWith: { a, _ in a }
            ),
            now: startDate.addingTimeInterval(atS),
            lastPlayedAt: { [playHistory] id in
                playHistory[id].map { startDate.addingTimeInterval($0.atS) }
            },
            playCount: { [playHistory] id in playHistory[id]?.count ?? 0 },
            busyForS: max(0, busyUntilS - atS),
            nowPlayingId: nowPlayingId,
            durationS: { [spots] s in spots.first { $0.id == s.spot.id }?.narrationS ?? 30 }
        )
    }

    func nearbyList(from pos: CLLocationCoordinate2D) -> [NearbySpot] {
        return spots.map { s in
            let d = Geo.localDistanceM(from: pos, to: s.coordinate)
            return TestFixtures.nearbySpot(
                id: s.id, title: s.title,
                center: s.coordinate, radiusM: s.radiusM,
                distanceM: d, triggered: d <= s.radiusM,
                trackId: s.trackId, trackSlug: s.trackSlug,
                narratable: s.narratable
            )
        }
        .sorted { $0.distanceM < $1.distanceM }
    }

    private func measured(_ pos: CLLocationCoordinate2D) -> CLLocationCoordinate2D {
        guard config.jitterM > 0 else { return pos }
        let dx = (rng.nextUnit() * 2 - 1) * config.jitterM
        let dy = (rng.nextUnit() * 2 - 1) * config.jitterM
        return TestFixtures.offset(pos, eastM: dx, northM: dy)
    }

    private func pathLengthM() -> Double {
        guard path.count > 1 else { return 0 }
        return zip(path, path.dropFirst()).reduce(0) { acc, pair in
            acc + Geo.localDistanceM(from: pair.0, to: pair.1)
        }
    }

    /// Constant-speed position along the waypoint path at time `t`.
    func position(at t: Double) -> CLLocationCoordinate2D {
        var remaining = config.speedMps * t
        guard path.count > 1 else { return path[0] }
        for i in 0..<(path.count - 1) {
            let a = path[i], b = path[i + 1]
            let seg = Geo.localDistanceM(from: a, to: b)
            if remaining <= seg, seg > 0 {
                let f = remaining / seg
                return CLLocationCoordinate2D(
                    latitude: a.latitude + (b.latitude - a.latitude) * f,
                    longitude: a.longitude + (b.longitude - a.longitude) * f
                )
            }
            remaining -= seg
        }
        return path[path.count - 1]
    }

    /// Direction of travel = bearing of the current path segment.
    private func courseDeg(at t: Double) -> Double? {
        var remaining = config.speedMps * t
        guard path.count > 1 else { return nil }
        for i in 0..<(path.count - 1) {
            let a = path[i], b = path[i + 1]
            let seg = Geo.localDistanceM(from: a, to: b)
            if remaining <= seg { return SpotScheduler.bearingDeg(from: a, to: b) }
            remaining -= seg
        }
        guard let last = path.last, path.count > 1 else { return nil }
        return SpotScheduler.bearingDeg(from: path[path.count - 2], to: last)
    }
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

enum TestFixtures {
    /// Flat-ish test neighborhood; offsets are equirectangular around it,
    /// which agrees with CLLocation's geodesic distance to well under a meter
    /// at these scales.
    static let base = CLLocationCoordinate2D(latitude: 34.078, longitude: -118.361)

    static func offset(
        _ c: CLLocationCoordinate2D, eastM: Double, northM: Double
    ) -> CLLocationCoordinate2D {
        let mPerDegLat = 111_320.0
        let mPerDegLng = 111_320.0 * cos(c.latitude * .pi / 180)
        return CLLocationCoordinate2D(
            latitude: c.latitude + northM / mPerDegLat,
            longitude: c.longitude + eastM / mPerDegLng
        )
    }

    static func nearbySpot(
        id: String,
        title: String,
        center: CLLocationCoordinate2D,
        radiusM: Double,
        distanceM: Double,
        triggered: Bool,
        trackId: String = "track-1",
        trackSlug: String = "test-track",
        narratable: Bool = true,
        hasContent: Bool = true,
        region: [LngLat]? = nil
    ) -> NearbySpot {
        let doc = FiloDocument(
            id: "doc-\(id)",
            text: narratable ? "A story about \(title)." : "",
            byteLength: 24,
            tiers: []
        )
        let content: ContentPiece? = hasContent ? ContentPiece(
            id: "content-\(id)",
            locale: "en",
            variant: "default",
            document: doc,
            audioUrl: nil,
            durationMs: nil,
            source: "test",
            provenance: nil
        ) : nil
        return NearbySpot(
            spot: Spot(
                id: id,
                trackId: trackId,
                title: title,
                subtitle: "",
                trigger: GeoTrigger(
                    center: LngLat(lat: center.latitude, lng: center.longitude),
                    radiusM: radiusM,
                    region: region
                ),
                modes: ["walking", "driving"],
                status: "published",
                locating: nil
            ),
            track: Track(
                id: trackId,
                slug: trackSlug,
                name: "Test Track",
                description: "",
                kind: "tour",
                icon: nil,
                color: nil,
                official: true
            ),
            locating: nil,
            distanceM: distanceM,
            triggered: triggered,
            content: content,
            guide: nil
        )
    }

    static func location(
        _ c: CLLocationCoordinate2D, course: Double? = nil, speed: Double = 0
    ) -> CLLocation {
        CLLocation(
            coordinate: c,
            altitude: 0,
            horizontalAccuracy: 5,
            verticalAccuracy: 5,
            course: course ?? -1,
            speed: speed,
            timestamp: Date(timeIntervalSince1970: 0)
        )
    }
}

/// Tiny deterministic RNG (SplitMix64) so jittered runs are reproducible.
struct SplitMix64 {
    private var state: UInt64
    init(seed: UInt64) { state = seed }
    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
    mutating func nextUnit() -> Double {
        Double(next() >> 11) / Double(1 << 53)
    }
}
