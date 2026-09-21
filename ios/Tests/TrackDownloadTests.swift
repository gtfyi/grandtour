import CoreLocation
import CryptoKit
import XCTest

@MainActor
final class TrackDownloadTests: XCTestCase {
    private let server = URL(string: "https://downloads.example")!

    private func directory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("TrackDownloadTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }

    private func track(_ id: String = "track", fillIn: Bool = false) -> Track {
        Track(id: id, slug: id, name: id, description: "", kind: fillIn ? "fillin" : "tour",
              lifecycle: "series", icon: nil, color: nil, official: true)
    }

    private func content(_ id: String, audio: String? = nil) -> ContentPiece {
        ContentPiece(id: id, locale: "en", variant: id,
                     document: FiloDocument(id: id, text: "Saved story", byteLength: 11, tiers: []),
                     audioUrl: audio, durationMs: 1000, source: "human", provenance: nil)
    }

    private func bundle(_ track: Track, audio: [String] = []) -> TrackDownloadBundle {
        let piece = audio.isEmpty ? [TrackDownloadContent(piece: content("text"))]
            : audio.enumerated().map { TrackDownloadContent(piece: content("variant-\($0.offset)", audio: $0.element)) }
        let spot = Spot(id: "spot-\(track.id)", trackId: track.id, title: "Distant stop", subtitle: "",
                        trigger: GeoTrigger(center: LngLat(lat: 10, lng: 10), radiusM: 100),
                        sequence: SpotSequence(key: "chapter", index: 7), modes: ["walking"], status: "published", locating: nil)
        return TrackDownloadBundle(exportedAt: "2026-09-07T00:00:00Z", track: track,
                                   spots: [TrackDownloadSpot(spot: spot, content: piece)])
    }

    private func cache(at directory: URL, bundle: TrackDownloadBundle, network: DownloadTestNetwork) -> TourCache {
        TourCache(directory: directory, serverURL: { self.server }, bundleFetcher: { _, _ in bundle },
                  audioDownloader: { try await network.download($0) })
    }

    func testInFlightAudioNeverReportsCompleteAndExplicitDownloadIgnoresDeviceVoice() async throws {
        let dir = try directory()
        let track = track()
        let url = "https://generation.example/narration.mp3"
        let network = DownloadTestNetwork()
        network.gatedPath = "/narration.mp3"
        let started = expectation(description: "audio request started")
        network.started = { started.fulfill() }
        let cache = cache(at: dir, bundle: bundle(track, audio: [url]), network: network)
        let previousVoice = NarrationPreference.current
        NarrationPreference.current = .deviceVoiceOnly
        defer { NarrationPreference.current = previousVoice }
        let task = Task { await cache.downloadTrack(track) }
        await fulfillment(of: [started], timeout: 3)
        let waiting = try XCTUnwrap(cache.downloadState(for: track))
        XCTAssertEqual(waiting.phase, .downloading)
        XCTAssertLessThan(waiting.completed, waiting.total)
        XCTAssertFalse(cache.hasDownloadedTracks(trackSlugs: [track.slug]))
        network.release()
        await task.value
        let saved = try XCTUnwrap(cache.downloadState(for: track))
        XCTAssertEqual(saved.phase, .downloaded)
        XCTAssertEqual(saved.completed, saved.total)
        // Audio URLs are absolute and fetched as written: the server names
        // where each recording lives (a bucket, a park service, itself).
        XCTAssertEqual(network.requests.map(\.host), ["generation.example"])
        XCTAssertNotNil(cache.localAudioURL(for: url))
    }

    func testFailedDownloadRetriesOnlyMissingFilesAndNeverPinsPartialTrack() async throws {
        let dir = try directory()
        let track = track()
        let urls = (0..<8).map { "https://generation.example/story-\($0).mp3" }
        let network = DownloadTestNetwork()
        network.failedPaths = ["/story-7.mp3"]
        let bundle = bundle(track, audio: urls)
        let cache = cache(at: dir, bundle: bundle, network: network)
        await cache.downloadTrack(track)
        let failed = try XCTUnwrap(cache.downloadState(for: track))
        XCTAssertEqual(failed.phase, .failed)
        XCTAssertLessThan(failed.completed, failed.total)
        XCTAssertFalse(cache.hasDownloadedTracks(trackSlugs: [track.slug]))
        let retained = urls.filter { cache.localAudioURL(for: $0) != nil }
        XCTAssertFalse(retained.isEmpty)
        let counts = Dictionary(grouping: network.requests, by: \.path).mapValues(\.count)
        network.failedPaths = []
        await cache.downloadTrack(track)
        XCTAssertEqual(cache.downloadState(for: track)?.phase, .downloaded)
        for url in retained {
            let path = URL(string: url)!.path
            XCTAssertEqual(network.requests.filter { $0.path == path }.count, counts[path], "Retry must keep successful files")
        }
        XCTAssertTrue(urls.allSatisfy { cache.localAudioURL(for: $0) != nil })
    }

    func testSavedMetadataSurvivesRelaunchExpiryAndLiveCacheReplacement() async throws {
        let dir = try directory()
        let track = track()
        let url = "https://generation.example/narration.mp3"
        let bundle = bundle(track, audio: [url])
        let cache = cache(at: dir, bundle: bundle, network: DownloadTestNetwork())
        await cache.downloadTrack(track)
        // Pin dates deliberately predate regular cache's 60-day expiration.
        let files = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: nil)!
        for case let file as URL in files where file.pathExtension == "json" {
            var object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
            object["downloadedAt"] = "2000-01-01T00:00:00Z"
            try JSONSerialization.data(withJSONObject: object).write(to: file)
        }
        let restored = self.cache(at: dir, bundle: bundle, network: DownloadTestNetwork())
        restored.refreshDownloadStates()
        restored.absorb(tracks: [])
        restored.absorb(manifests: [])
        restored.absorb(fillInItems: [])
        XCTAssertEqual(restored.downloadState(for: track)?.phase, .downloaded)
        XCTAssertEqual(restored.tracksFallback().map(\.id), [track.id])
        XCTAssertEqual(restored.manifestsFallback().first?.units.first?.sequenceIndex, 7)
        let nearby = restored.offlineNearby(at: CLLocation(latitude: 10, longitude: 10), radiusM: 200,
                                            trackSlugs: [track.slug], mode: "walking")
        XCTAssertEqual(nearby.map(\.id), ["spot-\(track.id)"])
        XCTAssertTrue(nearby[0].triggered)
        XCTAssertEqual(nearby[0].content?.document?.text, "Saved story")
        XCTAssertEqual(restored.cachedSpotCount, 1)
    }

