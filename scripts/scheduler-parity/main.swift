// Golden-case generator for the TS↔Swift scheduler parity check. Runs the
// phone's SpotScheduler (the canonical version) over a broad grid of
// decisions and over simulated journeys, and prints everything the port
// must reproduce. check.ts replays it. See scheduler.ts.
import CoreLocation
import Foundation

struct Offset: Codable { let e: Double; let n: Double }
struct SpotSpec: Codable {
    let id: String; let title: String; let e: Double; let n: Double; let radiusM: Double
    var triggered: Bool? = nil; var trackId: String = "track-1"; var trackSlug: String = "test-track"
    var narratable: Bool = true; var hasContent: Bool = true; var region: [Offset]? = nil
    var narrationS: Double = 30
}
struct CtxSpec: Codable {
    var atE: Double = 0; var atN: Double = 0; var courseDeg: Double? = nil; var speed: Double = 1.4
    var mode: String = "walking"; var journeyRoute: [Offset] = []; var trackOrder: [String] = []
    var trackIdToSlug: [String: String] = [:]; var playedAgoS: [String: Double] = [:]
    var playCounts: [String: Int] = [:]; var busyForS: Double = 0; var nowPlayingId: String? = nil
    var narrationS: Double = 60
}
struct PredictionOut: Codable { let lat: Double; let lng: Double; let courseDeg: Double?; let speedMps: Double? }
struct PlanOut: Codable { let targetId: String?; let targetOpensInS: Double?; let playNowId: String?; let gapBudgetS: Double?; let prediction: PredictionOut? }
struct PlanCase: Codable { let name: String; let spots: [SpotSpec]; let ctx: CtxSpec; let expect: PlanOut }

struct ConfigSpec: Codable {
    var speedMps: Double; var mode: String; var pollIntervalS: Double = 1.5; var tickS: Double = 0.5
    var jitterM: Double = 0; var seed: UInt64 = 42; var trackOrder: [String] = []; var journeyRoute: [Offset] = []
    var preplayed: [String: Double] = [:]; var startS: Double = 1_000_000_000
}
struct EventOut: Codable { let spotId: String; let timeS: Double; let distanceM: Double; let alongM: Double?; let locator: String }
struct TargetOut: Codable { let timeS: Double; let spotId: String? }
struct RunOut: Codable { let events: [EventOut]; let targets: [TargetOut]; let skipped: [String] }
struct JourneyCase: Codable { let name: String; let spots: [SpotSpec]; let path: [Offset]; let config: ConfigSpec; let extraIdleS: Double; let expect: RunOut }
struct VisitRun: Codable { let path: [Offset]; let config: ConfigSpec; let extraIdleS: Double; let expect: RunOut }
struct VisitCase: Codable { let name: String; let spots: [SpotSpec]; let runs: [VisitRun] }
struct Golden: Codable { let plans: [PlanCase]; let journeys: [JourneyCase]; let visits: [VisitCase] }

let base = TestFixtures.base
let now = Date(timeIntervalSince1970: 1_000_000_000)
func coord(_ o: Offset) -> CLLocationCoordinate2D { TestFixtures.offset(base, eastM: o.e, northM: o.n) }

func nearby(_ specs: [SpotSpec], at: CLLocationCoordinate2D) -> [NearbySpot] {
    specs.map { s in
        let c = coord(Offset(e: s.e, n: s.n))
        let d = CLLocation(latitude: at.latitude, longitude: at.longitude)
            .distance(from: CLLocation(latitude: c.latitude, longitude: c.longitude))
        let ring = s.region.map { $0.map { let p = coord($0); return LngLat(lat: p.latitude, lng: p.longitude) } }
        return TestFixtures.nearbySpot(
            id: s.id, title: s.id, center: c, radiusM: s.radiusM, distanceM: d,
            triggered: s.triggered ?? (d <= s.radiusM || TriggerEvaluator.inside(at, ring: ring)),
            trackId: s.trackId, trackSlug: s.trackSlug, narratable: s.narratable, hasContent: s.hasContent, region: ring
        )
    }
}

