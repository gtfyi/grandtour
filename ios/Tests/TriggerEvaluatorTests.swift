import XCTest
import CoreLocation

/// TriggerEvaluator is the on-device trigger math shared by the phone's
/// `unchanged`-poll re-evaluation and the watch's per-fix check; PollPolicy
/// is the watch's network-poll throttle. Both are pure, so they test direct.
final class TriggerEvaluatorTests: XCTestCase {
    // ─── reevaluate: radius triggers + distance recompute ────────────────────

    func testReevaluateTriggersInsideRadius() {
        let center = TestFixtures.base
        // Server said: 300 m away, not triggered. We've since walked to 20 m.
        let spot = TestFixtures.nearbySpot(
            id: "s1", title: "Fountain", center: center,
            radiusM: 35, distanceM: 300, triggered: false
        )
        let here = TestFixtures.location(TestFixtures.offset(center, eastM: 20, northM: 0))
        let out = TriggerEvaluator.reevaluate([spot], at: here)
        XCTAssertEqual(out.count, 1)
        XCTAssertTrue(out[0].triggered)
        XCTAssertEqual(out[0].distanceM, 20, accuracy: 1)
    }

    func testReevaluateUntriggersOutsideRadius() {
        let center = TestFixtures.base
        // Server said triggered (we were inside); we've since left.
        let spot = TestFixtures.nearbySpot(
            id: "s1", title: "Fountain", center: center,
            radiusM: 35, distanceM: 10, triggered: true
        )
        let here = TestFixtures.location(TestFixtures.offset(center, eastM: 200, northM: 0))
        let out = TriggerEvaluator.reevaluate([spot], at: here)
        XCTAssertFalse(out[0].triggered)
        XCTAssertEqual(out[0].distanceM, 200, accuracy: 2)
    }

    func testReevaluatePreservesEverythingElse() {
        let center = TestFixtures.base
        let spot = TestFixtures.nearbySpot(
            id: "s1", title: "Fountain", center: center,
            radiusM: 35, distanceM: 300, triggered: false
        )
        let here = TestFixtures.location(TestFixtures.offset(center, eastM: 20, northM: 0))
        let out = TriggerEvaluator.reevaluate([spot], at: here)
        XCTAssertEqual(out[0].spot.id, spot.spot.id)
        XCTAssertEqual(out[0].track.slug, spot.track.slug)
        XCTAssertEqual(out[0].content?.id, spot.content?.id)
    }

    // ─── inside: ray-cast polygon ────────────────────────────────────────────

    /// ~200 m square around the base coordinate.
    private var squareRing: [LngLat] {
        let c = TestFixtures.base
        return [
            TestFixtures.offset(c, eastM: -100, northM: -100),
            TestFixtures.offset(c, eastM: 100, northM: -100),
            TestFixtures.offset(c, eastM: 100, northM: 100),
            TestFixtures.offset(c, eastM: -100, northM: 100),
        ].map { LngLat(lat: $0.latitude, lng: $0.longitude) }
    }

    func testInsidePolygon() {
        XCTAssertTrue(TriggerEvaluator.inside(TestFixtures.base, ring: squareRing))
        let nearEdge = TestFixtures.offset(TestFixtures.base, eastM: 90, northM: 90)
        XCTAssertTrue(TriggerEvaluator.inside(nearEdge, ring: squareRing))
    }

    func testOutsidePolygon() {
        let outside = TestFixtures.offset(TestFixtures.base, eastM: 150, northM: 0)
        XCTAssertFalse(TriggerEvaluator.inside(outside, ring: squareRing))
    }

    func testDegenerateRingsNeverContain() {
        XCTAssertFalse(TriggerEvaluator.inside(TestFixtures.base, ring: nil))
        XCTAssertFalse(TriggerEvaluator.inside(TestFixtures.base, ring: []))
        XCTAssertFalse(TriggerEvaluator.inside(
            TestFixtures.base,
            ring: Array(squareRing.prefix(2))
        ))
    }

    func testRegionTriggersOutsideRadius() {
        // A polygon spot: the traveler is outside the 35 m radius but inside
        // the region ring — that still counts as triggered.
        let center = TestFixtures.base
        var spot = TestFixtures.nearbySpot(
            id: "s1", title: "Plaza", center: center,
            radiusM: 35, distanceM: 300, triggered: false
        )
        spot = NearbySpot(
            spot: Spot(
                id: spot.spot.id,
                trackId: spot.spot.trackId,
                title: spot.spot.title,
                subtitle: spot.spot.subtitle,
                trigger: GeoTrigger(
                    center: spot.spot.trigger.center,
                    radiusM: spot.spot.trigger.radiusM,
                    region: squareRing
                ),
                modes: spot.spot.modes,
                status: spot.spot.status,
                locating: spot.spot.locating
            ),
            track: spot.track,
            locating: spot.locating,
            distanceM: spot.distanceM,
            triggered: spot.triggered,
            content: spot.content,
            guide: spot.guide
        )
        let here = TestFixtures.location(TestFixtures.offset(center, eastM: 80, northM: 0))
        let out = TriggerEvaluator.reevaluate([spot], at: here)
        XCTAssertTrue(out[0].triggered)
    }
}

final class PollPolicyTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_000_000_000)

    func testMovingCadence() {
        XCTAssertFalse(PollPolicy.shouldFetch(
            now: t0.addingTimeInterval(5), lastFetchAt: t0, isMoving: true, isFetching: false
        ))
        XCTAssertTrue(PollPolicy.shouldFetch(
            now: t0.addingTimeInterval(PollPolicy.movingIntervalS), lastFetchAt: t0,
            isMoving: true, isFetching: false
        ))
    }

    func testStationaryCadenceIsSlower() {
        // Due for a moving traveler, still held for a stationary one.
        let at = t0.addingTimeInterval(PollPolicy.movingIntervalS)
        XCTAssertTrue(PollPolicy.shouldFetch(
            now: at, lastFetchAt: t0, isMoving: true, isFetching: false
        ))
        XCTAssertFalse(PollPolicy.shouldFetch(
            now: at, lastFetchAt: t0, isMoving: false, isFetching: false
        ))
        XCTAssertTrue(PollPolicy.shouldFetch(
            now: t0.addingTimeInterval(PollPolicy.stationaryIntervalS), lastFetchAt: t0,
            isMoving: false, isFetching: false
        ))
    }

    func testInFlightAlwaysHolds() {
        XCTAssertFalse(PollPolicy.shouldFetch(
            now: t0.addingTimeInterval(3600), lastFetchAt: t0, isMoving: true, isFetching: true
        ))
    }
}
