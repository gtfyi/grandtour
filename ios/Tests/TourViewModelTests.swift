import CoreLocation
import XCTest

/// Run the real orchestration entry point and player state transitions, not
/// a mock eligibility closure. No app host, GPS or server is needed: snapshots
/// are supplied directly, history is isolated and quiet time is virtual.
@MainActor
final class TourViewModelTests: XCTestCase {
    nonisolated override class func setUp() {
        super.setUp()
        // Block background diagnostics and any accidental fetch for this test
        // process, including tasks that outlive an individual test method.
        URLProtocol.registerClass(TourTestOfflineProtocol.self)
    }

    func testPlayerBecomingIdleWhileExploringNeverAutoplaysRemoteSpots() {
        for style in [TourStyle.wander, .guided(trackSlug: "test-track")] {
            withModel(style: style) { model, history, advance in
                let remote = spot("remote", kind: "point")
                model.player.nowPlayingSpotId = "manual-browse-story"
                model.exploreMapCenter(CLLocationCoordinate2D(latitude: 48, longitude: 2), radiusM: 2000)
                // This is the response from the remote map center, not GPS.
                model.nearby = [remote]
                advance(60)
                model.player.nowPlayingSpotId = nil
                model.decideNext() // the same entry point as the player-idle sink
                XCTAssertNil(model.player.nowPlayingSpotId)
                XCTAssertEqual(history.playCount("remote"), 0)
                XCTAssertNil(model.upNext)
            }
        }
    }

    func testGuidedAreaPrerequisiteUnlocksStopThenAreaEpilogueFinishesTour() {
        withModel(style: .guided(trackSlug: "test-track")) { model, history, advance in
            let intro = spot("intro", kind: "area", index: 0)
            let stop = spot("stop", kind: "point", index: 1)
            let epilogue = spot("epilogue", kind: "area", index: 2)
            model.nearby = [epilogue, stop, intro]
            model.applyManifests([manifest(ids: ["intro", "stop", "epilogue"])])
            model.decideNext()
            XCTAssertEqual(model.player.nowPlayingSpotId, "intro", "a zero-meter area can start immediately at tour start")
            XCTAssertNil(model.upNext, "the point stop is gated by the unheard area intro")
            XCTAssertEqual(history.playCount("intro"), 1)
            model.player.stop()
            model.decideNext()
            XCTAssertNil(model.player.nowPlayingSpotId, "completion starts the pause")
            advance(15)
            model.decideNext()
            XCTAssertEqual(model.player.nowPlayingSpotId, "stop", "hearing the area introduction releases the stop")
            XCTAssertEqual(history.playCount("stop"), 1)

            model.player.stop()
            advance(31)
            model.decideNext()
            XCTAssertEqual(model.player.nowPlayingSpotId, "epilogue", "no point stops left must not bypass the ambient planner")
            XCTAssertEqual(history.playCount("epilogue"), 1)
            model.player.stop()
            advance(15)
            model.decideNext()
            XCTAssertEqual(model.player.nowPlayingSpotId, "cue:finished")
            model.player.stop()
            model.decideNext()
            XCTAssertNil(model.player.nowPlayingSpotId, "announce completion once")
        }
    }

    func testGuidedDoesNotFinishWithUnvisitedUnitsOutsideNearbyWindow() {
        withModel(style: .guided(trackSlug: "test-track")) { model, _, advance in
            model.nearby = [spot("local", kind: "point", index: 0)]
            model.applyManifests([manifest(ids: ["local", "distant"])])
            model.decideNext()
            XCTAssertEqual(model.player.nowPlayingSpotId, "local")
            model.player.stop()
            advance(31)
            model.decideNext()
            XCTAssertNil(model.player.nowPlayingSpotId, "the whole manifest, not just nearby, determines completion")
        }
    }

