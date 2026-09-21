import CoreLocation
import XCTest

/// Hold the real API request open while exercising the real cache and view
/// model. A saved tour must work before any network timeout or response.
@MainActor
final class OfflineTourTests: XCTestCase {
    func testColdLaunchHydratesSavedCatalogFillInsAndManifestBeforeNetworkReturns() async throws {
        let fixture = try await makeFixture(includeFillIns: true)
        defer { fixture.cleanUp() }
        XCTAssertTrue(fixture.model.allTracks.isEmpty)

        var completed = false
        let loading = Task {
            await fixture.model.loadTracks()
            completed = true
        }
        await fulfillment(of: [fixture.requestStarted], timeout: 2)

        XCTAssertFalse(completed, "The catalog request is deliberately still waiting")
        XCTAssertEqual(Set(fixture.model.allTracks.map(\.slug)), ["saved-tour", "saved-fillins"])
        XCTAssertEqual(fixture.model.enabledTrackSlugs, ["saved-tour", "saved-fillins"])
        XCTAssertEqual(fixture.model.fillInItems.map(\.id), ["saved-item"])
        XCTAssertEqual(fixture.model.manifests["saved-tour"]?.units.map(\.id), ["saved-stop"])
        XCTAssertEqual(fixture.model.manifests["saved-fillins"]?.units.map(\.id), ["saved-item"])

        fixture.observer.releaseWithNetworkFailure()
        await loading.value
        XCTAssertEqual(fixture.model.fillInItems.map(\.id), ["saved-item"])
        XCTAssertEqual(fixture.model.manifests["saved-tour"]?.units.count, 1)
    }

    func testDownloadedTriggersFollowGPSWhilePreviousNearbyRequestIsStillInFlight() async throws {
        let fixture = try await makeFixture(includeFillIns: false)
        defer { fixture.cleanUp() }
        fixture.model.refreshDownloadedContent()
        let outside = TestFixtures.offset(TestFixtures.base, eastM: -200, northM: 0)
        var firstRequestCompleted = false
        let firstRequest = Task {
            await fixture.model.locationDidUpdate(TestFixtures.location(outside, course: 90, speed: 15))
            firstRequestCompleted = true
        }
        await fulfillment(of: [fixture.requestStarted], timeout: 2)
        XCTAssertFalse(firstRequestCompleted)
        XCTAssertEqual(fixture.model.nearby.first?.triggered, false)

        // No clock advance: both the network single-flight guard and the
        // polling throttle must be bypassed for local geometry evaluation.
        await fixture.model.locationDidUpdate(TestFixtures.location(TestFixtures.base, course: 90, speed: 15))
        XCTAssertFalse(firstRequestCompleted)
        XCTAssertEqual(fixture.model.nearby.first?.spot.id, "saved-stop")
        XCTAssertEqual(fixture.model.nearby.first?.triggered, true)
        XCTAssertLessThan(fixture.model.nearby.first?.distanceM ?? .greatestFiniteMagnitude, 1)

        let passed = TestFixtures.offset(TestFixtures.base, eastM: 200, northM: 0)
        await fixture.model.locationDidUpdate(TestFixtures.location(passed, course: 90, speed: 15))
        XCTAssertEqual(fixture.model.nearby.first?.triggered, false)
        await fixture.model.locationDidUpdate(TestFixtures.location(TestFixtures.base, course: 270, speed: 15))
        XCTAssertEqual(fixture.model.nearby.first?.triggered, true)
        XCTAssertEqual(fixture.observer.requestCount, 1, "GPS updates must not launch parallel requests")

        // The old request eventually fails. Its original location must not
        // overwrite the newer GPS position used by the downloaded tour.
        fixture.observer.releaseWithNetworkFailure()
        await firstRequest.value
        XCTAssertTrue(fixture.model.isOffline)
        XCTAssertEqual(fixture.model.nearby.first?.triggered, true)
        XCTAssertLessThan(try XCTUnwrap(fixture.model.nearby.first?.distanceM), 1)
    }

