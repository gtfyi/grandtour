import Foundation

/// The multipart `meta` field of POST /api/creator/spots — mirrors
/// CreatorSpotMeta in @grandtour/shared. Codable so a take that can't upload
/// (no signal on a trail) persists to disk exactly as it will be sent later.
struct CreatorSpotMeta: Codable {
    var trackId: String
    let title: String
    var subtitle: String = ""
    let lat: Double
    let lng: Double
    var radiusM: Double = 40
    var durationMs: Double?
    var recordedAt: String?
    var courseDeg: Double?
    var speedMps: Double?
    var altitudeM: Double?
    var horizontalAccuracyM: Double?
    var clientId: String?
}

enum CreatorAPIError: LocalizedError {
    case uploadsUnavailable
    var errorDescription: String? {
        "This server doesn’t accept recording uploads. Choose an authoring server; your recordings stay on this phone."
    }
}

/// Walk-and-record endpoints. Same base-URL resolution as the tour calls;
/// the server treats these as trusted (private server, no auth for now).
extension GrandTourAPI {
    /// Check the actual destination, not a cached network-reachability flag.
    /// Older servers lack safe retries and static servers have no write API.
    func checkRecordingUploads() async throws {
        var req = URLRequest(url: baseURL.appendingPathComponent("api/creator/capabilities"))
        req.timeoutInterval = 5
        req.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, response) = try await session.data(for: req)
        struct Capabilities: Decodable { let recording: Bool; let idempotency: Bool }
        guard (response as? HTTPURLResponse)?.statusCode == 200,
              let capabilities = try? JSONDecoder().decode(Capabilities.self, from: data),
              capabilities.recording, capabilities.idempotency else {
            throw CreatorAPIError.uploadsUnavailable
        }
    }

    /// Create a track to record onto. The server slugifies the name.
    func createTrack(name: String, description: String = "", clientId: String? = nil) async throws -> Track {
        var req = URLRequest(url: baseURL.appendingPathComponent("api/creator/tracks"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.timeoutInterval = 15
        var body: [String: Any] = [
            "name": name, "description": description,
        ]
        if let clientId { body["clientId"] = clientId }
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp) = try await session.data(for: req)
        guard (resp as? HTTPURLResponse)?.statusCode == 201 else {
            throw URLError(.badServerResponse)
        }
        struct R: Codable { let track: Track }
        return try JSONDecoder().decode(R.self, from: data).track
    }

    /// Everything recorded onto a track so far (any status — this is the
    /// creator's own list, not the public catalog).
    func creatorSpots(trackId: String) async throws -> [Spot] {
        var comps = URLComponents(
            url: baseURL.appendingPathComponent("api/creator/spots"),
            resolvingAgainstBaseURL: false
        )!
        comps.queryItems = [URLQueryItem(name: "trackId", value: trackId)]
        var req = URLRequest(url: comps.url!)
        req.timeoutInterval = 15
        let (data, resp) = try await session.data(for: req)
        guard (resp as? HTTPURLResponse)?.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        struct R: Codable { let spots: [Spot] }
        return try JSONDecoder().decode(R.self, from: data).spots
    }

    /// Upload one take: the recording plus where/when it was made. The spot
    /// and its narration publish immediately — playable on the next poll.
    func createSpot(meta: CreatorSpotMeta, audioFileURL: URL) async throws -> Spot {
        let audio = try Data(contentsOf: audioFileURL)
        let metaJSON = try JSONEncoder().encode(meta)

        let boundary = "grandtour-\(UUID().uuidString)"
        var body = Data()
        func append(_ s: String) { body.append(Data(s.utf8)) }
        append("--\(boundary)\r\n")
        append("Content-Disposition: form-data; name=\"meta\"\r\n\r\n")
        body.append(metaJSON)
        append("\r\n--\(boundary)\r\n")
        append("Content-Disposition: form-data; name=\"audio\"; filename=\"take.m4a\"\r\n")
        append("Content-Type: audio/mp4\r\n\r\n")
        body.append(audio)
        append("\r\n--\(boundary)--\r\n")

        var req = URLRequest(url: baseURL.appendingPathComponent("api/creator/spots"))
        req.httpMethod = "POST"
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        // Minutes of AAC over a weak cell link deserves more than the poll timeout.
        req.timeoutInterval = 120
        req.httpBody = body

        let (data, resp) = try await session.data(for: req)
        guard (resp as? HTTPURLResponse)?.statusCode == 201 else {
            throw URLError(.badServerResponse)
        }
        struct R: Codable { let spot: Spot }
        return try JSONDecoder().decode(R.self, from: data).spot
    }

    /// Remove a fumbled take (spot + its content cascade server-side).
    func deleteCreatorSpot(id: String) async throws {
        var req = URLRequest(
            url: baseURL.appendingPathComponent("api/creator/spots").appendingPathComponent(id)
        )
        req.httpMethod = "DELETE"
        req.timeoutInterval = 15
        let (_, resp) = try await session.data(for: req)
        guard let status = (resp as? HTTPURLResponse)?.statusCode, status == 200 || status == 404 else {
            throw URLError(.badServerResponse)
        }
    }
}