    func testNewLiveRecordingSupersedesTextOnlyDownloadAfterRelaunch() async throws {
        let dir = try directory()
        let track = track()
        let saved = bundle(track)
        let cache = cache(at: dir, bundle: saved, network: DownloadTestNetwork())
        await cache.downloadTrack(track)
        let url = "https://generation.example/new-recording.mp3"
        let updated = bundle(track, audio: [url]).nearbySpots
        let previousVoice = NarrationPreference.current
        NarrationPreference.current = .deviceVoiceOnly
        defer { NarrationPreference.current = previousVoice }
        cache.absorb(updated)
        await Task.yield()

        for reader in [cache, self.cache(at: dir, bundle: saved, network: DownloadTestNetwork())] {
            let nearby = reader.offlineNearby(at: CLLocation(latitude: 10, longitude: 10), radiusM: 200,
                                             trackSlugs: [track.slug], mode: "walking")
            XCTAssertEqual(nearby.first?.content?.audioUrl, url,
                           "The old pinned text must not replace newly voiced nearby content")
            XCTAssertTrue(reader.hasDownloadedTracks(trackSlugs: [track.slug]))
        }
    }

    func testRedownloadSupersedesOlderNearbyResponse() async throws {
        let dir = try directory()
        let track = track()
        let url = "https://generation.example/redownloaded.mp3"
        let saved = bundle(track, audio: [url])
        let cache = cache(at: dir, bundle: saved, network: DownloadTestNetwork())
        cache.absorb(bundle(track).nearbySpots)
        await cache.downloadTrack(track)
        for reader in [cache, self.cache(at: dir, bundle: saved, network: DownloadTestNetwork())] {
            let nearby = reader.offlineNearby(at: CLLocation(latitude: 10, longitude: 10), radiusM: 200,
                                             trackSlugs: [track.slug], mode: "walking")
            XCTAssertEqual(nearby.first?.content?.audioUrl, url)
        }
    }

