import XCTest

final class NarrationGapTests: XCTestCase {
    func testEagerDefaultUpgradesOldFifteenSecondsAndAllowsExplicitLongerPause() {
        let suite = "NarrationGapTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        XCTAssertEqual(NarrationGapPreference.load(from: defaults), .three)
        defaults.set(15, forKey: "narrationGapSeconds")
        XCTAssertEqual(NarrationGapPreference.load(from: defaults), .three)
        defaults.set(30, forKey: "narrationGapSeconds")
        XCTAssertEqual(NarrationGapPreference.load(from: defaults), .thirty)
        defaults.set(15, forKey: "narrationGapSecondsV2")
        XCTAssertEqual(NarrationGapPreference.load(from: defaults), .fifteen)
    }

    func testSilenceBeginsAtCompletionAndInitialIdleAddsNoDelay() {
        var gap = NarrationGap()
        let start = Date(timeIntervalSince1970: 1000)
        XCTAssertFalse(gap.observe(nil, at: start))
        XCTAssertEqual(gap.remaining(at: start, seconds: 15), 0)
        XCTAssertFalse(gap.observe("long-story", at: start))
        let end = start.addingTimeInterval(600)
        XCTAssertTrue(gap.observe(nil, at: end))
        XCTAssertEqual(gap.remaining(at: end.addingTimeInterval(14), seconds: 15), 1)
        XCTAssertEqual(gap.remaining(at: end.addingTimeInterval(15), seconds: 15), 0)
        XCTAssertFalse(gap.observe(nil, at: end.addingTimeInterval(16)))
        XCTAssertEqual(gap.remaining(at: end.addingTimeInterval(20), seconds: 30), 10)
    }
}