    func testOnlyOneTrackThenAllOffClearsPlaybackAndPersistsEmptySelection() async {
        let suite = "TrackSelectionTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        let oldStyle = TourStyle.current
        let model = TourViewModel(history: PlayHistory(defaults: defaults), selectionDefaults: defaults)
        defer {
            model.stopTour()
            model.returnToHere(nil)
            TourStyle.current = oldStyle
            defaults.removePersistentDomain(forName: suite)
        }
        let item = spot("selected", kind: "point")
        model.allTracks = [item.track]
        model.nearby = [item]
        model.setEnabledTracks([item.track.slug, "other-track"])
        model.setEnabledTracks([item.track.slug])
        XCTAssertEqual(model.enabledTrackSlugs, [item.track.slug])
        XCTAssertEqual(model.nearby.count, 1)
        model.tourStyle = .guided(trackSlug: item.track.slug)
        model.player.nowPlayingSpotId = item.spot.id
        model.setEnabledTracks([])
        XCTAssertTrue(model.enabledTrackSlugs.isEmpty)
        XCTAssertTrue(model.nearby.isEmpty)
        XCTAssertNil(model.player.nowPlayingSpotId)
        XCTAssertEqual(model.tourStyle, .wander)
        let key = "enabledTracks:" + ServerPreference.currentURL.absoluteString
        XCTAssertEqual(defaults.stringArray(forKey: key), [])
        await model.loadTracks()
        XCTAssertTrue(model.enabledTrackSlugs.isEmpty, "Catalog refresh must not interpret All off as first launch")
        model.setEnabledTracks([item.track.slug, "other-track"])
        model.toggleTrack("other-track")
        XCTAssertEqual(model.enabledTrackSlugs, [item.track.slug])
    }

    func testLongStoryFinishesBeforePauseStartsAndMovedAwaySpotExpires() {
        withModel(style: .wander) { model, history, advance in
            let first = spot("first", kind: "point")
            let passed = spot("passed", kind: "point")
            model.nearby = [first]
            model.decideNext()
            XCTAssertEqual(model.player.nowPlayingSpotId, "first")
            advance(600)
            model.nearby = [passed]
            model.player.stop()
            model.decideNext()
            XCTAssertNil(model.player.nowPlayingSpotId)
            advance(14)
            model.decideNext()
            XCTAssertNil(model.player.nowPlayingSpotId)
            model.nearby = []
            advance(1)
            model.decideNext()
            XCTAssertNil(model.player.nowPlayingSpotId)
            XCTAssertEqual(history.playCount("passed"), 0)
            model.nearby = [spot("here-now", kind: "point")]
            model.decideNext()
            XCTAssertEqual(model.player.nowPlayingSpotId, "here-now")
        }
    }

    func testServerOnlySkipsUnvoicedPointsAndAreasWithoutMarkingThemHeard() {
        withModel(style: .wander) { model, history, advance in
            NarrationPreference.current = .serverOnly
            model.nearby = [spot("unvoiced-point", kind: "point"), spot("unvoiced-area", kind: "area")]
            advance(60)
            model.decideNext()
            XCTAssertNil(model.upNext)
            XCTAssertNil(model.player.nowPlayingSpotId)
            XCTAssertEqual(history.playCount("unvoiced-point"), 0)
            XCTAssertEqual(history.playCount("unvoiced-area"), 0)
        }
    }

    func testEagerGapStartsTheNextArrivedSpotAfterThreeSeconds() {
        withModel(style: .wander) { model, history, advance in
            NarrationGapPreference.current = .three
            model.nearby = [spot("first", kind: "point")]
            model.decideNext()
            XCTAssertEqual(model.player.nowPlayingSpotId, "first")
            model.nearby = [spot("next", kind: "point")]
            model.player.stop()
            advance(2)
            model.decideNext()
            XCTAssertNil(model.player.nowPlayingSpotId)
            advance(1)
            model.decideNext()
            XCTAssertEqual(model.player.nowPlayingSpotId, "next")
            XCTAssertEqual(history.playCount("next"), 1)
        }
    }

    func testAreaPlannerChoosesShorterStoryThatFitsAvailableTime() {
        withModel(style: .wander) { model, _, _ in
            let short = spot("short", kind: "area")
            let longSource = spot("long", kind: "area")
            let original = longSource.content!
            let longContent = ContentPiece(id: original.id, locale: original.locale, variant: original.variant,
                                           document: original.document, audioUrl: nil, durationMs: 180_000,
                                           source: original.source, provenance: nil)
            let long = NearbySpot(spot: longSource.spot, track: longSource.track, locating: nil,
                                  distanceM: 0, triggered: true,
                                  content: longContent, guide: nil)
            model.nearby = [long, short]
            XCTAssertEqual(model.pickAmbientSpot(budgetS: 30)?.spot.id, "short")
            XCTAssertNil(model.pickAmbientSpot(budgetS: 1))
        }
    }

