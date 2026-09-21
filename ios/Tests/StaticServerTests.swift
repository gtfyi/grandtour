import CoreLocation
import XCTest
@testable import GrandTour

/// A static server — a site or a repository serving only `grandtour.json`
/// and its bundles, no API — must give a full tour: the index is the
/// catalog, bundles are fetched for the enabled tracks around the phone,
/// triggers are evaluated on the device, and server uploads are unavailable.
@MainActor
final class StaticServerTests: XCTestCase {
    private let base = URL(string: "https://static.example")!
    private let spotCenter = CLLocationCoordinate2D(latitude: 37.9871, longitude: -122.5889)

    func testIndexIsTheCatalogAndBundlesDriveNearbyWithoutAnAPI() async throws {
        let track = Track(id: "11111111-1111-4111-8111-111111111111", slug: "sample", name: "Sample", description: "",
                          kind: "tour", lifecycle: "evergreen", icon: nil, color: nil, official: true, spotCount: 1)
        let spot = Spot(id: "spot-1", trackId: track.id, title: "Town Hall", subtitle: "",
                        trigger: GeoTrigger(center: LngLat(lat: spotCenter.latitude, lng: spotCenter.longitude), radiusM: 40),
                        sequence: nil, modes: [], status: "published", locating: nil)
        let piece = ContentPiece(id: "c-1", locale: "en", variant: "default",
                                 document: FiloDocument(id: "d-1", text: "Town Hall story", byteLength: 15, tiers: []),
                                 audioUrl: "https://data.example/audio/abc.mp3", durationMs: 30_000, source: "human", provenance: nil)
        let bundle = TrackDownloadBundle(exportedAt: "2026-09-19T00:00:00Z", track: track,
                                         spots: [TrackDownloadSpot(spot: spot, content: [TrackDownloadContent(piece: piece)])])
        let cell = AreaId.encode(lat: spotCenter.latitude, lng: spotCenter.longitude)
        let index = """
        {"formatVersion":1,"generatedAt":"2026-09-19T00:00:00.000Z","name":"Test","tracks":[
          {"id":"\(track.id)","slug":"sample","name":"Sample","description":"","lifecycle":"evergreen","official":true,
           "url":"tours/sample.grandtour.json","spotCount":1,"voicedCount":1,"minutes":0.5,
           "center":{"lat":\(spotCenter.latitude),"lng":\(spotCenter.longitude)},"spanKm":0,"areas":["\(cell)"],
           "hash":"\(String(repeating: "b", count: 64))","bytes":10,"createdAt":"2026-01-01T00:00:00.000Z"}]}
        """
        StaticServerProtocol.reset(routes: [
            "/health": (404, Data()),
            "/grandtour.json": (200, Data(index.utf8)),
            "/tours/sample.grandtour.json": (200, try JSONEncoder.iso.encode(bundle)),
        ])
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StaticServerProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        GrandTourAPI.resetProbes()
        let api = GrandTourAPI(baseURL: base, session: session)

        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("StaticServerTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let suite = "StaticServerTests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        addTeardownBlock {
            defaults.removePersistentDomain(forName: suite)
            try? FileManager.default.removeItem(at: directory)
        }
        let cache = TourCache(directory: directory, serverURL: { self.base },
                              bundleFetcher: { api, track in try await api.trackDownloadBundle(track: track) },
                              audioDownloader: { _ in
                                  XCTFail("A fetched bundle must not download audio; it streams until the user asks")
                                  throw URLError(.unsupportedURL)
                              })
        let previousStyle = TourStyle.current
        defer { TourStyle.current = previousStyle }
        let model = TourViewModel(history: PlayHistory(defaults: defaults), now: { Date(timeIntervalSince1970: 1_000_000) },
                                  selectionDefaults: defaults, cache: cache, api: api)
        model.tourStyle = .wander
        model.modePreference = "walking"

        await model.loadTracks()

        XCTAssertEqual(api.kind, .static)
        XCTAssertFalse(model.supportsRecordingUploads)
        XCTAssertEqual(model.allTracks.map(\.slug), ["sample"])
        XCTAssertEqual(model.enabledTrackSlugs, ["sample"], "first visit: every track on")
        XCTAssertTrue(cache.hasDownloadedTracks(trackSlugs: ["sample"]), "the bundle was fetched for evaluation")
        XCTAssertNil(cache.downloadState(for: track), "an evaluation-only bundle is not shown as a download")
        XCTAssertEqual(model.manifests["sample"]?.units.map(\.id), ["spot-1"], "manifests come from the bundle")

        await model.locationDidUpdate(CLLocation(coordinate: spotCenter, altitude: 0, horizontalAccuracy: 5, verticalAccuracy: 5,
                                                 course: 90, speed: 1.2, timestamp: Date(timeIntervalSince1970: 1_000_001)))
        XCTAssertEqual(model.nearby.map(\.spot.id), ["spot-1"])
        XCTAssertEqual(model.nearby.first?.triggered, true)
        XCTAssertEqual(model.nearby.first?.content?.audioUrl, "https://data.example/audio/abc.mp3", "audio URLs are taken as written")
        XCTAssertFalse(model.isOffline, "local evaluation is a static server's normal mode, not an outage")
        XCTAssertEqual(StaticServerProtocol.requested.filter { $0.hasPrefix("/api/") }, [], "the live API is never called")
        XCTAssertEqual(StaticServerProtocol.requested.filter { $0 == "/tours/sample.grandtour.json" }.count, 1, "one bundle fetch")
    }
}

/// Serves canned responses for one host and records every path asked for.
private final class StaticServerProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var routes: [String: (Int, Data)] = [:]
    private static var paths: [String] = []

    static func reset(routes: [String: (Int, Data)]) {
        lock.lock(); defer { lock.unlock() }
        self.routes = routes
        paths = []
    }
    static var requested: [String] {
        lock.lock(); defer { lock.unlock() }
        return paths
    }

    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "static.example" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let path = request.url?.path ?? ""
        let (status, body): (Int, Data) = {
            Self.lock.lock(); defer { Self.lock.unlock() }
            Self.paths.append(path)
            return Self.routes[path] ?? (404, Data())
        }()
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