    func testFillInDownloadRemainsWholeAfterOnlineSampleAndRelaunch() async throws {
        let dir = try directory()
        let track = track(fillIn: true)
        let items = (0..<120).map { index in
            FillInItem(id: "item-\(index)", trackId: track.id, moduleType: "future", payload: .unknown,
                       order: index, content: content("item-\(index)"), status: "published")
        }
        let bundle = TrackDownloadBundle(exportedAt: "2026-09-07T00:00:00Z", track: track, spots: [], fillInItems: items)
        let cache = cache(at: dir, bundle: bundle, network: DownloadTestNetwork())
        await cache.downloadTrack(track)
        cache.absorb(fillInItems: Array(items.prefix(2)))
        cache.absorb(manifests: [])
        XCTAssertEqual(cache.fillInItemsFallback().count, 120)
        let restored = self.cache(at: dir, bundle: bundle, network: DownloadTestNetwork())
        XCTAssertEqual(restored.fillInItemsFallback().count, 120)
        XCTAssertEqual(restored.manifestsFallback().first?.units.count, 120)
        XCTAssertEqual(restored.downloadState(for: track)?.phase, .downloaded)
    }

    func testMissingAudioAfterRelaunchRequiresRetryButSavedTextStillWorks() async throws {
        let dir = try directory()
        let track = track()
        let url = "https://generation.example/story.mp3"
        let bundle = bundle(track, audio: [url])
        let cache = cache(at: dir, bundle: bundle, network: DownloadTestNetwork())
        await cache.downloadTrack(track)
        try FileManager.default.removeItem(at: XCTUnwrap(cache.localAudioURL(for: url)))
        let network = DownloadTestNetwork()
        let restored = self.cache(at: dir, bundle: bundle, network: network)
        restored.refreshDownloadStates()
        XCTAssertEqual(restored.downloadState(for: track)?.phase, .failed)
        XCTAssertTrue(restored.hasDownloadedTracks(trackSlugs: [track.slug]))
        XCTAssertEqual(restored.cachedSpotCount, 1, "Text remains available for the on-device voice")
        await restored.downloadTrack(track)
        XCTAssertEqual(restored.downloadState(for: track)?.phase, .downloaded)
        XCTAssertEqual(network.requests.count, 1)
    }

    func testCancellationDuringRequestNeverReportsDownloaded() async throws {
        let dir = try directory()
        let track = track()
        let network = DownloadTestNetwork()
        network.gatedPath = "/story.mp3"
        let started = expectation(description: "download started")
        network.started = { started.fulfill() }
        let cache = cache(at: dir, bundle: bundle(track, audio: ["https://example.com/story.mp3"]), network: network)
        let task = Task { await cache.downloadTrack(track) }
        await fulfillment(of: [started], timeout: 3)
        task.cancel()
        network.release()
        await task.value
        XCTAssertEqual(cache.downloadState(for: track)?.phase, .failed)
        XCTAssertFalse(cache.hasDownloadedTracks(trackSlugs: [track.slug]))
        XCTAssertLessThan(cache.downloadState(for: track)!.completed, cache.downloadState(for: track)!.total)
    }

