import CoreLocation
import XCTest

/// End-to-end journeys through the scheduler at walking and driving speed.
/// Narration starts on approach or while still inside an authored trigger.
/// Unheard arrivals win over farther targets; places whose triggers have
/// already been left behind do not start.
final class JourneySimulationTests: XCTestCase {
    private let base = TestFixtures.base

    /// A spot may start while the traveler stands at it (within `hereM` of
    /// its coordinates) — but never once they've gone past it.
    private func assertNeverStartsBehind(
        _ sim: JourneySimulator,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        for e in sim.events {
            guard let along = e.alongM else { continue }
            XCTAssertGreaterThanOrEqual(
                along, -SpotScheduler.hereM,
                "\(e.title) started \(Int(-along))m behind the traveler at t=\(Int(e.timeS))s",
                file: file, line: line
            )
        }
    }

    /// Played spots must appear in travel order: once a spot is passed it is
    /// skipped, never revisited later.
    private func assertPlayedInTravelOrder(
        _ sim: JourneySimulator,
        spots: [JourneySimulator.SimSpot],
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let indexById = Dictionary(
            uniqueKeysWithValues: spots.enumerated().map { ($0.element.id, $0.offset) }
        )
        let playedIndexes = sim.events.compactMap { indexById[$0.spotId] }
        XCTAssertEqual(
            playedIndexes, playedIndexes.sorted(),
            "play order went backwards along the route: \(sim.events.map(\.title))",
            file: file, line: line
        )
    }

    /// Spots on a straight walk, spaced so each narration finishes before the
    /// next lead window: every spot plays, each starts while still AHEAD,
    /// and each starts early enough that the story wraps up about on arrival
    /// (the lead window), not only once the radius is crossed.
    func testWalkingSpacedSpots_everySpotStartsAheadWithinLead() {
        let spots = [250.0, 500, 750].enumerated().map { i, x in
            JourneySimulator.SimSpot(
                id: "s\(i)", title: "Spot \(i)",
                coordinate: TestFixtures.offset(base, eastM: x, northM: 0),
                radiusM: 35, narrationS: 30
            )
        }
        let sim = JourneySimulator(
            spots: spots,
            path: [base, TestFixtures.offset(base, eastM: 1000, northM: 0)],
            config: .init(speedMps: 1.4, mode: "walking")
        )
        sim.run(extraIdleS: 60)

        XCTAssertEqual(sim.events.count, 3, "all spaced spots should play")
        let leadM = (30 + SpotScheduler.arriveMarginS) * 1.4
        for e in sim.events {
            let along = try! XCTUnwrap(e.alongM)
            XCTAssertGreaterThan(along, 35, "\(e.title) should start before the radius, got \(Int(along))m")
            XCTAssertLessThanOrEqual(along, leadM + 3, "\(e.title) started too early: \(Int(along))m")
            XCTAssertTrue(e.locator.hasPrefix("Coming up in"), "locator should say it's ahead: \(e.locator)")
        }
        assertPlayedInTravelOrder(sim, spots: spots)
    }

    /// Dense spots with narration much longer than the gap between them: the
    /// traveler walks through several spots per story. Skips are expected;
    /// what must never happen is a story starting for a spot the traveler has
    /// already left behind.
    func testWalkingDenseSpots_skipsPassedSpotsInsteadOfNarratingBehind() {
        let spots = (0..<8).map { i in
            JourneySimulator.SimSpot(
                id: "s\(i)", title: "Spot \(i)",
                coordinate: TestFixtures.offset(base, eastM: 100 + Double(i) * 60, northM: 0),
                radiusM: 35, narrationS: 75
            )
        }
        let sim = JourneySimulator(
            spots: spots,
            path: [base, TestFixtures.offset(base, eastM: 700, northM: 0)],
            config: .init(speedMps: 1.4, mode: "walking")
        )
        sim.run(extraIdleS: 120)

        XCTAssertGreaterThanOrEqual(sim.events.count, 3, "a dense walk should still narrate regularly")
        assertNeverStartsBehind(sim)
        assertPlayedInTravelOrder(sim, spots: spots)
        XCTAssertFalse(
            sim.skippedSpotIds.isEmpty,
            "with 75s narrations every 60m some spots must be skipped, not narrated from behind"
        )
    }

    /// Driving with spots every 400m and 45s narrations (≈600m of travel per
    /// story). Whatever is behind the traveler when a story ends is skipped —
    /// at 30mph a "back on your left" spot is half a kilometer gone — and the
    /// next story is the one still ahead.
    func testDrivingDenseSpots_skipsWhatWasPassedMidStory() {
        let spots = (0..<5).map { i in
            JourneySimulator.SimSpot(
                id: "s\(i)", title: "Spot \(i)",
                coordinate: TestFixtures.offset(base, eastM: 300 + Double(i) * 400, northM: 0),
                radiusM: 60, narrationS: 45
            )
        }
        let sim = JourneySimulator(
            spots: spots,
            path: [base, TestFixtures.offset(base, eastM: 2500, northM: 0)],
            config: .init(speedMps: 13.4, mode: "driving")
        )
        sim.run(extraIdleS: 60)

        assertNeverStartsBehind(sim)
        assertPlayedInTravelOrder(sim, spots: spots)
        for e in sim.events {
            XCTAssertGreaterThan(
                try! XCTUnwrap(e.alongM), 20,
                "at driving speed \(e.title) must start while still ahead"
            )
        }
        // s0 opens at once (300m out, inside the 50s lead); its 45s story
        // covers ~600m, so s1 (700m) is still ahead and plays next; that one
        // ends past s2, which is skipped; s3 and s4 follow the same pattern.
        XCTAssertEqual(sim.events.map(\.spotId), ["s0", "s1", "s3", "s4"])
        XCTAssertEqual(sim.skippedSpotIds, ["s2"])
    }

