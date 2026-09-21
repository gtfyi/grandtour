import CoreLocation
import XCTest

/// The guided walking-tour planner: which stop is next, arrival semantics,
/// and the spoken directions that send the traveler there.
final class GuidedTourPlannerTests: XCTestCase {
    private let base = TestFixtures.base

    private func stop(
        _ id: String, eastM: Double, northM: Double = 0, radiusM: Double = 30,
        sequence: SpotSequence? = nil, from here: CLLocationCoordinate2D? = nil
    ) -> NearbySpot {
        let c = TestFixtures.offset(base, eastM: eastM, northM: northM)
        let origin = here ?? base
        let d = CLLocation(latitude: origin.latitude, longitude: origin.longitude)
            .distance(from: CLLocation(latitude: c.latitude, longitude: c.longitude))
        let s = TestFixtures.nearbySpot(
            id: id, title: id, center: c, radiusM: radiusM,
            distanceM: d, triggered: d <= radiusM
        )
        guard let sequence else { return s }
        return NearbySpot(
            spot: Spot(
                id: s.spot.id, trackId: s.spot.trackId, title: s.spot.title, subtitle: "",
                trigger: s.spot.trigger, sequence: sequence, modes: s.spot.modes,
                status: s.spot.status, locating: nil
            ),
            track: s.track, locating: nil, distanceM: d, triggered: d <= radiusM,
            content: s.content, guide: nil
        )
    }

    /// Without an authored order the nearest unvisited stop is next; the
    /// traveler's heading never disqualifies it (they'll turn toward it).
    func testNearestUnvisitedStopIsNext_regardlessOfHeading() {
        let stops = [stop("far", eastM: 300), stop("behind-near", eastM: -80), stop("ahead", eastM: 150)]
        let plan = GuidedTourPlanner.plan(
            stops: stops, visited: [], location: TestFixtures.location(base, course: 90, speed: 1.4), courseDeg: 90
        )
        XCTAssertEqual(plan.nextStop?.spot.id, "behind-near")
        XCTAssertFalse(plan.arrived)
        XCTAssertEqual(try XCTUnwrap(plan.distanceM), 80, accuracy: 1)
        XCTAssertEqual(plan.remaining.map(\.spot.id), ["behind-near", "ahead", "far"])
        XCTAssertTrue(try XCTUnwrap(plan.directions).contains("behind you"), plan.directions ?? "nil")
    }

    /// Visited stops drop out; the chain continues from the traveler's
    /// current position.
    func testVisitedStopsAreSkipped() {
        let here = TestFixtures.offset(base, eastM: 100, northM: 0)
        let stops = [stop("a", eastM: 0, from: here), stop("b", eastM: 100, from: here), stop("c", eastM: 400, from: here)]
        let plan = GuidedTourPlanner.plan(
            stops: stops, visited: ["a", "b"], location: TestFixtures.location(here), courseDeg: nil
        )
        XCTAssertEqual(plan.nextStop?.spot.id, "c")
        XCTAssertEqual(plan.remaining.count, 1)
    }

    /// Standing inside the next stop's radius means arrived — narrate.
    func testArrivalIsEnteringTheRadius() {
        let stops = [stop("here", eastM: 20)]
        let plan = GuidedTourPlanner.plan(stops: stops, visited: [], location: TestFixtures.location(base), courseDeg: nil)
        XCTAssertEqual(plan.nextStop?.spot.id, "here")
        XCTAssertTrue(plan.arrived)
    }

    /// An authored sequence overrides distance: stop 1 is next even when
    /// stop 3 is closer, and the sequence gate still holds later parts.
    func testSequencedStopsGoInOrder() {
        let stops = [
            stop("three", eastM: 30, sequence: SpotSequence(key: "walk", index: 3)),
            stop("one", eastM: 200, sequence: SpotSequence(key: "walk", index: 1)),
            stop("two", eastM: 120, sequence: SpotSequence(key: "walk", index: 2)),
        ]
        let plan = GuidedTourPlanner.plan(stops: stops, visited: [], location: TestFixtures.location(base), courseDeg: nil)
        XCTAssertEqual(plan.remaining.map(\.spot.id), ["one", "two", "three"])

        // Part one heard: "two" is next, and the gate keeps "three" out until then.
        let gated = GuidedTourPlanner.plan(
            stops: stops, visited: ["one"], location: TestFixtures.location(base), courseDeg: nil,
            isEligible: { $0 != "three" }
        )
        XCTAssertEqual(gated.remaining.map(\.spot.id), ["two"])
    }

    /// Every stop visited: nothing next, nothing remaining.
    func testAllVisitedMeansDone() {
        let plan = GuidedTourPlanner.plan(
            stops: [stop("a", eastM: 50)], visited: ["a"], location: TestFixtures.location(base), courseDeg: nil
        )
        XCTAssertNil(plan.nextStop)
        XCTAssertTrue(plan.remaining.isEmpty)
    }

    /// The spoken cue names the stop and repeats the directions; without a
    /// fix it still names the stop.
    func testCueText() {
        let s = stop("The Old Mill", eastM: 200)
        XCTAssertEqual(
            GuidedTourPlanner.cue(for: s, directions: "About 200 meters to the east."),
            "Next stop: The Old Mill. About 200 meters to the east."
        )
        XCTAssertEqual(GuidedTourPlanner.cue(for: s, directions: nil), "Next stop: The Old Mill.")
    }

    /// Heading away = farther than at the last cue by more than the slack.
    func testHeadingAway() {
        XCTAssertFalse(GuidedTourPlanner.isHeadingAway(distanceM: 130, sinceCueM: 100))
        XCTAssertTrue(GuidedTourPlanner.isHeadingAway(distanceM: 150, sinceCueM: 100))
    }
}