    func testServerSwitchDiscardsCompletionAndDoesNotShareDownloadClaimsOrFiles() async throws {
        let dir = try directory()
        let track = track()
        let url = "https://generation.example/story.mp3"
        let bundle = bundle(track, audio: [url])
        let selection = DownloadTestServerSelection(url: server)
        let network = DownloadTestNetwork()
        network.gatedPath = "/story.mp3"
        let started = expectation(description: "download started on original server")
        network.started = { started.fulfill() }
        let cache = TourCache(directory: dir, serverURL: { selection.url }, bundleFetcher: { _, _ in bundle },
                              audioDownloader: { try await network.download($0) })
        let task = Task { await cache.downloadTrack(track) }
        await fulfillment(of: [started], timeout: 3)
        selection.url = URL(string: "https://other.example")!
        cache.refreshDownloadStates()
        network.release()
        await task.value
        XCTAssertNil(cache.downloadState(for: track))
        XCTAssertFalse(cache.hasDownloadedTracks(trackSlugs: [track.slug]))
        selection.url = server
        cache.refreshDownloadStates()
        XCTAssertNil(cache.downloadState(for: track), "Completion from the obsolete server generation must be discarded")
        network.started = nil
        await cache.downloadTrack(track)
        XCTAssertEqual(cache.downloadState(for: track)?.phase, .downloaded)
        XCTAssertNotNil(cache.localAudioURL(for: url))
        selection.url = URL(string: "https://other.example")!
        cache.refreshDownloadStates()
        XCTAssertNil(cache.downloadState(for: track))
        XCTAssertNil(cache.localAudioURL(for: url))
        XCTAssertTrue(cache.tracksFallback().isEmpty)
    }

    func testMetadataWriteFailureCannotReport100Percent() async throws {
        let dir = try directory()
        let track = track()
        let bundle = bundle(track)
        func hash(_ string: String) -> String {
            SHA256.hash(data: Data(string.utf8)).map { String(format: "%02x", $0) }.joined()
        }
        let destination = dir.appendingPathComponent("downloaded-tracks")
            .appendingPathComponent(hash(server.absoluteString)).appendingPathComponent(hash(track.id) + ".json")
        try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
        let cache = cache(at: dir, bundle: bundle, network: DownloadTestNetwork())
        await cache.downloadTrack(track)
        let failed = try XCTUnwrap(cache.downloadState(for: track))
        XCTAssertEqual(failed.phase, .failed)
        XCTAssertLessThan(failed.completed, failed.total)
        XCTAssertFalse(cache.hasDownloadedTracks(trackSlugs: [track.slug]))
    }

    func testTruncatedAudioCannotEarnDownloadedStatus() async throws {
        let dir = try directory()
        let track = track()
        let network = DownloadTestNetwork()
        network.truncatedPaths = ["/story.mp3"]
        let url = "https://example.com/story.mp3"
        let cache = cache(at: dir, bundle: bundle(track, audio: [url]), network: network)
        await cache.downloadTrack(track)
        XCTAssertEqual(cache.downloadState(for: track)?.phase, .failed)
        XCTAssertNil(cache.localAudioURL(for: url))
    }
}

@MainActor
private final class DownloadTestServerSelection {
    var url: URL
    init(url: URL) { self.url = url }
}

@MainActor
private final class DownloadTestNetwork {
    var requests: [URL] = []
    var failedPaths: Set<String> = []
    var truncatedPaths: Set<String> = []
    var gatedPath: String?
    var started: (() -> Void)?
    private var continuations: [CheckedContinuation<Void, Never>] = []

    func release() {
        gatedPath = nil
        let waiting = continuations
        continuations = []
        waiting.forEach { $0.resume() }
    }

    func download(_ request: URLRequest) async throws -> (URL, URLResponse) {
        let url = request.url!
        requests.append(url)
        if gatedPath == url.path {
            await withCheckedContinuation { continuation in
                continuations.append(continuation)
                started?()
            }
        }
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("download-audio-\(UUID().uuidString).mp3")
        try Data("audio".utf8).write(to: temporary)
        let response = HTTPURLResponse(url: url, statusCode: failedPaths.contains(url.path) ? 503 : 200,
                                       httpVersion: nil, headerFields: ["Content-Length": truncatedPaths.contains(url.path) ? "100" : "5"])!
        return (temporary, response)
    }
}