    /// Sparse driving: narrations fit between triggers, so nothing is skipped
    /// and everything starts ahead.
    func testDrivingSparseSpots_everySpotStartsAhead() {
        let spots = [1000.0, 2000].enumerated().map { i, x in
            JourneySimulator.SimSpot(
                id: "s\(i)", title: "Spot \(i)",
                coordinate: TestFixtures.offset(base, eastM: x, northM: 0),
                radiusM: 60, narrationS: 40
            )
        }
        let sim = JourneySimulator(
            spots: spots,
            path: [base, TestFixtures.offset(base, eastM: 2600, northM: 0)],
            config: .init(speedMps: 13.4, mode: "driving")
        )
        sim.run(extraIdleS: 60)

        XCTAssertEqual(sim.events.count, 2)
        for e in sim.events {
            XCTAssertGreaterThan(try! XCTUnwrap(e.alongM), 20)
        }
    }

    /// Standing inside a trigger for ten minutes (with GPS jitter): the story
    /// plays once and never repeats while the traveler stays put.
    func testStandingStill_playsOnceAndNeverRepeats() {
        let center = TestFixtures.offset(base, eastM: 50, northM: 0)
        let spots = [JourneySimulator.SimSpot(
            id: "s0", title: "Here", coordinate: center, radiusM: 35, narrationS: 30
        )]
        let sim = JourneySimulator(
            spots: spots,
            path: [center],
            config: .init(speedMps: 1.4, mode: "walking", jitterM: 8)
        )
        sim.run(extraIdleS: 600)

        XCTAssertEqual(sim.events.count, 1, "standing still must not replay the spot")
    }

    /// Finishing a story right at the trigger boundary, then GPS jitter
    /// flapping across the radius line: no replay next to where it just
    /// played.
    func testBoundaryJitter_doesNotReplay() {
        let center = TestFixtures.offset(base, eastM: 34, northM: 0)
        let spots = [JourneySimulator.SimSpot(
            id: "s0", title: "Edge", coordinate: center, radiusM: 35, narrationS: 20
        )]
        let sim = JourneySimulator(
            spots: spots,
            path: [base],
            config: .init(speedMps: 1.4, mode: "walking", jitterM: 15)
        )
        sim.run(extraIdleS: 300)

        XCTAssertEqual(sim.events.count, 1, "boundary jitter replayed the spot")
    }

    /// Walk out past a spot, keep going, then double back minutes later: on
    /// the return leg the spot is ahead again, but the replay cooldown holds
    /// — the traveler heard this story a few minutes ago.
    func testLoopBack_sameOutingDoesNotReplay() {
        let spots = [JourneySimulator.SimSpot(
            id: "s0", title: "Loop", coordinate: TestFixtures.offset(base, eastM: 100, northM: 0),
            radiusM: 35, narrationS: 30
        )]
        let far = TestFixtures.offset(base, eastM: 300, northM: 0)
        let sim = JourneySimulator(
            spots: spots,
            path: [base, far, base],
            config: .init(speedMps: 1.4, mode: "walking")
        )
        sim.run(extraIdleS: 60)

        XCTAssertEqual(
            sim.events.count, 1,
            "the return leg is minutes later — the cooldown must hold the replay"
        )
    }

    /// A spot heard on a previous outing, longer ago than the cooldown,
    /// plays again when the traveler passes it — history deprioritizes and
    /// cools down; it never blacklists.
    func testPreplayedBeyondCooldown_playsAgain() {
        let spots = [JourneySimulator.SimSpot(
            id: "s0", title: "Yesterday", coordinate: TestFixtures.offset(base, eastM: 100, northM: 0),
            radiusM: 35, narrationS: 30
        )]
        let sim = JourneySimulator(
            spots: spots,
            path: [base, TestFixtures.offset(base, eastM: 300, northM: 0)],
            config: .init(
                speedMps: 1.4, mode: "walking",
                preplayed: ["s0": 24 * 3600.0]
            )
        )
        sim.run(extraIdleS: 60)

        XCTAssertEqual(sim.events.count, 1, "a spot heard yesterday should play again")
    }

    /// The same walk with the spot heard only an hour ago: silence.
    func testPreplayedWithinCooldown_staysSilent() {
        let spots = [JourneySimulator.SimSpot(
            id: "s0", title: "JustHeard", coordinate: TestFixtures.offset(base, eastM: 100, northM: 0),
            radiusM: 35, narrationS: 30
        )]
        let sim = JourneySimulator(
            spots: spots,
            path: [base, TestFixtures.offset(base, eastM: 300, northM: 0)],
            config: .init(
                speedMps: 1.4, mode: "walking",
                preplayed: ["s0": 3600]
            )
        )
        sim.run(extraIdleS: 60)

        XCTAssertTrue(
            sim.events.isEmpty,
            "a spot heard an hour ago must not replay: \(sim.events.map(\.title))"
        )
    }

