import Foundation

/// How a server answers: an *authoring* server has the live API (`/api/*`,
/// creator, fill-ins); a *static* server only serves the distribution files
/// — the index and the bundles — which is all a tour needs.
enum ServerKind: String {
    case live
    case `static`
}

enum GrandTourAPIError: LocalizedError {
    case staticServer(String)
    case badIndex
    /// The server answered, but has no such route — a static host asked for the live API.
    case noSuchRoute
    var errorDescription: String? {
        switch self {
        case .staticServer(let what): return "\(what) is not available from a static server."
        case .badIndex: return "The server's track list could not be read."
        case .noSuchRoute: return "This server has no live API."
        }
    }
}

/// Talks to a GrandTour server. The base URL is the user's selected server
/// (ServerPreference); it's resolved on every request, so long-lived
/// holders follow server switches without being rebuilt. Pass `baseURL` to
/// pin one instead.
///
/// Every server speaks the distribution convention (`grandtour.json` +
/// `tours/<slug>.grandtour.json`). An authoring server additionally offers
/// the live API, which `probe()` detects once per server: with it, the
/// catalog, nearby polling, manifests, fill-ins and recording work as
/// before; without it, the index is the catalog and everything else is
/// evaluated on the device from fetched bundles.
struct GrandTourAPI {
    private let fixedBaseURL: URL?
    let session: URLSession

    var baseURL: URL { fixedBaseURL ?? ServerPreference.currentURL }

    init(baseURL: URL? = nil, session: URLSession = .shared) {
        fixedBaseURL = baseURL
        self.session = session
    }

    // ─── Server kind ─────────────────────────────────────────────────────────

    private static var kinds: [String: ServerKind] = [:]
    private static var indexes: [String: GTIndex] = [:]

    private var key: String { baseURL.absoluteString }
    var kind: ServerKind? { Self.kinds[key] }
    var isStatic: Bool { kind == .static }
    /// True until a probe has classified this server; treated as live.
    var isLive: Bool { kind != .static }

    /// Forget what was learned about every server (a switch, or a retry).
    static func resetProbes() {
        kinds = [:]
        indexes = [:]
    }

    /// Classify the server once: `/health` answers as GrandTour → live; else
    /// a readable index → static. Cached on success; unreachable servers are
    /// re-probed next time.
    @discardableResult
    func probe() async -> ServerKind? {
        if let known = kind { return known }
        var req = URLRequest(url: baseURL.appendingPathComponent("health"))
        req.timeoutInterval = 8
        if let (data, resp) = try? await session.data(for: req),
           (resp as? HTTPURLResponse)?.statusCode == 200,
           let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           body["service"] as? String == "grandtour" {
            Self.kinds[key] = .live
            return .live
        }
        if (try? await index()) != nil {
            Self.kinds[key] = .static
            return .static
        }
        return nil
    }

    // ─── The distribution files ──────────────────────────────────────────────

    var indexURL: URL? { Distribution.indexURL(for: baseURL.absoluteString) }

    /// The server's index, fetched fresh and remembered for URL resolution.
    func index() async throws -> GTIndex {
        guard let url = indexURL else { throw GrandTourAPIError.badIndex }
        var req = URLRequest(url: url)
        req.timeoutInterval = 15
        req.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        let index = try JSONDecoder().decode(GTIndex.self, from: data)
        Self.indexes[key] = index
        return index
    }

    /// The last index read from this server, by slug (empty before the first read).
    func indexEntries() -> [String: IndexTrack] {
        Self.indexes[key]?.bySlug ?? [:]
    }

    /// Where a track's bundle is on this server: the index entry's URL, else
    /// the conventional layout.
    func bundleURL(for track: Track) -> URL? {
        guard let indexURL else { return nil }
        if let entry = indexEntries()[track.slug], let url = Distribution.trackURL(entry, index: indexURL) { return url }
        return Distribution.defaultTrackURL(slug: track.slug, index: indexURL)
    }