func context(_ c: CtxSpec) -> SpotScheduler.Context {
    SpotScheduler.Context(
        location: TestFixtures.location(coord(Offset(e: c.atE, n: c.atN)), course: c.courseDeg, speed: c.speed),
        courseDeg: c.courseDeg, mode: c.mode, journeyRoute: c.journeyRoute.map(coord),
        trackOrder: c.trackOrder, trackIdToSlug: c.trackIdToSlug, now: now,
        lastPlayedAt: { id in c.playedAgoS[id].map { now.addingTimeInterval(-$0) } },
        playCount: { id in c.playCounts[id] ?? (c.playedAgoS[id] != nil ? 1 : 0) },
        busyForS: c.busyForS, nowPlayingId: c.nowPlayingId, durationS: { _ in c.narrationS }
    )
}

func planCase(_ name: String, _ spots: [SpotSpec], _ c: CtxSpec) -> PlanCase {
    let at = coord(Offset(e: c.atE, n: c.atN))
    let plan = SpotScheduler().plan(nearby: spots, at: at, ctx: context(c))
    return PlanCase(name: name, spots: spots, ctx: c, expect: PlanOut(
        targetId: plan.target?.spot.id, targetOpensInS: plan.targetOpensInS, playNowId: plan.playNow?.spot.id,
        gapBudgetS: plan.gapBudgetS,
        prediction: plan.prediction.map { PredictionOut(lat: $0.coordinate.latitude, lng: $0.coordinate.longitude, courseDeg: $0.courseDeg, speedMps: $0.speedMps) }
    ))
}
extension SpotScheduler {
    func plan(nearby specs: [SpotSpec], at: CLLocationCoordinate2D, ctx: Context) -> Plan { plan(nearby: nearby(specs, at: at), ctx: ctx) }
}

// ─── Plan cases: the unit tests' layouts, then a grid ────────────────────────
var plans: [PlanCase] = []
let S = { (id: String, e: Double, n: Double, r: Double) in SpotSpec(id: id, title: id, e: e, n: n, radiusM: r) }
plans.append(planCase("ahead-and-behind", [S("behind", -100, 0, 35), S("ahead", 80, 0, 35)], CtxSpec(courseDeg: 90)))
plans.append(planCase("just-passed-inside", [SpotSpec(id: "just-passed", title: "just-passed", e: -20, n: 0, radiusM: 35, triggered: true)], CtxSpec(courseDeg: 90)))
plans.append(planCase("driving-arrival-beats-preferred", [SpotSpec(id: "farther", title: "farther", e: 800, n: 0, radiusM: 35, trackId: "preferred-id", trackSlug: "preferred"), S("here", -40, 0, 100)],
    CtxSpec(courseDeg: 90, speed: 18, mode: "driving", trackOrder: ["preferred"], trackIdToSlug: ["preferred-id": "preferred"])))