    /// Two spots flanking the path so both open in the same poll, one heard
    /// yesterday and one never — narrations long enough that only one story
    /// fits the walk. The scheduler should spend it on the never-heard
    /// story, not reopen with yesterday's.
    func testFreshSpotWinsTheGap() {
        let spots = [
            JourneySimulator.SimSpot(
                id: "heard", title: "Heard", coordinate: TestFixtures.offset(base, eastM: 100, northM: 20),
                radiusM: 35, narrationS: 90
            ),
            JourneySimulator.SimSpot(
                id: "fresh", title: "Fresh", coordinate: TestFixtures.offset(base, eastM: 100, northM: -20),
                radiusM: 35, narrationS: 90
            ),
        ]
        let sim = JourneySimulator(
            spots: spots,
            path: [base, TestFixtures.offset(base, eastM: 400, northM: 0)],
            config: .init(
                speedMps: 1.4, mode: "walking",
                preplayed: ["heard": 24 * 3600.0]
            )
        )
        sim.run(extraIdleS: 120)

        XCTAssertEqual(
            sim.events.map(\.spotId), ["fresh"],
            "the never-heard story should win the walk"
        )
    }

    /// A heard spot near, a fresh spot far: the fresh one is the target all
    /// along (that's what "up next" shows), but the heard one still plays
    /// first as a filler — its short story ends long before the fresh spot's
    /// window opens, so it costs nothing.
    func testHeardSpotFillsTheGapWhenItFits() {
        let spots = [
            JourneySimulator.SimSpot(
                id: "heard", title: "Heard", coordinate: TestFixtures.offset(base, eastM: 100, northM: 0),
                radiusM: 35, narrationS: 30
            ),
            JourneySimulator.SimSpot(
                id: "fresh", title: "Fresh", coordinate: TestFixtures.offset(base, eastM: 400, northM: 0),
                radiusM: 35, narrationS: 30
            ),
        ]
        let sim = JourneySimulator(
            spots: spots,
            path: [base, TestFixtures.offset(base, eastM: 600, northM: 0)],
            config: .init(
                speedMps: 1.4, mode: "walking",
                preplayed: ["heard": 24 * 3600.0]
            )
        )
        sim.run(extraIdleS: 60)

        XCTAssertEqual(sim.events.map(\.spotId), ["heard", "fresh"])
        XCTAssertEqual(
            sim.targetLog.first?.spotId, "fresh",
            "up next should promise the unheard story from the start"
        )
        assertNeverStartsBehind(sim)
    }

    /// Same layout, but the heard spot's story is long enough to still be
    /// talking when the fresh spot's window opens: it must yield. The
    /// unheard story plays; the heard one is skipped this pass.
    func testHeardSpotYieldsWhenItWouldBlanketTheFreshOne() {
        let spots = [
            JourneySimulator.SimSpot(
                id: "heard", title: "Heard", coordinate: TestFixtures.offset(base, eastM: 100, northM: 0),
                radiusM: 35, narrationS: 90
            ),
            JourneySimulator.SimSpot(
                id: "fresh", title: "Fresh", coordinate: TestFixtures.offset(base, eastM: 160, northM: 0),
                radiusM: 35, narrationS: 30
            ),
        ]
        let sim = JourneySimulator(
            spots: spots,
            path: [base, TestFixtures.offset(base, eastM: 400, northM: 0)],
            config: .init(
                speedMps: 1.4, mode: "walking",
                preplayed: ["heard": 24 * 3600.0]
            )
        )
        sim.run(extraIdleS: 60)

        XCTAssertEqual(sim.events.map(\.spotId), ["fresh"])
    }

    /// While busy, prediction aims up next ahead. When the player actually
    /// becomes idle, a spot still inside its trigger can be recovered.
    func testUpNextWhilePlayingLooksPastTheCurrentStory() {
        let spots = [
            JourneySimulator.SimSpot(
                id: "first", title: "First", coordinate: TestFixtures.offset(base, eastM: 60, northM: 0),
                radiusM: 35, narrationS: 90
            ),
            JourneySimulator.SimSpot(
                id: "under", title: "Under", coordinate: TestFixtures.offset(base, eastM: 100, northM: 0),
                radiusM: 35, narrationS: 30
            ),
            JourneySimulator.SimSpot(
                id: "beyond", title: "Beyond", coordinate: TestFixtures.offset(base, eastM: 300, northM: 0),
                radiusM: 35, narrationS: 30
            ),
        ]
        let sim = JourneySimulator(
            spots: spots,
            path: [base, TestFixtures.offset(base, eastM: 500, northM: 0)],
            config: .init(speedMps: 1.4, mode: "walking")
        )
        sim.run(extraIdleS: 60)

        // "first" narrates for 90s ≈ 126m: "under" is now 26m behind,
        // still inside its 35m trigger, so it gets a turn before "beyond".
        XCTAssertEqual(sim.events.map(\.spotId), ["first", "under", "beyond"])
        let recovered = try! XCTUnwrap(sim.events.first { $0.spotId == "under" })
        XCTAssertLessThanOrEqual(recovered.distanceM, 35)
        let firstStart = try! XCTUnwrap(sim.events.first?.timeS)
        let targetsDuringFirst = sim.targetLog.filter { $0.timeS > firstStart && $0.timeS < firstStart + 90 }
        XCTAssertFalse(
            targetsDuringFirst.contains { $0.spotId == "under" },
            "while First plays, Under must never be promised: \(targetsDuringFirst)"
        )
        XCTAssertTrue(targetsDuringFirst.contains { $0.spotId == "beyond" })
    }
}