    func testFreshGPSStartsKnownArrivalWithoutWaitingForServerOrPinnedDownload() async {
        let suite = "GPSArrivalTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        let cacheDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(suite)
        let history = PlayHistory(defaults: defaults)
        let originalNarration = NarrationPreference.current
        let originalStyle = TourStyle.current
        NarrationPreference.current = .serverWhenAvailable
        let model = TourViewModel(history: history, selectionDefaults: defaults,
                                  cache: TourCache(directory: cacheDirectory))
        defer {
            model.stopTour()
            NarrationPreference.current = originalNarration
            TourStyle.current = originalStyle
            defaults.removePersistentDomain(forName: suite)
            try? FileManager.default.removeItem(at: cacheDirectory)
        }
        model.tourStyle = .wander
        model.setEnabledTracks(["test-track"])
        model.startTour(at: nil)
        TourDiagnostics.shared.enabled = false
        // This snapshot was fetched before entering the 35-meter trigger.
        // The server is unavailable and there is no pinned or rolling cache.
        model.nearby = [TestFixtures.nearbySpot(id: "arrival", title: "arrival", center: TestFixtures.base,
                                              radiusM: 35, distanceM: 100, triggered: false)]
        await model.locationDidUpdate(TestFixtures.location(TestFixtures.base, course: 90, speed: 18))
        XCTAssertEqual(history.playCount("arrival"), 1)
        XCTAssertEqual(model.player.nowPlayingSpotId, "arrival")
    }

    private func withModel(
        style: TourStyle,
        _ body: (TourViewModel, PlayHistory, (TimeInterval) -> Void) -> Void
    ) {
        let suite = "TourViewModelTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        let history = PlayHistory(defaults: defaults)
        var clock = Date()
        let originalStyle = TourStyle.current
        let originalGap = NarrationGapPreference.current
        let originalNarration = NarrationPreference.current
        NarrationPreference.current = .serverWhenAvailable
        NarrationGapPreference.current = .fifteen
        let model = TourViewModel(history: history, now: { clock }, selectionDefaults: defaults)
        model.tourStyle = style
        model.startTour(at: nil)
        // These tests are local; do not upload synthetic journeys.
        TourDiagnostics.shared.enabled = false
        defer {
            model.stopTour()
            model.returnToHere(nil) // cancel a pending explore fetch
            TourStyle.current = originalStyle
            NarrationGapPreference.current = originalGap
            NarrationPreference.current = originalNarration
            defaults.removePersistentDomain(forName: suite)
        }
        body(model, history, { clock = clock.addingTimeInterval($0) })
    }

    private func manifest(ids: [String]) -> TrackManifest {
        TrackManifest(
            trackId: "track-1", slug: "test-track", lifecycle: "evergreen", contentUpdatedAt: nil,
            units: ids.enumerated().map { TrackManifestUnit(id: $0.element, sequenceKey: "story", sequenceIndex: $0.offset) }
        )
    }

    private func spot(_ id: String, kind: String, index: Int? = nil) -> NearbySpot {
        let source = TestFixtures.nearbySpot(
            id: id, title: id, center: TestFixtures.base, radiusM: 35, distanceM: 0, triggered: true
        )
        return NearbySpot(
            spot: Spot(
                id: id, trackId: source.spot.trackId, title: id, subtitle: "",
                trigger: GeoTrigger(kind: kind, center: source.spot.trigger.center, radiusM: 35, region: nil),
                sequence: index.map { SpotSequence(key: "story", index: $0) },
                modes: [], status: "published", locating: nil
            ), track: source.track, locating: nil, distanceM: 0, triggered: true,
            content: source.content, guide: nil
        )
    }
}

private final class TourTestOfflineProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet)) }
    override func stopLoading() {}
}
