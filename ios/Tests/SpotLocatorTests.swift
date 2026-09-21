import CoreLocation
import XCTest

/// Direction-inference ground truth for SpotLocator, in the traveler's course
/// frame: the spot is placed `alongM` down the line of travel (+ ahead,
/// − behind) and `lateralM` across it (+ right, − left), so left/right are
/// true by construction — a sign or wrap error anywhere in the bearing/side
/// chain flips them and fails. Mirrors the suite in
/// packages/shared/tests/locate.test.ts (same cases, same expected strings).
final class SpotLocatorDirectionTests: XCTestCase {
    private func locate(course: Double?, alongM: Double, lateralM: Double) -> String {
        let rad = Double.pi / 180
        let c = (course ?? 0) * rad
        let east = alongM * sin(c) + lateralM * sin(c + .pi / 2)
        let north = alongM * cos(c) + lateralM * cos(c + .pi / 2)
        let spot = TestFixtures.offset(TestFixtures.base, eastM: east, northM: north)
        return SpotLocator.describe(
            spotLat: spot.latitude, spotLng: spot.longitude,
            userLat: TestFixtures.base.latitude, userLng: TestFixtures.base.longitude,
            courseDeg: course, anchor: nil, metric: true
        )
    }

    /// Wrap-around and diagonal courses included on purpose.
    private let courses: [Double] = [0, 45, 90, 135, 180, 225, 270, 315, 350]

    func testAbeamRightAndLeft_everyCourse() {
        for c in courses {
            XCTAssertEqual(locate(course: c, alongM: 0, lateralM: 30),
                           "To your right, about 30 meters away.", "course \(c)")
            XCTAssertEqual(locate(course: c, alongM: 0, lateralM: -30),
                           "To your left, about 30 meters away.", "course \(c)")
        }
    }

    func testAheadRightAndLeft_everyCourse() {
        for c in courses {
            XCTAssertEqual(locate(course: c, alongM: 100, lateralM: 40),
                           "Coming up in 100 meters on your right.", "course \(c)")
            XCTAssertEqual(locate(course: c, alongM: 100, lateralM: -40),
                           "Coming up in 100 meters on your left.", "course \(c)")
        }
    }

    func testBehindRightAndLeft_everyCourse() {
        for c in courses {
            XCTAssertEqual(locate(course: c, alongM: -100, lateralM: 40),
                           "Back 100 meters on your right.", "course \(c)")
            XCTAssertEqual(locate(course: c, alongM: -100, lateralM: -40),
                           "Back 100 meters on your left.", "course \(c)")
        }
    }

    /// The field bug: walking down a street, a spot 200m up but across the
    /// road used to read "straight ahead" (inside the ±15° cone). Only spots
    /// within the corridor of the traveler's own line may say ahead/behind.
    func testAheadIsACorridorNotACone() {
        XCTAssertEqual(locate(course: 0, alongM: 200, lateralM: 15),
                       "Coming up in 200 meters on your right.")
        XCTAssertEqual(locate(course: 0, alongM: 200, lateralM: -15),
                       "Coming up in 200 meters on your left.")
        XCTAssertEqual(locate(course: 0, alongM: 200, lateralM: 0),
                       "Coming up in 200 meters, straight ahead.")
        XCTAssertEqual(locate(course: 0, alongM: 200, lateralM: 8),
                       "Coming up in 200 meters, straight ahead.")
        XCTAssertEqual(locate(course: 90, alongM: 1000, lateralM: 25),
                       "Coming up in 1.0 kilometers on your right.")
        XCTAssertEqual(locate(course: 0, alongM: -150, lateralM: 20),
                       "Back 150 meters on your right.")
        XCTAssertEqual(locate(course: 0, alongM: -150, lateralM: 0),
                       "150 meters behind you.")
        // Close range: corridor is wider than the cone there; nothing changes.
        XCTAssertEqual(locate(course: 0, alongM: 30, lateralM: 5),
                       "Coming up in 30 meters, straight ahead.")
    }
}