plans.append(planCase("arrival-expires", [S("passed", -110, 0, 100)], CtxSpec(courseDeg: 90, speed: 18, mode: "driving")))
plans.append(planCase("busy-no-interrupt", [S("here", -20, 0, 100)], CtxSpec(courseDeg: 90, speed: 18, mode: "driving", busyForS: 40, nowPlayingId: "playing")))
plans.append(planCase("heard-no-bypass", [S("here", -20, 0, 100)], CtxSpec(courseDeg: 90, speed: 18, mode: "driving", playedAgoS: ["here": 10])))
plans.append(planCase("unknown-course", [SpotSpec(id: "somewhere", title: "somewhere", e: -30, n: 0, radiusM: 35, triggered: true)], CtxSpec(courseDeg: nil, speed: 0)))
plans.append(planCase("lateral-waits", [S("side", 60, 60, 35)], CtxSpec(courseDeg: 90)))
plans.append(planCase("filler-fits", [S("heard", 30, 0, 35), S("fresh", 250, 0, 35)], CtxSpec(courseDeg: 90, playedAgoS: ["heard": 86400], narrationS: 30)))
plans.append(planCase("filler-yields", [S("heard", 30, 0, 35), S("fresh", 120, 0, 35)], CtxSpec(courseDeg: 90, playedAgoS: ["heard": 86400], narrationS: 60)))
plans.append(planCase("off-path-cannot-block", [S("side", 20, 200, 35), S("here", 20, 0, 35)], CtxSpec(courseDeg: 90, playedAgoS: ["here": 86400], narrationS: 30)))
plans.append(planCase("off-path-no-blanket", [S("side", 20, 200, 35), S("heard", 20, 0, 35), S("fresh", 120, 0, 35)], CtxSpec(courseDeg: 90, playedAgoS: ["heard": 86400], narrationS: 60)))
let ring = [(-100.0, -100.0), (100, -100), (100, 100), (-100, 100)].map { Offset(e: $0.0, n: $0.1) }
plans.append(planCase("boundary-arrival", [SpotSpec(id: "boundary", title: "boundary", e: 60, n: 60, radiusM: 10, triggered: true, region: ring)], CtxSpec(courseDeg: 90)))
plans.append(planCase("turn-toward-side", [S("side", 0, 200, 35)], CtxSpec(courseDeg: 0)))
plans.append(planCase("prediction-busy", [S("under", 40, 0, 35), S("beyond", 150, 0, 35)], CtxSpec(courseDeg: 90, busyForS: 60, nowPlayingId: "x")))
plans.append(planCase("route-turn", [S("dead-ahead", 900, 0, 60), S("around-corner", 300, 600, 60)],
    CtxSpec(atE: 250, courseDeg: 90, speed: 12, mode: "driving", journeyRoute: [Offset(e: 0, n: 0), Offset(e: 300, n: 0), Offset(e: 300, n: 900)], busyForS: 45, nowPlayingId: "x")))

let gridSpots = [
    S("a", 60, 0, 35), S("b", 200, 0, 35), S("c", 150, 80, 100), S("d", -60, 0, 35),
    SpotSpec(id: "e", title: "e", e: 400, n: 0, radiusM: 35, trackId: "t-a", trackSlug: "preferred"),
    SpotSpec(id: "f", title: "f", e: 90, n: -12, radiusM: 35, narratable: false),
]
let plays: [(String, [String: Double], [String: Int])] = [
    ("fresh", [:], [:]), ("a-hour", ["a": 3600], [:]), ("a-day-b-week", ["a": 86400, "b": 8 * 86400], ["a": 3, "b": 1]),
]
for atE in [0.0, 100, 250] {
    for course in [nil, 90.0, 45.0, 270.0] as [Double?] {
        for speed in [0.0, -1, 1.4, 13.4] {
            for mode in ["walking", "driving"] {
                for busy in [0.0, 30, 90] {
                    for (pname, played, counts) in plays {
                        for ordered in [false, true] {
                            for narr in [30.0, 180] {
                                let c = CtxSpec(atE: atE, courseDeg: course, speed: speed, mode: mode,
                                                trackOrder: ordered ? ["preferred"] : [], trackIdToSlug: ["t-a": "preferred", "track-1": "test-track"],
                                                playedAgoS: played, playCounts: counts, busyForS: busy,
                                                nowPlayingId: busy > 0 ? "x" : nil, narrationS: narr)
                                let cs = course.map { String(Int($0)) } ?? "nil"
                                plans.append(planCase("grid e\(Int(atE)) c\(cs) v\(speed) \(mode) busy\(Int(busy)) \(pname) \(ordered ? "ordered" : "unordered") n\(Int(narr))", gridSpots, c))
                            }
                        }
                    }
                }
            }
        }
    }
}

