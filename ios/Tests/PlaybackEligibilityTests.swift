import XCTest

final class PlaybackEligibilityTests: XCTestCase {
    func testRealManifestGatesOutOfRangePredecessorsAndScopesKeysByTrack() throws {
        // Exercise the wire shape both phone and watch decode, including gaps
        // in sequence indexes and another track using the same sequence key.
        let data = Data("""
        [
          {"trackId":"a","slug":"a","lifecycle":"series","units":[
            {"id":"a3","sequenceKey":"story","sequenceIndex":30},
            {"id":"a1","sequenceKey":"story","sequenceIndex":10},
            {"id":"a2","sequenceKey":"story","sequenceIndex":20}]},
          {"trackId":"b","slug":"b","lifecycle":"evergreen","units":[
            {"id":"b1","sequenceKey":"story","sequenceIndex":10}]}
        ]
        """.utf8)
        let policy = PlaybackEligibility(manifests: try JSONDecoder().decode([TrackManifest].self, from: data))
        var heard = Set<String>()
        let spot = TestFixtures.nearbySpot(id: "a3", title: "Chapter 3", center: TestFixtures.base, radiusM: 35, distanceM: 0, triggered: true)
        let scheduler = SpotScheduler()
        var ctx = SpotScheduler.Context(
            location: TestFixtures.location(TestFixtures.base),
            lastPlayedAt: { heard.contains($0) ? Date().addingTimeInterval(-86400) : nil },
            playCount: { heard.contains($0) ? 1 : 0 },
            isEligible: { policy.isSequenceEligible($0, playCount: { heard.contains($0) ? 1 : 0 }) },
            neverReplays: { policy.seriesUnitIds.contains($0) }
        )
        XCTAssertNil(scheduler.plan(nearby: [spot], ctx: ctx).playNow)
        heard.insert("a2")
        XCTAssertNil(scheduler.plan(nearby: [spot], ctx: ctx).playNow, "every predecessor, not just the immediate one")
        heard.insert("a1")
        XCTAssertEqual(scheduler.plan(nearby: [spot], ctx: ctx).playNow?.spot.id, "a3")
        XCTAssertTrue(policy.isSequenceEligible("b1", playCount: { _ in 0 }), "another track's key must not block this one")
        heard.insert("a3")
        XCTAssertNil(scheduler.plan(nearby: [spot], ctx: ctx).playNow, "series stays retired past cooldown")
        ctx.neverReplays = { _ in false }
        XCTAssertEqual(scheduler.plan(nearby: [spot], ctx: ctx).playNow?.spot.id, "a3", "evergreen remains replayable")
    }
}