/// Simulated walkthroughs asserting what the traveler would HEAR: the same
/// JourneySimulator journeys as the scheduler tests, now checking each play's
/// locator sentence. Product rules under test: a spot flanking the street is
/// announced on its true side (never "straight ahead"), only spots on the
/// traveler's own line say "straight ahead", and auto-play never announces a
/// spot behind the traveler.
final class WalkthroughDirectionTests: XCTestCase {
    private let base = TestFixtures.base

    /// In journeys spaced so every story starts at trigger entry, no
    /// announcement may place the spot behind the traveler. ("Right here,
    /// just behind you" is exempt everywhere — standing inside a trigger a
    /// few meters past its center is arrival, not narrating from behind.)
    private func assertNeverAnnouncedBehind(
        _ sim: JourneySimulator, file: StaticString = #filePath, line: UInt = #line
    ) {
        for e in sim.events where !e.locator.hasPrefix("Right here") {
            XCTAssertFalse(
                e.locator.hasPrefix("Back ") || e.locator.contains("behind you"),
                "\(e.title) was announced behind the traveler: \"\(e.locator)\"",
                file: file, line: line
            )
        }
    }

    /// Walking east down a street with storefronts flanking it (±15m):
    /// heading east, north is the traveler's LEFT. Every announcement must
    /// name the true side, and none may claim "straight ahead".
    func testWalkStreet_flankingSpotsAreAnnouncedOnTheirTrueSides() {
        // (x meters east, lateral: + = north of the street = traveler's left)
        let layout: [(x: Double, northM: Double)] = [
            (200, 15), (450, -15), (700, 15), (950, -15),
        ]
        let spots = layout.enumerated().map { i, p in
            JourneySimulator.SimSpot(
                id: "s\(i)", title: "Spot \(i)",
                coordinate: TestFixtures.offset(base, eastM: p.x, northM: p.northM),
                radiusM: 40, narrationS: 30
            )
        }
        let sim = JourneySimulator(
            spots: spots,
            path: [base, TestFixtures.offset(base, eastM: 1200, northM: 0)],
            config: .init(speedMps: 1.4, mode: "walking")
        )
        sim.run(extraIdleS: 60)

        XCTAssertEqual(sim.events.count, 4, "all spaced street spots should play")
        for e in sim.events {
            let expectLeft = layout[Int(e.spotId.dropFirst())!].northM > 0
            let side = expectLeft ? "on your left" : "on your right"
            let wrong = expectLeft ? "on your right" : "on your left"
            XCTAssertTrue(
                e.locator.contains(side),
                "\(e.title) should be \(side), heard: \"\(e.locator)\""
            )
            XCTAssertFalse(
                e.locator.contains(wrong),
                "\(e.title) announced on the WRONG side: \"\(e.locator)\""
            )
            XCTAssertFalse(
                e.locator.contains("straight ahead"),
                "a flanking street spot must never be 'straight ahead': \"\(e.locator)\""
            )
        }
        assertNeverAnnouncedBehind(sim)
    }

    /// The one thing that IS straight ahead on a street: a spot on the
    /// traveler's own line (a plaza you walk into, a bridge you cross).
    func testWalkStreet_spotOnThePathSaysStraightAhead() {
        let spots = [JourneySimulator.SimSpot(
            id: "s0", title: "Plaza",
            coordinate: TestFixtures.offset(base, eastM: 300, northM: 0),
            radiusM: 35, narrationS: 30
        )]
        let sim = JourneySimulator(
            spots: spots,
            path: [base, TestFixtures.offset(base, eastM: 600, northM: 0)],
            config: .init(speedMps: 1.4, mode: "walking")
        )
        sim.run(extraIdleS: 60)

        XCTAssertEqual(sim.events.count, 1)
        XCTAssertTrue(
            sim.events[0].locator.contains("straight ahead"),
            "an on-path spot should be straight ahead, heard: \"\(sim.events[0].locator)\""
        )
    }