    private func makeFixture(includeFillIns: Bool) async throws -> Fixture {
        let token = UUID().uuidString
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("OfflineTourTests-\(token)")
        let baseURL = URL(string: "https://offline-\(token.lowercased()).invalid")!
        let suite = "OfflineTourTests.\(token)"
        let defaults = UserDefaults(suiteName: suite)!
        let source = TestFixtures.nearbySpot(
            id: "saved-stop", title: "Saved stop", center: TestFixtures.base,
            radiusM: 35, distanceM: 0, triggered: false,
            trackId: "saved-tour-id", trackSlug: "saved-tour"
        )
        let content = try XCTUnwrap(source.content)
        var bundles = [TrackDownloadBundle(
            exportedAt: "2026-09-07T12:00:00Z", track: source.track,
            spots: [TrackDownloadSpot(spot: source.spot, content: [TrackDownloadContent(piece: content)])]
        )]
        if includeFillIns {
            let track = Track(
                id: "saved-fillins-id", slug: "saved-fillins", name: "Saved fillers", description: "",
                kind: "fillin", icon: nil, color: nil, official: false
            )
            let item = FillInItem(
                id: "saved-item", trackId: track.id, moduleType: "future-module", payload: .unknown,
                order: 1, content: content, status: "published"
            )
            bundles.append(TrackDownloadBundle(
                exportedAt: "2026-09-07T12:00:00Z", track: track, spots: [], fillInItems: [item]
            ))
        }
        let savedBundles = bundles
        let writer = TourCache(directory: directory, serverURL: { baseURL }, bundleFetcher: { _, track in
            try XCTUnwrap(savedBundles.first { $0.track.id == track.id })
        }, audioDownloader: { _ in
            XCTFail("Text-only fixtures must not download audio")
            throw URLError(.unsupportedURL)
        })
        for bundle in bundles {
            await writer.downloadTrack(bundle.track)
            XCTAssertEqual(writer.downloadState(for: bundle.track)?.phase, .downloaded)
        }
        // Recreate the cache so the test relies on durable files, not the
        // downloader's in-memory snapshots or passive cached responses.
        let reader = TourCache(directory: directory, serverURL: { baseURL })
        let requestStarted = expectation(description: "A request started and remains suspended")
        let observer = OfflineRequestObserver(started: requestStarted)
        OfflineHeldRequestProtocol.register(observer, host: baseURL.host!)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [OfflineHeldRequestProtocol.self]
        let session = URLSession(configuration: configuration)
        let previousStyle = TourStyle.current
        let model = TourViewModel(
            history: PlayHistory(defaults: defaults), now: { Date(timeIntervalSince1970: 1_000_000) },
            selectionDefaults: defaults, cache: reader,
            api: GrandTourAPI(baseURL: baseURL, session: session)
        )
        model.tourStyle = .wander
        model.modePreference = "driving"
        return Fixture(
            model: model, session: session, directory: directory, defaults: defaults, suite: suite,
            host: baseURL.host!, previousStyle: previousStyle, requestStarted: requestStarted, observer: observer
        )
    }

    @MainActor
    private struct Fixture {
        let model: TourViewModel
        let session: URLSession
        let directory: URL
        let defaults: UserDefaults
        let suite: String
        let host: String
        let previousStyle: TourStyle
        let requestStarted: XCTestExpectation
        let observer: OfflineRequestObserver

        func cleanUp() {
            session.invalidateAndCancel()
            model.stopTour()
            TourStyle.current = previousStyle
            OfflineHeldRequestProtocol.unregister(host: host)
            defaults.removePersistentDomain(forName: suite)
            try? FileManager.default.removeItem(at: directory)
        }
    }
}

private final class OfflineRequestObserver {
    private let lock = NSLock()
    private var count = 0
    private var released = false
    private var pending: [OfflineHeldRequestProtocol] = []
    private let started: XCTestExpectation

    init(started: XCTestExpectation) { self.started = started }

    var requestCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return count
    }

    func requestDidStart(_ request: OfflineHeldRequestProtocol) {
        lock.lock()
        count += 1
        let first = count == 1
        let shouldFail = released
        if !shouldFail { pending.append(request) }
        lock.unlock()
        if first { started.fulfill() }
        if shouldFail { request.failWithoutNetwork() }
    }

    func releaseWithNetworkFailure() {
        lock.lock()
        released = true
        let requests = pending
        pending = []
        lock.unlock()
        // loadTracks follows its failed catalog fetch with fill-in and
        // manifest fetches. Those also fail immediately, using a session
        // that remains valid until the entire operation has finished.
        for request in requests { request.failWithoutNetwork() }
    }
}

private final class OfflineHeldRequestProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var observers: [String: OfflineRequestObserver] = [:]

    static func register(_ observer: OfflineRequestObserver, host: String) {
        lock.lock()
        defer { lock.unlock() }
        observers[host] = observer
    }

    static func unregister(host: String) {
        lock.lock()
        defer { lock.unlock() }
        observers.removeValue(forKey: host)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lock.lock()
        let observer = Self.observers[request.url?.host ?? ""]
        Self.lock.unlock()
        observer?.requestDidStart(self)
        // URLSession stays suspended until the test releases its requests.
    }

    func failWithoutNetwork() {
        client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
    }

    override func stopLoading() {}
}
