import CoreLocation
import XCTest

/// Trigger kinds and playback lifecycle at the logic layer: area fences
/// evaluate by containment (never by radius), ambient spots stay out of the
/// arrival scheduler, sequences hold later parts until earlier ones are
/// heard, and series units never auto-replay.
final class TriggerKindTests: XCTestCase {
    private let base = TestFixtures.base

    /// A rectangular fence around `base`, half-sides in meters.
    private func fence(halfEastM: Double, halfNorthM: Double) -> [LngLat] {
        [
            TestFixtures.offset(base, eastM: -halfEastM, northM: -halfNorthM),
            TestFixtures.offset(base, eastM: halfEastM, northM: -halfNorthM),
            TestFixtures.offset(base, eastM: halfEastM, northM: halfNorthM),
            TestFixtures.offset(base, eastM: -halfEastM, northM: halfNorthM),
        ].map { LngLat(lat: $0.latitude, lng: $0.longitude) }
    }

    private func spot(
        id: String,
        kind: String? = nil,
        center: CLLocationCoordinate2D,
        radiusM: Double = 80,
        region: [LngLat]? = nil,
        sequence: SpotSequence? = nil,
        distanceM: Double = 0,
        triggered: Bool = false
    ) -> NearbySpot {
        let doc = FiloDocument(id: "doc-\(id)", text: "A story.", byteLength: 8, tiers: [])
        return NearbySpot(
            spot: Spot(
                id: id,
                trackId: "track-1",
                title: id,
                subtitle: "",
                trigger: GeoTrigger(
                    kind: kind,
                    center: LngLat(lat: center.latitude, lng: center.longitude),
                    radiusM: radiusM,
                    region: region
                ),
                sequence: sequence,
                modes: [],
                status: "published",
                locating: nil
            ),
            track: Track(
                id: "track-1", slug: "t", name: "T", description: "",
                kind: "tour", icon: nil, color: nil, official: true
            ),
            locating: nil,
            distanceM: distanceM,
            triggered: triggered,
            content: ContentPiece(
                id: "c-\(id)", locale: "en", variant: "default",
                document: doc, audioUrl: nil, durationMs: nil,
                source: "test", provenance: nil
            ),
            guide: nil
        )
    }

    // ─── TriggerEvaluator: area semantics ────────────────────────────────────

    func testAreaTriggersByContainmentNotRadius() {
        // Fix is 300m east of the centroid: far outside any radius, but well
        // inside a 1km-wide fence.
        let s = spot(
            id: "town",
            kind: "area",
            center: base,
            radiusM: 80,
            region: fence(halfEastM: 500, halfNorthM: 500)
        )
        let at = TestFixtures.location(TestFixtures.offset(base, eastM: 300, northM: 0))
        let out = TriggerEvaluator.reevaluate([s], at: at)
        XCTAssertTrue(out[0].triggered, "inside the fence must trigger, radius is irrelevant")
        XCTAssertEqual(out[0].distanceM, 0, "inside an area, distance reads 0 (matching the server)")
    }

    func testAreaOutsideFenceIsUntriggeredEvenAtCenterRadius() {
        // Fix is 60m east — inside an 80m radius, but the fence is a tiny
        // 20m box: area kind must NOT fall back to radius triggering.
        let s = spot(
            id: "plaza",
            kind: "area",
            center: base,
            radiusM: 80,
            region: fence(halfEastM: 20, halfNorthM: 20)
        )
        let at = TestFixtures.location(TestFixtures.offset(base, eastM: 60, northM: 0))
        let out = TriggerEvaluator.reevaluate([s], at: at)
        XCTAssertFalse(out[0].triggered)
        XCTAssertGreaterThan(out[0].distanceM, 0)
    }

    func testPointSemanticsUnchanged() {
        let s = spot(id: "p", center: base, radiusM: 80)
        let inside = TestFixtures.location(TestFixtures.offset(base, eastM: 50, northM: 0))
        let outside = TestFixtures.location(TestFixtures.offset(base, eastM: 150, northM: 0))
        XCTAssertTrue(TriggerEvaluator.reevaluate([s], at: inside)[0].triggered)
        XCTAssertFalse(TriggerEvaluator.reevaluate([s], at: outside)[0].triggered)
    }

    func testApproxAreaOrdersFencesBySize() {
        let small = TriggerEvaluator.approxAreaM2(ring: fence(halfEastM: 100, halfNorthM: 100))
        let big = TriggerEvaluator.approxAreaM2(ring: fence(halfEastM: 1000, halfNorthM: 1000))
        XCTAssertLessThan(small, big)
        XCTAssertEqual(small, 200.0 * 200.0, accuracy: small * 0.05)
        XCTAssertEqual(TriggerEvaluator.approxAreaM2(ring: nil), .infinity)
    }

    // ─── SpotScheduler: ambient exclusion, sequences, series ────────────────

    func testSchedulerNeverTargetsAreaSpots() {
        let scheduler = SpotScheduler()
        let ambient = spot(
            id: "town", kind: "area", center: base,
            region: fence(halfEastM: 500, halfNorthM: 500), triggered: true
        )
        let point = spot(id: "p", center: base, distanceM: 10, triggered: true)
        let ctx = SpotScheduler.Context(location: TestFixtures.location(base))
        let plan = scheduler.plan(nearby: [ambient, point], ctx: ctx)
        XCTAssertEqual(plan.target?.spot.id, "p", "only the point spot may be the target")
        XCTAssertEqual(plan.playNow?.spot.id, "p")
        XCTAssertNil(scheduler.plan(nearby: [ambient], ctx: ctx).target)
    }

    func testSequencePartWaitsForItsPredecessor() {
        let scheduler = SpotScheduler()
        var played: Set<String> = []
        let partTwo = spot(
            id: "part2", center: base,
            sequence: SpotSequence(key: "story", index: 1),
            distanceM: 10, triggered: true
        )
        let ctx = SpotScheduler.Context(
            location: TestFixtures.location(base),
            isEligible: { id in id != "part2" || played.contains("part1") }
        )

        // Part one unheard: part two is not even up next.
        XCTAssertNil(scheduler.plan(nearby: [partTwo], ctx: ctx).target)

        // Part one plays (elsewhere): part two is released and starts.
        played.insert("part1")
        XCTAssertEqual(scheduler.plan(nearby: [partTwo], ctx: ctx).playNow?.spot.id, "part2")
    }

    func testSeriesUnitNeverAutoReplays() {
        let scheduler = SpotScheduler()
        let heard = spot(id: "ep1", center: base, distanceM: 10, triggered: true)
        // Played long past the evergreen cooldown — an evergreen spot would
        // be eligible again; a series unit must stay retired.
        let lastPlayed = Date(timeIntervalSinceNow: -8 * 3600)
        let ctx = SpotScheduler.Context(
            location: TestFixtures.location(base),
            lastPlayedAt: { _ in lastPlayed },
            playCount: { _ in 1 },
            neverReplays: { _ in true }
        )
        XCTAssertNil(scheduler.plan(nearby: [heard], ctx: ctx).target, "a heard series unit is never a target")

        // Same history under evergreen rules: plays again.
        let evergreenCtx = SpotScheduler.Context(
            location: TestFixtures.location(base),
            lastPlayedAt: { _ in lastPlayed },
            playCount: { _ in 1 }
        )
        XCTAssertEqual(scheduler.plan(nearby: [heard], ctx: evergreenCtx).playNow?.spot.id, "ep1")
    }
}