/// Direct unit tests on SpotScheduler's eligibility, start window, ranking
/// and prediction geometry.
final class SpotSchedulerUnitTests: XCTestCase {
    private let base = TestFixtures.base

    private func spotAt(
        _ id: String, eastM: Double, northM: Double = 0, radiusM: Double = 35,
        triggered: Bool? = nil,
        trackId: String = "track-1", trackSlug: String = "test-track",
        narratable: Bool = true, hasContent: Bool = true
    ) -> NearbySpot {
        let c = TestFixtures.offset(base, eastM: eastM, northM: northM)
        let d = Geo.localDistanceM(from: base, to: c)
        return TestFixtures.nearbySpot(
            id: id, title: id, center: c, radiusM: radiusM,
            distanceM: d, triggered: triggered ?? (d <= radiusM),
            trackId: trackId, trackSlug: trackSlug,
            narratable: narratable, hasContent: hasContent
        )
    }

    /// Fixed "now" so history offsets in tests are exact.
    private let now = Date(timeIntervalSince1970: 1_000_000_000)

    private func ctx(
        courseDeg: Double?, speed: Double, mode: String = "walking",
        journeyRoute: [CLLocationCoordinate2D] = [],
        trackOrder: [String] = [], trackIdToSlug: [String: String] = [:],
        playedAgoS: [String: TimeInterval] = [:],
        playCounts: [String: Int] = [:],
        busyForS: TimeInterval = 0,
        nowPlayingId: String? = nil,
        narrationS: TimeInterval = 60
    ) -> SpotScheduler.Context {
        let now = self.now
        return SpotScheduler.Context(
            location: TestFixtures.location(base, course: courseDeg, speed: speed),
            courseDeg: courseDeg,
            mode: mode,
            journeyRoute: journeyRoute,
            trackOrder: trackOrder,
            trackIdToSlug: trackIdToSlug,
            now: now,
            lastPlayedAt: { id in playedAgoS[id].map { now.addingTimeInterval(-$0) } },
            playCount: { id in playCounts[id] ?? (playedAgoS[id] != nil ? 1 : 0) },
            busyForS: busyForS,
            nowPlayingId: nowPlayingId,
            durationS: { _ in narrationS }
        )
    }

    // ─── Ahead / behind ──────────────────────────────────────────────────────

    /// Heading east with one spot passed (100m behind) and one coming up
    /// (80m ahead): the ahead spot is the target; the passed one is not
    /// eligible at all — not saved for later.
    func testPlan_targetsAheadSpotAndIgnoresPassedOne() {
        let scheduler = SpotScheduler()
        let nearby = [spotAt("behind", eastM: -100), spotAt("ahead", eastM: 80)]
        let plan = scheduler.plan(nearby: nearby, ctx: ctx(courseDeg: 90, speed: 1.4))
        XCTAssertEqual(plan.target?.spot.id, "ahead")
        XCTAssertEqual(plan.playNow?.spot.id, "ahead", "80m at walking pace is inside the 65s lead")
    }

    /// Passing the center must not discard a still-valid authored arrival.
    func testPlan_spotWhoseCenterIsBehindStillPlaysInsideRadius() {
        let scheduler = SpotScheduler()
        let plan = scheduler.plan(
            nearby: [spotAt("just-passed", eastM: -20, radiusM: 35, triggered: true)],
            ctx: ctx(courseDeg: 90, speed: 1.4)
        )
        XCTAssertEqual(plan.target?.spot.id, "just-passed")
        XCTAssertEqual(plan.playNow?.spot.id, "just-passed")
    }

    func testDrivingArrivalWinsOverFartherPreferredUnheardStory() {
        let scheduler = SpotScheduler()
        let c = ctx(courseDeg: 90, speed: 18, mode: "driving",
                    trackOrder: ["preferred"], trackIdToSlug: ["preferred-id": "preferred"])
        let plan = scheduler.plan(nearby: [
            spotAt("farther", eastM: 800, trackId: "preferred-id", trackSlug: "preferred"),
            spotAt("here", eastM: -40, radiusM: 100)
        ], ctx: c)
        XCTAssertEqual(plan.target?.spot.id, "here")
        XCTAssertEqual(plan.playNow?.spot.id, "here")
    }

    func testDrivingArrivalExpiresOutsideItsTrigger() {
        let scheduler = SpotScheduler()
        let plan = scheduler.plan(nearby: [spotAt("passed", eastM: -110, radiusM: 100)],
                                  ctx: ctx(courseDeg: 90, speed: 18, mode: "driving"))
        XCTAssertNil(plan.playNow)
        XCTAssertNil(plan.target)
    }