// ─── Journeys ────────────────────────────────────────────────────────────────
func simSpots(_ specs: [SpotSpec]) -> [JourneySimulator.SimSpot] {
    specs.map { s in
        JourneySimulator.SimSpot(id: s.id, title: s.title, coordinate: coord(Offset(e: s.e, n: s.n)), radiusM: s.radiusM,
                                 narrationS: s.narrationS, trackId: s.trackId, trackSlug: s.trackSlug, narratable: s.narratable)
    }
}
func simConfig(_ c: ConfigSpec) -> JourneySimulator.Config {
    JourneySimulator.Config(speedMps: c.speedMps, mode: c.mode, pollIntervalS: c.pollIntervalS, tickS: c.tickS, jitterM: c.jitterM,
                            seed: c.seed, trackOrder: c.trackOrder, journeyRoute: c.journeyRoute.map(coord), preplayed: c.preplayed,
                            startDate: Date(timeIntervalSince1970: c.startS))
}
func runOut(_ sim: JourneySimulator) -> RunOut {
    RunOut(events: sim.events.map { EventOut(spotId: $0.spotId, timeS: $0.timeS, distanceM: $0.distanceM, alongM: $0.alongM, locator: $0.locator) },
           targets: sim.targetLog.map { TargetOut(timeS: $0.timeS, spotId: $0.spotId) }, skipped: sim.skippedSpotIds)
}
func journey(_ name: String, _ spots: [SpotSpec], _ path: [Offset], _ config: ConfigSpec, extraIdleS: Double = 60) -> JourneyCase {
    let sim = JourneySimulator(spots: simSpots(spots), path: path.map(coord), config: simConfig(config))
    sim.run(extraIdleS: extraIdleS)
    return JourneyCase(name: name, spots: spots, path: path, config: config, extraIdleS: extraIdleS, expect: runOut(sim))
}
let J = { (id: String, e: Double, n: Double, r: Double, dur: Double) in SpotSpec(id: id, title: "Spot \(id)", e: e, n: n, radiusM: r, narrationS: dur) }
let E = { (m: Double) in Offset(e: m, n: 0) }
var journeys: [JourneyCase] = [
    journey("walking-spaced", [J("s0", 250, 0, 35, 30), J("s1", 500, 0, 35, 30), J("s2", 750, 0, 35, 30)], [E(0), E(1000)], ConfigSpec(speedMps: 1.4, mode: "walking")),
    journey("walking-dense", (0..<8).map { J("s\($0)", 100 + Double($0) * 60, 0, 35, 75) }, [E(0), E(700)], ConfigSpec(speedMps: 1.4, mode: "walking"), extraIdleS: 120),
    journey("driving-dense", (0..<5).map { J("s\($0)", 300 + Double($0) * 400, 0, 60, 45) }, [E(0), E(2500)], ConfigSpec(speedMps: 13.4, mode: "driving")),
    journey("driving-sparse", [J("s0", 1000, 0, 60, 40), J("s1", 2000, 0, 60, 40)], [E(0), E(2600)], ConfigSpec(speedMps: 13.4, mode: "driving")),
    journey("standing-jitter", [J("s0", 50, 0, 35, 30)], [E(50)], ConfigSpec(speedMps: 1.4, mode: "walking", jitterM: 8), extraIdleS: 600),
    journey("boundary-jitter", [J("s0", 34, 0, 35, 20)], [E(0)], ConfigSpec(speedMps: 1.4, mode: "walking", jitterM: 15), extraIdleS: 300),
    journey("loop-back", [J("s0", 100, 0, 35, 30)], [E(0), E(300), E(0)], ConfigSpec(speedMps: 1.4, mode: "walking")),
    journey("preplayed-yesterday", [J("s0", 100, 0, 35, 30)], [E(0), E(300)], ConfigSpec(speedMps: 1.4, mode: "walking", preplayed: ["s0": 86400])),
    journey("preplayed-hour", [J("s0", 100, 0, 35, 30)], [E(0), E(300)], ConfigSpec(speedMps: 1.4, mode: "walking", preplayed: ["s0": 3600])),
    journey("fresh-wins-gap", [J("heard", 100, 20, 35, 90), J("fresh", 100, -20, 35, 90)], [E(0), E(400)], ConfigSpec(speedMps: 1.4, mode: "walking", preplayed: ["heard": 86400]), extraIdleS: 120),
    journey("heard-fills", [J("heard", 100, 0, 35, 30), J("fresh", 400, 0, 35, 30)], [E(0), E(600)], ConfigSpec(speedMps: 1.4, mode: "walking", preplayed: ["heard": 86400])),
    journey("heard-yields", [J("heard", 100, 0, 35, 90), J("fresh", 160, 0, 35, 30)], [E(0), E(400)], ConfigSpec(speedMps: 1.4, mode: "walking", preplayed: ["heard": 86400])),
    journey("up-next-past-current", [J("first", 60, 0, 35, 90), J("under", 100, 0, 35, 30), J("beyond", 300, 0, 35, 30)], [E(0), E(500)], ConfigSpec(speedMps: 1.4, mode: "walking")),
    journey("dense-jitter-seed7", (0..<6).map { J("s\($0)", 120 + Double($0) * 90, Double($0 % 2) * 10, 40, 50) }, [E(0), E(800)], ConfigSpec(speedMps: 1.4, mode: "walking", jitterM: 6, seed: 7), extraIdleS: 90),
    journey("route-corner-drive", [J("dead-ahead", 900, 0, 60, 40), J("around-corner", 300, 600, 60, 40), J("first", 120, 0, 60, 45)],
            [E(0), E(300), Offset(e: 300, n: 900)], ConfigSpec(speedMps: 12, mode: "driving", journeyRoute: [E(0), E(300), Offset(e: 300, n: 900)]), extraIdleS: 30),
    journey("two-tracks-ordered", [SpotSpec(id: "fav", title: "Fav", e: 150, n: 10, radiusM: 35, trackId: "favorite", trackSlug: "favorite", narrationS: 40),
                                   SpotSpec(id: "disc", title: "Disc", e: 150, n: -10, radiusM: 35, trackId: "discovery", trackSlug: "discovery", narrationS: 40),
                                   SpotSpec(id: "far", title: "Far", e: 500, n: 0, radiusM: 35, trackId: "discovery", trackSlug: "discovery", narrationS: 40)],
            [E(0), E(700)], ConfigSpec(speedMps: 1.4, mode: "walking", trackOrder: ["favorite", "discovery"])),
]

