import XCTest

final class ActivityModeDetectorTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_700_000_000)

    /// Feed one fix per second at `speed` for `seconds`; return the last change.
    private func run(_ d: inout ActivityModeDetector, speed: Double, seconds: Int, from start: Int = 0) -> String? {
        var last: String?
        for i in start..<(start + seconds) {
            if let m = d.observe(speedMps: speed, at: t0.addingTimeInterval(Double(i))) { last = m }
        }
        return last
    }

    func testSustainedCarSpeedBecomesDriving() {
        var d = ActivityModeDetector()
        XCTAssertEqual(d.current, "walking")
        XCTAssertNil(run(&d, speed: 13, seconds: 5), "five fixes over 4s is not enough evidence")
        XCTAssertEqual(run(&d, speed: 13, seconds: 10, from: 5), "driving")
        XCTAssertEqual(d.current, "driving")
    }

    func testRedLightDoesNotFlipBackToWalking() {
        var d = ActivityModeDetector()
        _ = run(&d, speed: 13, seconds: 20)
        XCTAssertEqual(d.current, "driving")
        // 8 seconds stopped inside a 20s window: the median stays fast.
        XCTAssertNil(run(&d, speed: 0, seconds: 8, from: 20))
        XCTAssertEqual(d.current, "driving")
    }

    func testParkedThenWalkingReturnsToWalking() {
        var d = ActivityModeDetector()
        _ = run(&d, speed: 13, seconds: 20)
        XCTAssertEqual(run(&d, speed: 1.3, seconds: 25, from: 20), "walking")
    }

    func testCyclingBandIsNeverInferred() {
        var d = ActivityModeDetector()
        XCTAssertNil(run(&d, speed: 5, seconds: 40))
        XCTAssertEqual(d.current, "walking")
    }

    func testUnknownSpeedIsIgnored() {
        var d = ActivityModeDetector()
        XCTAssertNil(run(&d, speed: -1, seconds: 40))
        XCTAssertEqual(d.current, "walking")
    }

    func testPreferenceRoundTripsAndRejectsGarbage() {
        let defaults = UserDefaults(suiteName: "ActivityModeDetectorTests-\(UUID())")!
        XCTAssertEqual(ActivityModePreference.load(from: defaults), ActivityModePreference.auto)
        ActivityModePreference.save("driving", to: defaults)
        XCTAssertEqual(ActivityModePreference.load(from: defaults), "driving")
        defaults.set("hovercraft", forKey: "activityModePreference")
        XCTAssertEqual(ActivityModePreference.load(from: defaults), ActivityModePreference.auto)
    }
}