    func testArrivalNeverInterruptsCurrentStoryOrBypassesHistory() {
        let scheduler = SpotScheduler()
        let arrived = spotAt("here", eastM: -20, radiusM: 100)
        let busy = ctx(courseDeg: 90, speed: 18, mode: "driving", busyForS: 40, nowPlayingId: "playing")
        XCTAssertNil(scheduler.plan(nearby: [arrived], ctx: busy).playNow)
        let heard = ctx(courseDeg: 90, speed: 18, mode: "driving", playedAgoS: ["here": 10])
        XCTAssertNil(scheduler.plan(nearby: [arrived], ctx: heard).playNow)
    }

    /// Within `hereM` of the coordinates the spot is "right here", not
    /// behind: GPS jitter alone spans that, and the story is for this place.
    func testPlan_spotWithinHereToleranceStillPlays() {
        let scheduler = SpotScheduler()
        let plan = scheduler.plan(
            nearby: [spotAt("here", eastM: -10, radiusM: 35, triggered: true)],
            ctx: ctx(courseDeg: 90, speed: 1.4)
        )
        XCTAssertEqual(plan.playNow?.spot.id, "here")
    }

    /// With no course (standing still, cold fix) "behind" is unknowable, so
    /// a triggered spot plays on the radius alone.
    func testPlan_unknownCourseTrustsTheTrigger() {
        let scheduler = SpotScheduler()
        let plan = scheduler.plan(
            nearby: [spotAt("somewhere", eastM: -30, radiusM: 35, triggered: true)],
            ctx: ctx(courseDeg: nil, speed: 0)
        )
        XCTAssertEqual(plan.playNow?.spot.id, "somewhere")
    }

    // ─── Start window ────────────────────────────────────────────────────────

    /// The lead window: a 60s story opens 65s out (≈91m walking) when the
    /// spot lies on the traveler's line — before the 35m radius.
    func testStartWindow_opensWithinLeadWhenHeadOn() {
        let scheduler = SpotScheduler()
        let c = ctx(courseDeg: 90, speed: 1.4, narrationS: 60)
        XCTAssertTrue(scheduler.isStartable(spotAt("near", eastM: 85), ctx: c))
        XCTAssertFalse(scheduler.isStartable(spotAt("far", eastM: 100), ctx: c))
        XCTAssertEqual(try XCTUnwrap(scheduler.opensInS(spotAt("far", eastM: 100), ctx: c)), (100 - 91) / 1.4, accuracy: 1)
    }

    /// Off to the side (outside radius + slack laterally) the lead window
    /// never opens, and it cannot reserve airtime. It becomes a target when
    /// the traveler changes path and enters its radius.
    func testStartWindow_lateralSpotWaitsForTheRadius() {
        let scheduler = SpotScheduler()
        let c = ctx(courseDeg: 90, speed: 1.4, narrationS: 60)
        let side = spotAt("side", eastM: 60, northM: 60)
        let plan = scheduler.plan(nearby: [side], ctx: c)
        XCTAssertNil(plan.target)
        XCTAssertNil(plan.playNow)
        var arrived = c
        arrived.location = TestFixtures.location(TestFixtures.offset(base, eastM: 50, northM: 40), course: 90, speed: 1.4)
        let local = TriggerEvaluator.reevaluate([side], at: arrived.location!)
        XCTAssertEqual(scheduler.plan(nearby: local, ctx: arrived).playNow?.spot.id, "side")
    }

    /// Standing still (a valid zero speed) opens no lead window — a red light
    /// must not start the story for 500m down the road. An invalid speed
    /// (no figure at all) falls back to the mode's typical pace.
    func testStartWindow_stationaryDoesNotOpenEarly() {
        let scheduler = SpotScheduler()
        let spot = spotAt("ahead", eastM: 50)
        XCTAssertFalse(scheduler.isStartable(spot, ctx: ctx(courseDeg: 90, speed: 0, narrationS: 60)))
        XCTAssertTrue(scheduler.isStartable(spot, ctx: ctx(courseDeg: 90, speed: -1, narrationS: 60)))
    }

    /// A long story still opens no more than `maxLeadS` early.
    func testStartWindow_leadIsCapped() {
        let scheduler = SpotScheduler()
        let c = ctx(courseDeg: 90, speed: 12, mode: "driving", narrationS: 180)
        let capM = (SpotScheduler.maxLeadS + SpotScheduler.arriveMarginS) * 12
        XCTAssertTrue(scheduler.isStartable(spotAt("in", eastM: capM - 20, radiusM: 60), ctx: c))
        XCTAssertFalse(scheduler.isStartable(spotAt("out", eastM: capM + 40, radiusM: 60), ctx: c))
    }

    // ─── Fillers and the gap budget ──────────────────────────────────────────

