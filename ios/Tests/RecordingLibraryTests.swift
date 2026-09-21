import XCTest

@MainActor
final class RecordingLibraryTests: XCTestCase {
    private let server = URL(string: "https://recorder.test")!

    private func fixture() throws -> (URL, URLSession, RecordingStub) {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("recordings-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let stub = RecordingStub()
        RecordingProtocol.stub = stub
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [RecordingProtocol.self]
        let session = URLSession(configuration: config)
        GrandTourAPI.resetProbes()
        addTeardownBlock {
            session.invalidateAndCancel()
            try? FileManager.default.removeItem(at: directory)
        }
        return (directory, session, stub)
    }

    private func library(_ directory: URL, _ session: URLSession,
                         serverURL: (() -> URL)? = nil) -> RecordingLibrary {
        RecordingLibrary(directory: directory, serverURL: serverURL ?? { self.server },
                         makeAPI: { GrandTourAPI(baseURL: $0, session: session) })
    }

    @discardableResult
    private func save(_ library: RecordingLibrary, track: RecordingTrack, title: String = "Old mill") throws -> LocalRecording {
        let file = library.directory.appendingPathComponent("take-\(UUID().uuidString).m4a")
        try Data([0, 1, 2, 3]).write(to: file)
        var meta = CreatorSpotMeta(trackId: track.id, title: title, lat: 37.99, lng: -122.59)
        meta.durationMs = 12_345
        meta.recordedAt = "2026-09-20T20:00:00Z"
        meta.courseDeg = 270
        return try library.saveRecording(trackID: track.id, meta: meta, audioURL: file)
    }

    func testOfflineTrackAndRecordingSurviveRestartWithoutAnyNetworkRequest() async throws {
        let (dir, session, stub) = try fixture()
        stub.offline = true
        let first = library(dir, session)
        let track = try first.createTrack(named: "  Canyon walk  ")
        let take = try save(first, track: track)
        XCTAssertTrue(stub.paths.isEmpty, "Creating and saving must not wait for the network")
        await first.sync()
        let restored = library(dir, session)
        XCTAssertEqual(restored.tracks.first?.name, "Canyon walk")
        XCTAssertEqual(restored.selectedTrackID, track.id)
        XCTAssertEqual(restored.recordings.first?.id, take.id)
        XCTAssertEqual(restored.recordings.first?.meta.courseDeg, 270)
        XCTAssertEqual(restored.recordings.first?.meta.lat, 37.99)
        XCTAssertEqual(restored.recordings.first?.meta.durationMs, 12_345)
        XCTAssertNil(restored.recordings.first?.remoteSpot)
        XCTAssertEqual(try Data(contentsOf: restored.audioURL(for: take)), Data([0, 1, 2, 3]))
    }

    func testReconnectCreatesTrackBeforeSpotsAndKeepsLocalAudioAfterUpload() async throws {
        let (dir, session, stub) = try fixture()
        let model = library(dir, session)
        let track = try model.createTrack(named: "Canyon walk")
        let take = try save(model, track: track)
        await model.sync()
        let remoteID = try XCTUnwrap(model.tracks.first?.remoteTrack?.id)
        XCTAssertEqual(stub.metas.first?.trackId, remoteID)
        XCTAssertEqual(stub.metas.first?.clientId, take.id)
        XCTAssertEqual(stub.paths.filter { $0.hasPrefix("POST") }, ["POST /api/creator/tracks", "POST /api/creator/spots"])
        XCTAssertEqual(model.pendingCount, 0)
        XCTAssertEqual(model.recordings.first?.remoteSpot?.trackId, remoteID)
        XCTAssertTrue(FileManager.default.fileExists(atPath: model.audioURL(for: take).path))
        let restored = library(dir, session)
        await restored.sync(refreshCatalog: true)
        XCTAssertEqual(stub.trackWrites, 1)
        XCTAssertEqual(stub.spotWrites, 1)
        XCTAssertEqual(restored.tracks.count, 1)
    }

    func testLostTrackResponseReusesIdentityAfterRestartAndCoalescesCatalogCopy() async throws {
        let (dir, session, stub) = try fixture()
        stub.loseTrackResponse = true
        let first = library(dir, session)
        let track = try first.createTrack(named: "Canyon walk")
        try save(first, track: track)
        await first.sync()
        XCTAssertNil(first.tracks.first?.remoteTrack)
        XCTAssertEqual(first.tracks.first?.serverURL, server)
        let restored = library(dir, session)
        await restored.sync()
        XCTAssertEqual(stub.trackWrites, 1)
        XCTAssertEqual(stub.spotWrites, 1)
        XCTAssertEqual(restored.tracks.count, 1)
        XCTAssertEqual(restored.tracks.first?.id, track.id)
        XCTAssertEqual(restored.pendingCount, 0)
    }

    func testLostSpotResponseRetriesSameIdentityWithoutLosingAudioOrDuplicating() async throws {
        let (dir, session, stub) = try fixture()
        stub.loseSpotResponse = true
        let first = library(dir, session)
        let track = try first.createTrack(named: "Canyon walk")
        let take = try save(first, track: track)
        await first.sync()
        XCTAssertNil(first.recordings.first?.remoteSpot)
        XCTAssertThrowsError(try first.deleteLocalRecording(take.id), "A lost response must not orphan a published take")
        XCTAssertTrue(FileManager.default.fileExists(atPath: first.audioURL(for: take).path))
        let restored = library(dir, session)
        await restored.sync()
        XCTAssertEqual(stub.spotWrites, 1)
        XCTAssertEqual(stub.metas.map(\.clientId), [take.id, take.id])
        XCTAssertEqual(restored.pendingCount, 0)
    }

    func testBoundQueueDoesNotUploadToDifferentServer() async throws {
        let (dir, session, stub) = try fixture()
        var selected = server
        let model = library(dir, session, serverURL: { selected })
        stub.loseTrackResponse = true
        let track = try model.createTrack(named: "Original server only")
        try save(model, track: track)
        await model.sync()
        selected = URL(string: "https://other-recorder.test")!
        await model.sync()
        XCTAssertEqual(stub.trackWrites, 1)
        XCTAssertEqual(stub.spotWrites, 0)
        XCTAssertEqual(model.tracks.first { $0.id == track.id }?.serverURL, server)
        selected = server
        await model.sync()
        XCTAssertEqual(model.pendingCount, 0)
    }

    func testReadOnlyServerKeepsTrackUnboundAndDoesNotSendWrites() async throws {
        let (dir, session, stub) = try fixture()
        stub.readOnly = true
        let model = library(dir, session)
        let track = try model.createTrack(named: "Offline on a static site")
        try save(model, track: track)
        await model.sync()
        XCTAssertNil(model.tracks.first?.serverURL)
        XCTAssertEqual(model.pendingCount, 2)
        XCTAssertEqual(stub.trackWrites, 0)
        XCTAssertEqual(stub.spotWrites, 0)
        XCTAssertTrue(model.syncMessage?.contains("doesn’t accept") == true)
    }

    func testPartialUploadKeepsFailedTakeAndDoesNotResendSuccessfulTake() async throws {
        let (dir, session, stub) = try fixture()
        stub.failSpotTitle = "Retry me"
        let model = library(dir, session)
        let track = try model.createTrack(named: "Walk")
        let failed = try save(model, track: track, title: "Retry me")
        let passed = try save(model, track: track, title: "Keep me")
        await model.sync()
        XCTAssertNil(model.recordings.first { $0.id == failed.id }?.remoteSpot)
        XCTAssertNotNil(model.recordings.first { $0.id == passed.id }?.remoteSpot)
        stub.failSpotTitle = nil
        await model.sync()
        XCTAssertEqual(model.pendingCount, 0)
        XCTAssertEqual(stub.metas.filter { $0.clientId == passed.id }.count, 1)
    }

    func testCachedServerTracksRemainAvailableToRecordAfterOfflineRestart() async throws {
        let (dir, session, stub) = try fixture()
        stub.existingTracks = [RecordingStub.track(id: UUID().uuidString, name: "Existing walk")]
        let online = library(dir, session)
        await online.sync(refreshCatalog: true)
        stub.offline = true
        let offline = library(dir, session)
        let cached = try XCTUnwrap(offline.availableTracks().first)
        XCTAssertEqual(cached.name, "Existing walk")
        try save(offline, track: cached)
        XCTAssertEqual(offline.recordings.count, 1)
        XCTAssertEqual(offline.tracks.first?.serverURL, server)
        XCTAssertEqual(stub.trackWrites, 0)
    }

    func testConcurrentSyncAndServerSwitchDuringRequestDoNotRedirectUploads() async throws {
        let (dir, session, stub) = try fixture()
        var selected = server
        let model = library(dir, session, serverURL: { selected })
        let track = try model.createTrack(named: "Walk")
        try save(model, track: track)
        let started = expectation(description: "Track POST held in flight")
        var held: RecordingProtocol?
        stub.holdTrackRequest = { request in held = request; started.fulfill() }
        let uploading = Task { await model.sync() }
        await fulfillment(of: [started], timeout: 5)
        XCTAssertTrue(model.isSyncing)
        try save(model, track: track, title: "Created while uploading")
        await model.sync()
        selected = URL(string: "https://other-recorder.test")!
        stub.holdTrackRequest = nil
        try XCTUnwrap(held).finish()
        await uploading.value
        XCTAssertEqual(stub.trackWrites, 1)
        XCTAssertEqual(stub.spotWrites, 0)
        XCTAssertEqual(model.tracks.first { $0.id == track.id }?.serverURL, server)
        selected = server
        await model.sync()
        XCTAssertEqual(model.pendingCount, 0)
    }

    func testDiskWriteFailureDoesNotReportTrackOrRecordingSaved() async throws {
        let (dir, session, _) = try fixture()
        let model = library(dir, session)
        let track = try model.createTrack(named: "Existing track")
        let failing = RecordingLibrary(directory: dir, serverURL: { self.server }, write: { _, _ in
            throw CocoaError(.fileWriteOutOfSpace)
        })
        XCTAssertThrowsError(try failing.createTrack(named: "Must not appear"))
        XCTAssertEqual(failing.tracks.count, 1)
        XCTAssertThrowsError(try save(failing, track: track))
        XCTAssertTrue(failing.recordings.isEmpty)
        let audio = try FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "m4a" }
        XCTAssertEqual(audio.count, 1, "An unsuccessful save must retain the take for retry")
    }