    /// Audio URLs are absolute. The one exception is history: recordings
    /// cached from a dev server were minted against `localhost`, and those
    /// still play when the same server is reached over the tailnet.
    func resolveAudioURL(_ urlString: String) -> URL? {
        guard var comps = URLComponents(string: urlString) else { return nil }
        let host = comps.host?.lowercased()
        guard host == "localhost" || host == "127.0.0.1",
              let base = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            return comps.url
        }
        comps.scheme = base.scheme
        comps.host = base.host
        comps.port = base.port
        return comps.url
    }

    // ─── Catalog ─────────────────────────────────────────────────────────────

    /// The tracks a listener can turn on: the live catalog, or the index.
    func tracks() async throws -> [Track] {
        if await probe() == .static {
            return try await index().tracks.map(\.track)
        }
        let url = baseURL.appendingPathComponent("api/tracks")
        var req = URLRequest(url: url)
        req.timeoutInterval = 15
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        struct R: Codable { let tracks: [Track] }
        return try JSONDecoder().decode(R.self, from: data).tracks
    }

    /// The complete published track: from the bundle a static server names,
    /// or the live route, which also serves fill-in bundles.
    func trackDownloadBundle(track: Track) async throws -> TrackDownloadBundle {
        let url: URL
        if isStatic {
            guard let bundle = bundleURL(for: track) else { throw GrandTourAPIError.badIndex }
            url = bundle
        } else {
            url = baseURL.appendingPathComponent("api/tracks")
                .appendingPathComponent(track.id).appendingPathComponent("bundle")
        }
        var req = URLRequest(url: url)
        req.timeoutInterval = 120
        req.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        let bundle = try JSONDecoder().decode(TrackDownloadBundle.self, from: data)
        guard bundle.track.id == track.id, bundle.track.slug == track.slug else {
            throw URLError(.cannotParseResponse)
        }
        return bundle
    }

    // ─── The live API (authoring servers) ────────────────────────────────────

    /// The hot path: spots near a coordinate, filtered by enabled tracks + mode.
    /// `courseDeg` (GPS course, 0=N) lets the server pick left/right
    /// directional narration variants for the traveler's heading.
    /// `changedSince` is a `dataVersion` from a previous response for the same
    /// point and filters; when nothing has changed the server returns
    /// `unchanged: true` with no spots, and the caller keeps what it has.
    /// A static server has no such route: the tour evaluates its bundles on
    /// the device instead (TourViewModel checks `isStatic` before calling).
    func nearby(
        lat: Double,
        lng: Double,
        radiusM: Double = 2000,
        tracks: [String] = [],
        mode: String? = nil,
        locale: String? = nil,
        trackLocales: [String: String] = [:],
        courseDeg: Double? = nil,
        changedSince: String? = nil
    ) async throws -> NearbyResponse {
        guard !isStatic else { throw GrandTourAPIError.staticServer("Nearby") }
        var comps = URLComponents(url: baseURL.appendingPathComponent("api/nearby"), resolvingAgainstBaseURL: false)!
        var items = [
            URLQueryItem(name: "lat", value: String(lat)),
            URLQueryItem(name: "lng", value: String(lng)),
            URLQueryItem(name: "radiusM", value: String(Int(radiusM))),
        ]
        if !tracks.isEmpty { items.append(URLQueryItem(name: "tracks", value: tracks.joined(separator: ","))) }
        if let mode { items.append(URLQueryItem(name: "mode", value: mode)) }
        if let locale { items.append(URLQueryItem(name: "locale", value: locale)) }
        if !trackLocales.isEmpty {
            let pairs = trackLocales.map { "\($0.key):\($0.value)" }.joined(separator: ",")
            items.append(URLQueryItem(name: "trackLocales", value: pairs))
        }
        if let courseDeg { items.append(URLQueryItem(name: "courseDeg", value: String(courseDeg))) }
        if let changedSince { items.append(URLQueryItem(name: "changedSince", value: changedSince)) }
        comps.queryItems = items

        // Background polls must not hang on a dead network until the default
        // 60s timeout; a stale tour fix is worse than none.
        var req = URLRequest(url: comps.url!)
        req.timeoutInterval = 15

        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            if (resp as? HTTPURLResponse)?.statusCode == 404 { throw GrandTourAPIError.noSuchRoute }
            throw URLError(.badServerResponse)
        }
        return try JSONDecoder().decode(NearbyResponse.self, from: data)
    }

    /// Journey prefetch: every published spot within `corridorM` of the
    /// route polyline, ordered by position along it.
    func routeNearby(
        points: [(lat: Double, lng: Double)],
        corridorM: Double = 300,
        tracks: [String] = [],
        mode: String? = nil,
        locale: String? = nil,
        trackLocales: [String: String] = [:]
    ) async throws -> [NearbySpot] {
        guard !isStatic else { throw GrandTourAPIError.staticServer("Route planning") }
        var req = URLRequest(url: baseURL.appendingPathComponent("api/route-nearby"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.timeoutInterval = 30
        var body: [String: Any] = [
            "points": points.map { ["lat": $0.lat, "lng": $0.lng] },
            "corridorM": corridorM,
            "limit": 500,
        ]
        if !tracks.isEmpty { body["tracks"] = tracks }
        if let mode { body["mode"] = mode }
        if let locale { body["locale"] = locale }
        if !trackLocales.isEmpty { body["trackLocales"] = trackLocales }
        req.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        struct R: Codable { let spots: [NearbySpot] }
        return try JSONDecoder().decode(R.self, from: data).spots
    }

    /// Published fill-in items for the given fill-in track slugs. Fetched
    /// whole and cached client-side — a fill-in track is a small list, and
    /// gaps often happen exactly where there's no signal. None from a static
    /// server: fill-in tracks are not part of the distribution.
    func fillInItems(tracks: [String]) async throws -> [FillInItem] {
        guard !isStatic else { return [] }
        var comps = URLComponents(
            url: baseURL.appendingPathComponent("api/fillin-items"),
            resolvingAgainstBaseURL: false
        )!
        comps.queryItems = [URLQueryItem(name: "tracks", value: tracks.joined(separator: ","))]
        var req = URLRequest(url: comps.url!)
        req.timeoutInterval = 15
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        struct R: Codable { let items: [FillInItem] }
        return try JSONDecoder().decode(R.self, from: data).items
    }

    /// Per-track unit index (published, narratable ids + sequence slots),
    /// fetched with the catalog and cached — sequence eligibility and
    /// completion math need the whole track, not just what's in range.
    /// A static server's manifests come from its bundles (TourCache).
    func trackManifests(tracks: [String] = []) async throws -> [TrackManifest] {
        guard !isStatic else { return [] }
        var comps = URLComponents(
            url: baseURL.appendingPathComponent("api/track-manifest"),
            resolvingAgainstBaseURL: false
        )!
        if !tracks.isEmpty {
            comps.queryItems = [URLQueryItem(name: "tracks", value: tracks.joined(separator: ","))]
        }
        var req = URLRequest(url: comps.url!)
        req.timeoutInterval = 15
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        struct R: Codable { let tracks: [TrackManifest] }
        return try JSONDecoder().decode(R.self, from: data).tracks
    }
}
