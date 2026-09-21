import CoreLocation
import XCTest
@testable import GrandTour

/// The demo's route geometry, its car and its pace rule — the phone's half
/// of a feature the web app shares (packages/tour-viewer/src/simulate.ts).
@MainActor
final class DemoDriveTests: XCTestCase {
    private func coord(_ lat: Double, _ lng: Double) -> CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: lat, longitude: lng)
    }

    func testNearestNeighbourOrderVisitsEverySpotFromTheFirst() {
        let points = [coord(0, 0), coord(0, 0.03), coord(0, 0.01), coord(0.02, 0)]
        XCTAssertEqual(DemoRoute.nearestNeighborOrder(points), [0, 2, 1, 3])
        XCTAssertEqual(DemoRoute.nearestNeighborOrder([coord(1, 1), coord(2, 2)]), [0, 1])
        XCTAssertEqual(DemoRoute.nearestNeighborOrder([]), [])
    }

    func testPointAlongInterpolatesAndClampsToTheEnds() {
        let path = [coord(0, 0), coord(0, 0.01), coord(0.01, 0.01)]
        let cum = DemoRoute.cumulativeMeters(path)
        XCTAssertEqual(cum.count, 3)
        XCTAssertEqual(cum[0], 0)
        XCTAssertEqual(cum[1], 1_112, accuracy: 2)
        let half = DemoRoute.point(along: path, cumulativeM: cum, distanceM: cum[1] / 2)
        XCTAssertEqual(half.coordinate.longitude, 0.005, accuracy: 1e-6)
        XCTAssertEqual(half.headingDeg, 90, accuracy: 0.01)
        let north = DemoRoute.point(along: path, cumulativeM: cum, distanceM: cum[1] + 100)
        XCTAssertEqual(north.headingDeg, 0, accuracy: 0.01)
        XCTAssertEqual(DemoRoute.point(along: path, cumulativeM: cum, distanceM: -5).coordinate.longitude, 0)
        let end = DemoRoute.point(along: path, cumulativeM: cum, distanceM: 1e9).coordinate
        XCTAssertEqual(end.latitude, 0.01, accuracy: 1e-9)
    }

    func testDriveAdvancesWithTheClockAndParksAtTheEnd() {
        var clock = Date(timeIntervalSince1970: 1_000)
        let drive = DemoDrive(track: Self.track, route: [coord(0, 0), coord(0, 0.01)], mph: 25, now: { clock })
        var fixes: [CLLocation] = []
        drive.onFix = { fixes.append($0) }
        drive.start()
        XCTAssertTrue(drive.isMoving)
        XCTAssertEqual(fixes.count, 1, "setting off sends a fix at once")
        XCTAssertEqual(fixes[0].speed, 25 * 0.44704, accuracy: 1e-9)
        XCTAssertEqual(fixes[0].course, 90, accuracy: 0.01)
        clock = clock.addingTimeInterval(10)
        drive.tick()
        XCTAssertEqual(drive.distanceM, 111.76, accuracy: 0.01)
        XCTAssertEqual(fixes.count, 2)
        XCTAssertEqual(fixes[1].timestamp, clock)
        clock = clock.addingTimeInterval(1_000)
        drive.tick()
        XCTAssertTrue(drive.atEnd)
        XCTAssertFalse(drive.isMoving, "the car parks at the end of the route")
        XCTAssertEqual(fixes.last?.speed, 0)
        drive.start()
        XCTAssertEqual(drive.distanceM, 0, "driving again starts from the beginning")
        drive.pause()
    }

    func testPaceFollowsTheModeElseTheTracksSize() {
        XCTAssertEqual(DemoRoute.pace(spanKm: 55, preference: "walking"), 3)
        XCTAssertEqual(DemoRoute.pace(spanKm: 0.5, preference: "driving"), 25)
        XCTAssertEqual(DemoRoute.pace(spanKm: 0.5, preference: "cycling"), 10)
        XCTAssertEqual(DemoRoute.pace(spanKm: 0.5, preference: ActivityModePreference.auto), 3)
        XCTAssertEqual(DemoRoute.pace(spanKm: 55.4, preference: ActivityModePreference.auto), 25)
        XCTAssertEqual(DemoRoute.mode(forMph: 3), "walking")
        XCTAssertEqual(DemoRoute.mode(forMph: 15), "walking")
        XCTAssertEqual(DemoRoute.mode(forMph: 16), "driving")
        XCTAssertEqual(DemoRoute.mode(forMph: 25), "driving")
    }

    func testPlanPrefersTheAuthoredRouteThenRoadsThenStraightLines() async {
        let authored = bundle(routePath: [LngLat(lat: 1, lng: 1), LngLat(lat: 2, lng: 2), LngLat(lat: 3, lng: 3)])
        let planned = await DemoRoute.plan(for: authored) { _ in
            XCTFail("an authored route needs no router")
            return nil
        }
        XCTAssertEqual(planned.count, 3)
        XCTAssertEqual(planned[2].latitude, 3)

        let unrouted = bundle(routePath: nil)
        let straight = await DemoRoute.plan(for: unrouted) { _ in nil }
        XCTAssertEqual(straight.map(\.longitude), [0, 0.01, 0.03], "nearest first, straight lines when the router has nothing")
        let roads = await DemoRoute.plan(for: unrouted) { ordered in [ordered[0], self.coord(0, 0.005), ordered[1], ordered[2]] }
        XCTAssertEqual(roads.count, 4)

        let single = await DemoRoute.plan(for: bundle(routePath: nil, spots: 1)) { _ in nil }
        XCTAssertLessThan(single.count, 2, "one spot is nothing to drive")
    }

    private static let track = Track(
        id: "11111111-1111-4111-8111-111111111111", slug: "sample", name: "Sample", description: "",
        kind: "tour", lifecycle: "evergreen", icon: nil, color: nil, official: true, spotCount: 3
    )

    private func bundle(routePath: [LngLat]?, spots count: Int = 3) -> TrackDownloadBundle {
        let lngs = [0.0, 0.03, 0.01]
        let spots = (0..<count).map { i in
            TrackDownloadSpot(
                spot: Spot(id: "s\(i)", trackId: Self.track.id, title: "Spot \(i)", subtitle: "",
                           trigger: GeoTrigger(center: LngLat(lat: 0, lng: lngs[i]), radiusM: 40),
                           sequence: nil, modes: [], status: "published", locating: nil),
                content: []
            )
        }
        return TrackDownloadBundle(exportedAt: "2026-09-20T00:00:00Z", track: Self.track, spots: spots, routePath: routePath)
    }
}