    /// Same street southbound: the sides must flip. A track authored for one
    /// direction is walked both ways; the locator is computed per traveler.
    func testWalkStreetReversed_sidesFlip() {
        let spot = JourneySimulator.SimSpot(
            id: "s0", title: "Cafe",
            // 15m north of an east-west street: left when walking east...
            coordinate: TestFixtures.offset(base, eastM: 300, northM: 15),
            radiusM: 40, narrationS: 30
        )
        let east = JourneySimulator(
            spots: [spot],
            path: [base, TestFixtures.offset(base, eastM: 600, northM: 0)],
            config: .init(speedMps: 1.4, mode: "walking")
        )
        east.run(extraIdleS: 60)
        XCTAssertEqual(east.events.count, 1)
        XCTAssertTrue(
            east.events[0].locator.contains("on your left"),
            "eastbound, a spot north of the street is on the LEFT: \"\(east.events[0].locator)\""
        )

        let west = JourneySimulator(
            spots: [spot],
            path: [TestFixtures.offset(base, eastM: 600, northM: 0), base],
            config: .init(speedMps: 1.4, mode: "walking")
        )
        west.run(extraIdleS: 60)
        XCTAssertEqual(west.events.count, 1)
        XCTAssertTrue(
            west.events[0].locator.contains("on your right"),
            "westbound, the same spot is on the RIGHT: \"\(west.events[0].locator)\""
        )
    }

    /// Driving a road with spots set back on either side (±20m at 30mph):
    /// sides still called correctly at speed, nothing "straight ahead",
    /// nothing announced behind.
    func testDriveRoad_flankingSpotsKeepTheirSides() {
        let layout: [(x: Double, northM: Double)] = [(500, 20), (1200, -20), (1900, 20)]
        let spots = layout.enumerated().map { i, p in
            JourneySimulator.SimSpot(
                id: "s\(i)", title: "Spot \(i)",
                coordinate: TestFixtures.offset(base, eastM: p.x, northM: p.northM),
                radiusM: 60, narrationS: 40
            )
        }
        let sim = JourneySimulator(
            spots: spots,
            path: [base, TestFixtures.offset(base, eastM: 2500, northM: 0)],
            config: .init(speedMps: 13.4, mode: "driving")
        )
        sim.run(extraIdleS: 60)

        XCTAssertEqual(sim.events.count, 3, "spaced road spots should all play")
        for e in sim.events {
            let expectLeft = layout[Int(e.spotId.dropFirst())!].northM > 0
            XCTAssertTrue(
                e.locator.contains(expectLeft ? "on your left" : "on your right"),
                "\(e.title): \"\(e.locator)\""
            )
            XCTAssertFalse(e.locator.contains("straight ahead"), "\(e.title): \"\(e.locator)\"")
        }
        assertNeverAnnouncedBehind(sim)
    }

    /// Dense street where narration overruns the spacing (skips happen), the
    /// queueing/direction interplay: decisions land at arbitrary points, so
    /// spots play from wherever the traveler happens to stand — including
    /// just-behind-but-still-inside-the-trigger, which is allowed. What must
    /// hold regardless: the SIDE is never wrong. North-of-street spots must
    /// never be called "right", south ones never "left", eastbound.
    func testWalkDenseStreet_sidesAreNeverWrong() {
        let spots = (0..<8).map { i in
            JourneySimulator.SimSpot(
                id: "s\(i)", title: "Spot \(i)",
                coordinate: TestFixtures.offset(
                    base, eastM: 100 + Double(i) * 60,
                    northM: i.isMultiple(of: 2) ? 12 : -12
                ),
                radiusM: 40, narrationS: 75
            )
        }
        let sim = JourneySimulator(
            spots: spots,
            path: [base, TestFixtures.offset(base, eastM: 700, northM: 0)],
            config: .init(speedMps: 1.4, mode: "walking")
        )
        sim.run(extraIdleS: 120)

        XCTAssertGreaterThanOrEqual(sim.events.count, 3)
        for e in sim.events {
            let north = Int(e.spotId.dropFirst())!.isMultiple(of: 2)
            let wrong = north ? "right" : "left" // eastbound: north = left
            XCTAssertFalse(
                e.locator.contains(wrong),
                "\(e.title) is on the \(north ? "left" : "right"), heard: \"\(e.locator)\""
            )
        }
    }
}