// ─── Repeated visits with carried history (RepeatedTownTests) ───────────────
func townSpots(withFourth: Bool) -> [SpotSpec] {
    var spots: [SpotSpec] = []
    for block in 0..<4 {
        for story in 0..<(withFourth ? 4 : 3) {
            spots.append(SpotSpec(id: "\(block)-\(story)", title: "Block \(block), story \(story)", e: Double(block + 1) * 1200, n: 20 + Double(story), radiusM: 35,
                                  trackId: story == 0 ? "favorite" : "discovery", trackSlug: story == 0 ? "favorite" : "discovery", narrationS: 70))
        }
    }
    spots.append(SpotSpec(id: "side-street", title: "Off the route", e: 20, n: 200, radiusM: 35, trackId: "favorite", trackSlug: "favorite", narrationS: 70))
    return spots
}
func visits(_ name: String, modes: [String]) -> VisitCase {
    let suite = "scheduler-parity.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    // PlayHistory drops records older than 180 days against the real clock,
    // so repeated visits run on today's clock, like RepeatedTownTests.
    let today = Date().timeIntervalSince1970.rounded(.down)
    let offsets: [Double] = [0, 2 * 3600, 24 * 3600, 48 * 3600]
    var runs: [VisitRun] = []
    for (visit, mode) in modes.enumerated() {
        let spots = townSpots(withFourth: visit == 3)
        let backwards = visit % 2 == 1
        let path = backwards ? [E(5400), E(0)] : [E(0), E(5400)]
        let config = ConfigSpec(speedMps: mode == "walking" ? 1.4 : 13.4, mode: mode, trackOrder: ["favorite", "discovery"], startS: today + offsets[visit])
        let history = PlayHistory(defaults: defaults)
        let sim = JourneySimulator(spots: simSpots(spots), path: path.map(coord), config: simConfig(config), history: history)
        sim.run()
        runs.append(VisitRun(path: path, config: config, extraIdleS: 0, expect: runOut(sim)))
    }
    return VisitCase(name: name, spots: townSpots(withFourth: true), runs: runs)
}
let visitCases = [
    visits("town-walking", modes: Array(repeating: "walking", count: 4)),
    visits("town-driving", modes: Array(repeating: "driving", count: 4)),
    visits("town-mixed", modes: ["walking", "driving", "walking", "driving"]),
]

let encoder = JSONEncoder()
encoder.outputFormatting = [.sortedKeys]
let data = try encoder.encode(Golden(plans: plans, journeys: journeys, visits: visitCases))
FileHandle.standardOutput.write(data)
