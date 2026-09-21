import CoreLocation
import XCTest

/// The SAME town on foot and by car, across app restarts and days. Each block
/// has three stories competing for airtime. A walk can now recover a second
/// story while still inside the trigger. A new fourth story is
/// published after three visits. History is the real disk-backed PlayHistory,
/// reloaded for every visit, rather than hand-authored "heard yesterday" flags.
final class RepeatedTownTests: XCTestCase {
    func testRepeatedWalksDiscoverFreshStories() { visitTown(modes: Array(repeating: "walking", count: 4)) }
    func testRepeatedDrivesDiscoverFreshStories() { visitTown(modes: Array(repeating: "driving", count: 4)) }
    func testWalkingThenDrivingSharesHistory() { visitTown(modes: ["walking", "driving", "walking", "driving"]) }

    private func visitTown(modes: [String], file: StaticString = #filePath, line: UInt = #line) {
        let suite = "RepeatedTownTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let start = Date()
        let base = TestFixtures.base
        let end = TestFixtures.offset(base, eastM: 5400, northM: 0)
        var spots = (0..<4).flatMap { block in
            (0..<3).map { story in townStory(block: block, story: story) }
        }
        // Unheard side-street content must not reserve the town's airtime.
        spots.append(JourneySimulator.SimSpot(
            id: "side-street", title: "Off the route",
            coordinate: TestFixtures.offset(base, eastM: 20, northM: 200),
            radiusM: 35, narrationS: 70, trackId: "favorite", trackSlug: "favorite"
        ))
        var heard = Set<String>()
        let visitOffsets: [TimeInterval] = [0, 2 * 3600, 24 * 3600, 48 * 3600]
        for (visit, mode) in modes.enumerated() {
            if visit == 3 { spots += (0..<4).map { townStory(block: $0, story: 3) } }
            let history = PlayHistory(defaults: defaults)
            let countsBefore = Dictionary(uniqueKeysWithValues: spots.map { ($0.id, history.playCount($0.id)) })
            let backwards = visit % 2 == 1
            let sim = JourneySimulator(
                spots: spots,
                path: backwards ? [end, base] : [base, end],
                config: .init(
                    speedMps: mode == "walking" ? 1.4 : 13.4, mode: mode,
                    trackOrder: ["favorite", "discovery"],
                    startDate: start.addingTimeInterval(visitOffsets[visit])
                ),
                history: history
            )
            sim.run()
            let ids = sim.events.map(\.spotId)
            XCTAssertGreaterThanOrEqual(ids.count, 4, "visit \(visit) (\(mode)): narrate every block: \(ids)", file: file, line: line)
            XCTAssertEqual(Set(ids).count, ids.count, "no repeats within a visit", file: file, line: line)
            XCTAssertFalse(ids.contains("side-street"), file: file, line: line)
            let blocks = ids.compactMap { Int($0.split(separator: "-").first ?? "") }
            XCTAssertEqual(Set(blocks), Set(0..<4), file: file, line: line)
            XCTAssertEqual(blocks, backwards ? blocks.sorted(by: >) : blocks.sorted(), file: file, line: line)
            // Additional recovered stories can exhaust a block earlier than
            // the old one-story-per-visit policy. Replays become legal only
            // after every available story at that block has been heard.
            var heardSoFar = heard
            for id in ids {
                let blockPrefix = String(id.split(separator: "-")[0]) + "-"
                let freshAtBlock = Set(spots.filter { $0.id.hasPrefix(blockPrefix) }.map(\.id)).subtracting(heardSoFar)
                if !freshAtBlock.isEmpty {
                    XCTAssertTrue(freshAtBlock.contains(id), "fresh stories at this block must beat replays: \(id)", file: file, line: line)
                }
                heardSoFar.insert(id)
            }
            if visit == 3 {
                for block in 0..<4 {
                    XCTAssertEqual(ids.first { $0.hasPrefix("\(block)-") }, "\(block)-3", "newly published stories beat the already-heard favorite track", file: file, line: line)
                }
            }
            for event in sim.events {
                let radius = spots.first { $0.id == event.spotId }!.radiusM
                XCTAssertTrue((event.alongM ?? 0) >= -SpotScheduler.hereM || event.distanceM <= radius, "started after leaving the trigger: \(event.title)", file: file, line: line)
                XCTAssertLessThanOrEqual(event.distanceM, (SpotScheduler.maxLeadS + SpotScheduler.arriveMarginS) * (mode == "walking" ? 1.4 : 13.4) + 5, file: file, line: line)
                XCTAssertEqual(history.playCount(event.spotId), countsBefore[event.spotId]! + 1, file: file, line: line)
            }
            heard.formUnion(ids)
        }
        XCTAssertEqual(heard.count, 16, "four visits discover all sixteen route stories", file: file, line: line)
    }

    private func townStory(block: Int, story: Int) -> JourneySimulator.SimSpot {
        JourneySimulator.SimSpot(
            id: "\(block)-\(story)", title: "Block \(block), story \(story)",
            coordinate: TestFixtures.offset(TestFixtures.base, eastM: Double(block + 1) * 1200, northM: 20 + Double(story)),
            radiusM: 35, narrationS: 70,
            trackId: story == 0 ? "favorite" : "discovery",
            trackSlug: story == 0 ? "favorite" : "discovery"
        )
    }
}