    func testCorruptLibraryIsNotOverwritten() throws {
        let (dir, session, _) = try fixture()
        let original = Data("not valid JSON".utf8)
        let path = dir.appendingPathComponent("library.json")
        try original.write(to: path)
        let model = library(dir, session)
        XCTAssertNotNil(model.storageError)
        XCTAssertThrowsError(try model.createTrack(named: "New"))
        XCTAssertEqual(try Data(contentsOf: path), original)
    }

    func testLegacySidecarRecoveredAndNotUploadedUntilOriginalTrackIsFound() async throws {
        let (dir, session, stub) = try fixture()
        let audio = dir.appendingPathComponent("old-take.m4a")
        try Data([1, 2]).write(to: audio)
        let remote = RecordingStub.track(id: UUID().uuidString, name: "Old track")
        let meta = CreatorSpotMeta(trackId: remote.id, title: "Legacy take", lat: 1, lng: 2)
        let sidecar = audio.deletingPathExtension().appendingPathExtension("json")
        try JSONEncoder().encode(meta).write(to: sidecar)
        let model = library(dir, session)
        XCTAssertEqual(model.recordings.count, 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: sidecar.path))
        await model.sync()
        XCTAssertEqual(stub.spotWrites, 0)
        stub.existingTracks = [remote]
        await model.sync()
        XCTAssertEqual(stub.spotWrites, 1)
        XCTAssertEqual(stub.metas.first?.trackId, remote.id)
        XCTAssertEqual(model.tracks.first?.name, "Old track")
        XCTAssertEqual(library(dir, session).recordings.count, 1)
    }
}