    /// The target's window is 100s away; a heard spot startable now with a
    /// 30s story fills the gap, and the budget for gap content is the time
    /// to the target's window.
    func testPlan_fillerPlaysWhenItFitsBeforeTarget() {
        let scheduler = SpotScheduler()
        let nearby = [spotAt("heard", eastM: 30), spotAt("fresh", eastM: 250)]
        let c = ctx(courseDeg: 90, speed: 1.4, playedAgoS: ["heard": 24 * 3600.0], narrationS: 30)
        let plan = scheduler.plan(nearby: nearby, ctx: c)
        XCTAssertEqual(plan.target?.spot.id, "fresh")
        XCTAssertEqual(plan.playNow?.spot.id, "heard")
        XCTAssertEqual(try XCTUnwrap(plan.targetOpensInS), (250 - 49) / 1.4, accuracy: 1)
    }

    /// Same, but the heard story would still be talking when the target's
    /// window opens: silence instead, with the remaining budget exposed for
    /// shorter gap content.
    func testPlan_fillerYieldsWhenItWouldNotFit() {
        let scheduler = SpotScheduler()
        let nearby = [spotAt("heard", eastM: 30), spotAt("fresh", eastM: 120)]
        let c = ctx(courseDeg: 90, speed: 1.4, playedAgoS: ["heard": 24 * 3600.0], narrationS: 60)
        let plan = scheduler.plan(nearby: nearby, ctx: c)
        XCTAssertEqual(plan.target?.spot.id, "fresh")
        XCTAssertNil(plan.playNow)
        XCTAssertEqual(try XCTUnwrap(plan.gapBudgetS), (120 - 91) / 1.4, accuracy: 1)
    }

    /// No target at all: the gap budget is unbounded.
    func testPlan_noTargetMeansUnboundedGap() {
        let scheduler = SpotScheduler()
        let plan = scheduler.plan(nearby: [], ctx: ctx(courseDeg: 90, speed: 1.4))
        XCTAssertNil(plan.target)
        XCTAssertNil(plan.gapBudgetS)
        XCTAssertTrue(scheduler.fits(duration: 600, budget: nil))
        XCTAssertFalse(scheduler.fits(duration: 30, budget: 30))
    }

    func testOffPathFreshTargetCannotBlockAStoryOnThePath() {
        let scheduler = SpotScheduler()
        let side = spotAt("side", eastM: 20, northM: 200)
        let here = spotAt("here", eastM: 20)
        let c = ctx(courseDeg: 90, speed: 1.4, playedAgoS: ["here": 86400], narrationS: 30)
        XCTAssertNil(scheduler.opensInS(side, ctx: c), "a path that misses the trigger has no arrival ETA")
        let plan = scheduler.plan(nearby: [side, here], ctx: c)
        XCTAssertEqual(plan.target?.spot.id, "here")
        XCTAssertEqual(plan.playNow?.spot.id, "here")
    }

    func testOffPathTargetDoesNotLetAReplayBlanketAnOnPathFreshStory() {
        let scheduler = SpotScheduler()
        let nearby = [
            spotAt("side", eastM: 20, northM: 200),
            spotAt("heard", eastM: 20), spotAt("fresh", eastM: 120)
        ]
        let c = ctx(courseDeg: 90, speed: 1.4, playedAgoS: ["heard": 86400], narrationS: 60)
        let plan = scheduler.plan(nearby: nearby, ctx: c)
        XCTAssertEqual(plan.target?.spot.id, "fresh")
        XCTAssertNil(plan.playNow)
        XCTAssertLessThan(plan.gapBudgetS ?? .infinity, 30)
    }

    func testLargeRadiusETAUsesTheActualPathIntersection() {
        let scheduler = SpotScheduler()
        let s = spotAt("offset", eastM: 150, northM: 80, radiusM: 100)
        let c = ctx(courseDeg: 90, speed: 1.4, narrationS: 1)
        XCTAssertEqual(try XCTUnwrap(scheduler.opensInS(s, ctx: c)), (150 - 60) / 1.4, accuracy: 2)
    }

    func testApproachFilterPreservesArrivalInsideAPointBoundary() {
        let ring = [(-100.0, -100.0), (100, -100), (100, 100), (-100, 100)].map { east, north in
            let c = TestFixtures.offset(base, eastM: east, northM: north)
            return LngLat(lat: c.latitude, lng: c.longitude)
        }
        let s = TestFixtures.nearbySpot(
            id: "boundary", title: "Boundary", center: TestFixtures.offset(base, eastM: 60, northM: 60),
            radiusM: 10, distanceM: 85, triggered: true, region: ring
        )
        let plan = SpotScheduler().plan(nearby: [s], ctx: ctx(courseDeg: 90, speed: 1.4))
        XCTAssertEqual(plan.target?.spot.id, "boundary")
        XCTAssertEqual(plan.playNow?.spot.id, "boundary")
    }

    func testTurningTowardAnOffPathSpotMakesItATarget() {
        let scheduler = SpotScheduler()
        let side = spotAt("side", eastM: 0, northM: 200)
        XCTAssertNil(scheduler.plan(nearby: [side], ctx: ctx(courseDeg: 90, speed: 1.4)).target)
        XCTAssertEqual(scheduler.plan(nearby: [side], ctx: ctx(courseDeg: 0, speed: 1.4)).target?.spot.id, "side")
    }

    // ─── Eligibility ─────────────────────────────────────────────────────────