@MainActor
final class DemoDriverTests: XCTestCase {
    private func coord(_ lat: Double, _ lng: Double) -> CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: lat, longitude: lng)
    }

    func testStopsFollowTheRouteInTravelOrder() {
        let route = [coord(0, 0), coord(0, 0.03)]
        let cum = DemoRoute.cumulativeMeters(route)
        let far = Self.spot("far", lng: 0.02)
        let near = Self.spot("near", lng: 0.005)
        let silent = Self.spot("silent", lng: 0.001, narratable: false)
        let stops = DemoRoute.stops(for: [far, silent, near], along: route, cumulativeM: cum)
        XCTAssertEqual(stops.map(\.spot.spot.id), ["near", "far"], "narratable spots only, nearest along the route first")
        XCTAssertEqual(stops[0].distanceM, 556, accuracy: 2)
        XCTAssertEqual(stops[1].distanceM, 2226, accuracy: 3)
        let drive = DemoDrive(track: Self.track, route: route, spots: [far, near], mph: 25)
        XCTAssertEqual(drive.nextStop(after: 600) { _ in true }?.spot.spot.id, "far")
        XCTAssertEqual(drive.nextStop(after: 0) { $0.spot.id != "near" }?.spot.spot.id, "far", "a heard stop is passed over")
        XCTAssertNil(drive.nextStop(after: 3000) { _ in true })
        drive.seek(to: 1_000)
        XCTAssertEqual(drive.distanceM, 1_000)
    }

    func testStepGoesStoryToStory() {
        typealias S = DemoRoute
        // A story just ended: wait out the story spacing, then jump to just before the next stop.
        XCTAssertEqual(S.step(item: false, playing: false, moving: true, distanceM: 100, totalM: 5000, nextM: 2000, idleS: 0, gapS: 3, leadM: 90), .none)
        XCTAssertEqual(S.step(item: false, playing: false, moving: true, distanceM: 100, totalM: 5000, nextM: 2000, idleS: 3, gapS: 3, leadM: 90), .seek(1910))
        // Driving in: keep going, or set off again if parked; at the stop, play it.
        XCTAssertEqual(S.step(item: false, playing: false, moving: true, distanceM: 1950, totalM: 5000, nextM: 2000, idleS: 3, gapS: 3, leadM: 90), .none)
        XCTAssertEqual(S.step(item: false, playing: false, moving: false, distanceM: 1950, totalM: 5000, nextM: 2000, idleS: 3, gapS: 3, leadM: 90), .resume)
        XCTAssertEqual(S.step(item: false, playing: false, moving: true, distanceM: 2000, totalM: 5000, nextM: 2000, idleS: 3, gapS: 3, leadM: 90), .play)
        // While a story plays the car never passes the next stop, and moves again once it may.
        XCTAssertEqual(S.step(item: true, playing: true, moving: true, distanceM: 2000, totalM: 5000, nextM: 2000, idleS: nil, gapS: 3, leadM: 90), .park)
        XCTAssertEqual(S.step(item: true, playing: true, moving: false, distanceM: 2000, totalM: 5000, nextM: 2000, idleS: nil, gapS: 3, leadM: 90), .none)
        XCTAssertEqual(S.step(item: true, playing: true, moving: false, distanceM: 1000, totalM: 5000, nextM: 2000, idleS: nil, gapS: 3, leadM: 90), .resume)
        XCTAssertEqual(S.step(item: true, playing: false, moving: false, distanceM: 1000, totalM: 5000, nextM: 2000, idleS: nil, gapS: 3, leadM: 90), .none)
        // No stop left: park at the end of the route once.
        XCTAssertEqual(S.step(item: false, playing: false, moving: true, distanceM: 100, totalM: 5000, nextM: nil, idleS: 3, gapS: 3, leadM: 90), .finish)
        XCTAssertEqual(S.step(item: false, playing: false, moving: false, distanceM: 5000, totalM: 5000, nextM: nil, idleS: 3, gapS: 3, leadM: 90), .none)
    }

    private static let track = Track(
        id: "22222222-2222-4222-8222-222222222222", slug: "sample", name: "Sample", description: "",
        kind: "tour", lifecycle: "evergreen", icon: nil, color: nil, official: true, spotCount: 3
    )

    private static func spot(_ id: String, lng: Double, narratable: Bool = true) -> NearbySpot {
        let spot = Spot(id: id, trackId: track.id, title: id, subtitle: "",
                        trigger: GeoTrigger(center: LngLat(lat: 0, lng: lng), radiusM: 40),
                        sequence: nil, modes: [], status: "published", locating: nil)
        let piece = ContentPiece(id: "c-\(id)", locale: "en", variant: "default",
                                 document: FiloDocument(id: "d-\(id)", text: "Story of \(id)", byteLength: 12, tiers: []),
                                 audioUrl: "https://data.example/audio/\(id).mp3", durationMs: 30_000, source: "human", provenance: nil)
        return NearbySpot(spot: spot, track: track, locating: nil, distanceM: 0, triggered: false,
                          content: narratable ? piece : nil, guide: nil)
    }
}