/// Simulates the important HTTP failure: the server commits a POST, then the
/// response disappears. Its receipts let the same stable client ID be retried.
private final class RecordingStub: @unchecked Sendable {
    var offline = false
    var readOnly = false
    var loseTrackResponse = false
    var loseSpotResponse = false
    var failSpotTitle: String?
    var holdTrackRequest: (@MainActor (RecordingProtocol) -> Void)?
    var paths: [String] = []
    var metas: [CreatorSpotMeta] = []
    var existingTracks: [Track] = []
    var trackWrites = 0
    var spotWrites = 0
    private var trackReceipts: [String: Track] = [:]
    private var spotReceipts: [String: Spot] = [:]

    static func track(id: String, name: String) -> Track {
        Track(id: id, slug: "canyon-walk", name: name, description: "", kind: "tour",
              icon: nil, color: nil, official: false)
    }

    func respond(_ request: URLRequest) throws -> (Int, Data) {
        let path = request.url!.path
        paths.append("\(request.httpMethod ?? "GET") \(path)")
        if offline { throw URLError(.notConnectedToInternet) }
        if path == "/api/creator/capabilities" {
            return readOnly ? (404, Data()) : (200, Data(#"{"recording":true,"idempotency":true}"#.utf8))
        }
        if path == "/health" { return (200, Data(#"{"ok":true,"service":"grandtour"}"#.utf8)) }
        if path == "/api/tracks" {
            struct R: Encodable { let tracks: [Track] }
            return (200, try JSONEncoder().encode(R(tracks: existingTracks + Array(trackReceipts.values))))
        }
        if path == "/api/creator/tracks", request.httpMethod == "POST" {
            let body = try JSONSerialization.jsonObject(with: Self.body(request)) as! [String: String]
            let key = body["clientId"]!
            if trackReceipts[key] == nil {
                trackWrites += 1
                trackReceipts[key] = Self.track(id: UUID().uuidString, name: body["name"]!)
            }
            if loseTrackResponse { loseTrackResponse = false; throw URLError(.networkConnectionLost) }
            struct R: Encodable { let track: Track }
            return (201, try JSONEncoder().encode(R(track: trackReceipts[key]!)))
        }
        if path == "/api/creator/spots", request.httpMethod == "POST" {
            let body = Self.body(request)
            let separator = Data("\r\n\r\n".utf8)
            let start = body.range(of: separator)!.upperBound
            let end = body.range(of: Data("\r\n--".utf8), in: start..<body.endIndex)!.lowerBound
            let meta = try JSONDecoder().decode(CreatorSpotMeta.self, from: body[start..<end])
            metas.append(meta)
            if meta.title == failSpotTitle { throw URLError(.cannotConnectToHost) }
            let key = meta.clientId!
            if spotReceipts[key] == nil {
                spotWrites += 1
                spotReceipts[key] = Spot(id: UUID().uuidString, trackId: meta.trackId, title: meta.title, subtitle: "",
                    trigger: GeoTrigger(center: LngLat(lat: meta.lat, lng: meta.lng), radiusM: meta.radiusM),
                    modes: [], status: "published", locating: nil)
            }
            if loseSpotResponse { loseSpotResponse = false; throw URLError(.networkConnectionLost) }
            struct R: Encodable { let spot: Spot }
            return (201, try JSONEncoder().encode(R(spot: spotReceipts[key]!)))
        }
        return (404, Data())
    }

    private static func body(_ request: URLRequest) -> Data {
        if let data = request.httpBody { return data }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open(); defer { stream.close() }
        var result = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }
            result.append(contentsOf: buffer.prefix(count))
        }
        return result
    }
}

private final class RecordingProtocol: URLProtocol {
    static var stub: RecordingStub!
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host?.hasSuffix("recorder.test") == true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        if request.httpMethod == "POST", request.url?.path == "/api/creator/tracks",
           let hold = Self.stub.holdTrackRequest {
            DispatchQueue.main.async { hold(self) }
            return
        }
        finish()
    }
    func finish() {
        do {
            let (status, data) = try Self.stub.respond(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil,
                                           headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}