    /// Content unpublished mid-walk: not eligible, silently and safely.
    func testPlan_ignoresSpotWhoseContentDisappeared() {
        let scheduler = SpotScheduler()
        let plan = scheduler.plan(nearby: [spotAt("gone", eastM: 50, hasContent: false)], ctx: ctx(courseDeg: 90, speed: 1.4))
        XCTAssertNil(plan.target)
    }

    /// A spot heard within the replay cooldown is ineligible; one heard
    /// longer ago is back.
    func testPlan_replayCooldown() {
        let scheduler = SpotScheduler()
        let recent = scheduler.plan(
            nearby: [spotAt("recent", eastM: 50)],
            ctx: ctx(courseDeg: 90, speed: 1.4, playedAgoS: ["recent": 3600])
        )
        XCTAssertNil(recent.target, "an hour-old play is within the cooldown")
        let stale = scheduler.plan(
            nearby: [spotAt("stale", eastM: 50)],
            ctx: ctx(courseDeg: 90, speed: 1.4, playedAgoS: ["stale": 7 * 3600.0])
        )
        XCTAssertEqual(stale.playNow?.spot.id, "stale", "beyond the cooldown the spot is eligible again")
    }

    /// What's playing never competes with itself.
    func testPlan_nowPlayingIsNotACandidate() {
        let scheduler = SpotScheduler()
        let plan = scheduler.plan(
            nearby: [spotAt("current", eastM: 20)],
            ctx: ctx(courseDeg: 90, speed: 1.4, busyForS: 30, nowPlayingId: "current")
        )
        XCTAssertNil(plan.target)
    }

    // ─── Ranking ─────────────────────────────────────────────────────────────

    /// Track preference outranks distance: a farther spot on the preferred
    /// track is the target over a nearer one on an unranked track.
    func testRanked_trackPreferenceBeatsDistance() {
        let scheduler = SpotScheduler()
        let nearby = [
            spotAt("near-other", eastM: 60, trackId: "t-b", trackSlug: "other"),
            spotAt("far-preferred", eastM: 200, trackId: "t-a", trackSlug: "preferred"),
        ]
        let c = ctx(
            courseDeg: 90, speed: 1.4,
            trackOrder: ["preferred"],
            trackIdToSlug: ["t-a": "preferred", "t-b": "other"]
        )
        XCTAssertEqual(scheduler.plan(nearby: nearby, ctx: c).target?.spot.id, "far-preferred")
    }

    /// Freshness outranks distance: a farther never-played spot is the
    /// target over a nearer one heard yesterday.
    func testRanked_neverPlayedBeatsPlayedYesterday() {
        let scheduler = SpotScheduler()
        let nearby = [spotAt("heard-near", eastM: 40), spotAt("fresh-far", eastM: 150)]
        let c = ctx(courseDeg: 90, speed: 1.4, playedAgoS: ["heard-near": 24 * 3600.0])
        XCTAssertEqual(scheduler.plan(nearby: nearby, ctx: c).target?.spot.id, "fresh-far")
    }

    /// Among played spots, the one heard longer ago ranks first.
    func testRanked_leastRecentlyPlayedFirstAmongPlayed() {
        let scheduler = SpotScheduler()
        let nearby = [spotAt("heard-recently", eastM: 40), spotAt("heard-long-ago", eastM: 150)]
        let c = ctx(
            courseDeg: 90, speed: 1.4,
            playedAgoS: ["heard-recently": 2 * 86_400.0, "heard-long-ago": 8 * 86_400.0]
        )
        XCTAssertEqual(scheduler.plan(nearby: nearby, ctx: c).target?.spot.id, "heard-long-ago")
    }

    /// Same freshness day-bucket: the less-often-played spot ranks first,
    /// even when it's farther.
    func testRanked_playCountBreaksSameDayTie() {
        let scheduler = SpotScheduler()
        let nearby = [spotAt("worn-near", eastM: 40), spotAt("rare-far", eastM: 150)]
        let c = ctx(
            courseDeg: 90, speed: 1.4,
            playedAgoS: ["worn-near": 3 * 86_400.0, "rare-far": 3 * 86_400.0 + 1800],
            playCounts: ["worn-near": 5, "rare-far": 1]
        )
        XCTAssertEqual(scheduler.plan(nearby: nearby, ctx: c).target?.spot.id, "rare-far")
    }

    /// Freshness outranks track preference: a never-played spot from an
    /// unranked track beats a preferred-track spot heard yesterday. Among
    /// equally fresh spots, the preferred track wins.
    func testRanked_freshnessBeatsTrackPreference() {
        let scheduler = SpotScheduler()
        let nearby = [
            spotAt("fresh-other", eastM: 40, trackId: "t-b", trackSlug: "other"),
            spotAt("heard-preferred", eastM: 150, trackId: "t-a", trackSlug: "preferred"),
        ]
        let c = ctx(
            courseDeg: 90, speed: 1.4,
            trackOrder: ["preferred"],
            trackIdToSlug: ["t-a": "preferred", "t-b": "other"],
            playedAgoS: ["heard-preferred": 24 * 3600.0]
        )
        XCTAssertEqual(scheduler.plan(nearby: nearby, ctx: c).target?.spot.id, "fresh-other")

        let bothFresh = ctx(
            courseDeg: 90, speed: 1.4,
            trackOrder: ["preferred"],
            trackIdToSlug: ["t-a": "preferred", "t-b": "other"]
        )
        XCTAssertEqual(scheduler.plan(nearby: nearby, ctx: bothFresh).target?.spot.id, "heard-preferred")
    }

    // ─── Prediction ──────────────────────────────────────────────────────────

    /// While busy, the target is chosen from the predicted position: a spot
    /// the traveler will have passed when the player frees up is not it.
    func testPrediction_targetIsAheadOfWhereTheStoryEnds() {
        let scheduler = SpotScheduler()
        let nearby = [spotAt("under", eastM: 40), spotAt("beyond", eastM: 150)]
        let c = ctx(courseDeg: 90, speed: 1.4, busyForS: 60, nowPlayingId: "x")
        let plan = scheduler.plan(nearby: nearby, ctx: c)
        XCTAssertEqual(plan.target?.spot.id, "beyond", "40m is behind the 84m predicted position")
        XCTAssertNil(plan.playNow, "nothing starts while the player is busy")
        let p = try! XCTUnwrap(plan.prediction)
        XCTAssertEqual(Geo.localDistanceM(from: base, to: p.coordinate), 84, accuracy: 2)
    }

    /// With an active journey route that turns a corner, prediction follows
    /// the route: the spot around the corner is the target, not the one dead
    /// ahead that straight-line reckoning would pick — and vice versa.
    func testPrediction_journeyRouteFollowsTheTurn() {
        let scheduler = SpotScheduler()
        let corner = TestFixtures.offset(base, eastM: 300, northM: 0)
        let route = [base, corner, TestFixtures.offset(base, eastM: 300, northM: 900)]
        // Traveler 250m along the eastbound leg, heading east at 12 m/s,
        // with 45s of story left (≈540m of travel).
        let pos = TestFixtures.offset(base, eastM: 250, northM: 0)
        let nearby = [
            ("dead-ahead", TestFixtures.offset(base, eastM: 900, northM: 0)),
            ("around-corner", TestFixtures.offset(base, eastM: 300, northM: 600)),
        ].map { id, c in
            TestFixtures.nearbySpot(
                id: id, title: id, center: c, radiusM: 60,
                distanceM: Geo.localDistanceM(from: pos, to: c),
                triggered: false
            )
        }
        func context(withRoute: Bool) -> SpotScheduler.Context {
            SpotScheduler.Context(
                location: TestFixtures.location(pos, course: 90, speed: 12),
                courseDeg: 90,
                mode: "driving",
                journeyRoute: withRoute ? route : [],
                busyForS: 45,
                nowPlayingId: "x"
            )
        }
        XCTAssertEqual(
            scheduler.plan(nearby: nearby, ctx: context(withRoute: true)).target?.spot.id,
            "around-corner", "route prediction should know about the turn"
        )
        XCTAssertEqual(
            scheduler.plan(nearby: nearby, ctx: context(withRoute: false)).target?.spot.id,
            "dead-ahead", "without a route, dead reckoning favors the straight-ahead spot"
        )
    }

    /// Route projection snaps to the nearest SEGMENT, so a traveler midway
    /// along a long straight leg advances from there, not from a far vertex.
    func testPrediction_routeSnapsToNearestSegment() throws {
        let route = [base, TestFixtures.offset(base, eastM: 1000, northM: 0)]
        let pos = TestFixtures.offset(base, eastM: 500, northM: 5)
        let r = try XCTUnwrap(SpotScheduler.pointAlongRoute(from: pos, aheadM: 100, route: route))
        let landed = Geo.localDistanceM(from: base, to: r.coordinate)
        XCTAssertEqual(landed, 600, accuracy: 2)
        XCTAssertEqual(r.bearingDeg, 90, accuracy: 1)
    }

    /// alongCourseM sign convention: positive ahead, negative behind,
    /// nil without a course.
    func testAlongCourseM_signs() throws {
        let scheduler = SpotScheduler()
        let ahead = spotAt("ahead", eastM: 100)
        let behind = spotAt("behind", eastM: -100)
        let east = ctx(courseDeg: 90, speed: 1.4)

        XCTAssertEqual(try XCTUnwrap(scheduler.alongCourseM(ahead, ctx: east)), 100, accuracy: 2)
        XCTAssertEqual(try XCTUnwrap(scheduler.alongCourseM(behind, ctx: east)), -100, accuracy: 2)
        XCTAssertNil(scheduler.alongCourseM(ahead, ctx: ctx(courseDeg: nil, speed: 0)))
    }

    /// Duration estimate: measured clip when known, else words at speaking
    /// pace plus scripted pauses, plus the locator intro.
    func testNarrationDuration() {
        XCTAssertEqual(NarrationDuration.seconds(forText: ""), 0)
        XCTAssertEqual(NarrationDuration.seconds(forText: "one two three four five"), 2, accuracy: 0.01)
        XCTAssertEqual(NarrationDuration.seconds(forText: "one two… three"), 1.2 + 2.5, accuracy: 0.01)
        let s = spotAt("s", eastM: 10)
        XCTAssertEqual(NarrationDuration.seconds(for: s), 4 / 2.5 + NarrationDuration.introS, accuracy: 0.01)
    }
}
