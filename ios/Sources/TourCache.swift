import Foundation
import CoreLocation
import CryptoKit

struct TrackDownloadState: Equatable {
    enum Phase: Equatable { case downloading, downloaded, failed }
    let phase: Phase
    /// One final unit represents the durable metadata commit. A download
    /// cannot reach 100% merely because its last audio request finished.
    let completed: Int
    let total: Int
    let errorText: String?
}

/// Offline store for the tour: spots, tracks, and audio files.
///
/// Two jobs:
///   1. Every successful fetch (live poll or journey prefetch) merges into a
///      disk cache, and the audio it references is downloaded alongside.
///   2. When the server is unreachable, `offlineNearby` rebuilds the nearby
///      list from cache with distance and triggers computed on-device, so the
///      tour keeps narrating with no signal.
///
/// On-device trigger math note: the server invariant is that PostGIS owns geo
/// math — offline is the one place that can't hold. We lean on CoreLocation's
/// geodesic `distance(from:)` rather than hand-rolling haversine, plus a
/// small ray-cast for region polygons.
@MainActor
final class TourCache: ObservableObject {
    static let shared = TourCache()

    /// Audio prefetch progress for the journey UI: (done, total).
    @Published private(set) var audioProgress: (done: Int, total: Int)?
    @Published private(set) var trackDownloads: [String: TrackDownloadState] = [:]

    private struct Entry: Codable {
        var spot: NearbySpot
        var fetchedAt: Date
    }

    private var entries: [String: Entry] = [:]
    private var cachedTracks: [Track] = []
    private var cachedFillIns: [FillInItem] = []
    private var cachedManifests: [TrackManifest] = []
    private var loaded = false
    /// Remote URL paths currently being downloaded, to dedupe requests.
    private var inFlight: Set<String> = []

    private let dir: URL
    private let serverURL: () -> URL
    private let bundleFetcher: (GrandTourAPI, Track) async throws -> TrackDownloadBundle
    private let audioDownloader: (URLRequest) async throws -> (URL, URLResponse)
    private struct DownloadSnapshot: Codable {
        let serverKey: String
        let downloadedAt: Date
        let bundle: TrackDownloadBundle
        /// True for a bundle fetched for on-device evaluation only (a static
        /// server's track that is on): its audio streams until the user
        /// asks to Download. Absent in files written before this existed.
        let metadataOnly: Bool?
        /// The index's hash of the bundle file, to skip refetching unchanged tracks.
        let hash: String?
    }
    private var snapshots: [String: DownloadSnapshot] = [:]
    private var downloadServerKey: String?
    private var downloadGeneration = UUID()
    private var activeTrackDownloads: Set<String> = []

    init(
        directory: URL? = nil,
        serverURL: @escaping () -> URL = { ServerPreference.currentURL },
        bundleFetcher: @escaping (GrandTourAPI, Track) async throws -> TrackDownloadBundle = {
            try await $0.trackDownloadBundle(track: $1)
        },
        audioDownloader: @escaping (URLRequest) async throws -> (URL, URLResponse) = {
            try await URLSession.shared.download(for: $0)
        }
    ) {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        dir = directory ?? base.appendingPathComponent("GrandTour", isDirectory: true)
        self.serverURL = serverURL
        self.bundleFetcher = bundleFetcher
        self.audioDownloader = audioDownloader
    }
    private var spotsURL: URL { dir.appendingPathComponent("spots.json") }
    private var tracksURL: URL { dir.appendingPathComponent("tracks.json") }
    private var fillInURL: URL { dir.appendingPathComponent("fillin.json") }
    private var manifestURL: URL { dir.appendingPathComponent("manifests.json") }
    private var audioDir: URL { dir.appendingPathComponent("audio", isDirectory: true) }

    private static func serverKey(_ url: URL) -> String {
        var raw = url.absoluteString
        while raw.hasSuffix("/") { raw.removeLast() }
        return raw
    }

    private static func digest(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private func downloadDirectory(serverKey: String) -> URL {
        dir.appendingPathComponent("downloaded-tracks", isDirectory: true)
            .appendingPathComponent(Self.digest(serverKey), isDirectory: true)
    }

    private func downloadedAudioURL(_ remote: String, serverKey: String) -> URL {
        // URLs are rehosted by GrandTourAPI, so generation-time host changes
        // should not invalidate a file. Preserve the path AND query, and hash
        // instead of flattening slashes (which can collide).
        let parts = URLComponents(string: remote)
        let identity = (parts?.percentEncodedPath ?? remote)
            + (parts?.percentEncodedQuery.map { "?" + $0 } ?? "")
        let suffix = URL(string: remote)?.pathExtension ?? ""
        let filename = Self.digest(identity) + (suffix.isEmpty ? "" : "." + suffix)
        return downloadDirectory(serverKey: serverKey).appendingPathComponent("audio", isDirectory: true)
            .appendingPathComponent(filename)
    }

    private func hasAudioFile(_ url: URL) -> Bool {
        guard let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey]) else { return false }
        return values.isRegularFile == true && (values.fileSize ?? 0) > 0
    }

    // ─── Load / persist ──────────────────────────────────────────────────────

    private func ensureLoaded() {
        ensureDownloadSnapshotsLoaded()
        guard !loaded else { return }
        loaded = true
        try? FileManager.default.createDirectory(at: audioDir, withIntermediateDirectories: true)
        excludeFromBackup(dir)
        if let data = try? Data(contentsOf: spotsURL),
           let arr = try? JSONDecoder.iso.decode([Entry].self, from: data) {
            // Prune anything not refreshed in 60 days — stale content
            // shouldn't narrate forever after a track is retired.
            let cutoff = Date().addingTimeInterval(-60 * 86_400)
            for e in arr where e.fetchedAt > cutoff {
                entries[e.spot.spot.id] = e
            }
        }
        if let data = try? Data(contentsOf: tracksURL),
           let arr = try? JSONDecoder.iso.decode([Track].self, from: data) {
            cachedTracks = arr
        }
        if let data = try? Data(contentsOf: fillInURL),
           let arr = try? JSONDecoder.iso.decode([FillInItem].self, from: data) {
            cachedFillIns = arr
        }
        if let data = try? Data(contentsOf: manifestURL),
           let arr = try? JSONDecoder.iso.decode([TrackManifest].self, from: data) {
            cachedManifests = arr
        }
    }

    private func persistSpots() {
        guard let data = try? JSONEncoder.iso.encode(Array(entries.values)) else { return }
        try? data.write(to: spotsURL, options: .atomic)
    }

    private func excludeFromBackup(_ url: URL) {
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        var u = url
        var vals = URLResourceValues()
        vals.isExcludedFromBackup = true
        try? u.setResourceValues(vals)
    }

    // ─── Explicit whole-track downloads ─────────────────────────────────────

    private func ensureDownloadSnapshotsLoaded() {
        let key = Self.serverKey(serverURL())
        guard downloadServerKey != key else { return }
        downloadServerKey = key
        downloadGeneration = UUID()
        snapshots = [:]
        let folder = downloadDirectory(serverKey: key)
        let files = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? []
        for file in files where file.pathExtension == "json" {
            guard let data = try? Data(contentsOf: file),
                  let snapshot = try? JSONDecoder.iso.decode(DownloadSnapshot.self, from: data),
                  snapshot.serverKey == key else { continue }
            snapshots[snapshot.bundle.track.id] = snapshot
        }
        trackDownloads = snapshots.compactMapValues { stateForSnapshot($0) }
    }

    /// The Download button's state for a saved track; nil for a bundle that
    /// was only fetched for evaluation (nothing to show, nothing to retry).
    private func stateForSnapshot(_ snapshot: DownloadSnapshot) -> TrackDownloadState? {
        if snapshot.metadataOnly == true { return nil }
        let urls = Set(snapshot.bundle.audioURLs)
        let present = urls.filter { hasAudioFile(downloadedAudioURL($0, serverKey: snapshot.serverKey)) }.count
        let complete = present == urls.count
        return TrackDownloadState(
            phase: complete ? .downloaded : .failed,
            completed: present + (complete ? 1 : 0), total: urls.count + 1,
            errorText: complete ? nil : "Some saved audio is missing. Tap to download it again."
        )
    }

    /// Called on sheet appearance/foreground and server changes. Body reads
    /// use downloadState instead so SwiftUI never publishes during rendering.
    func refreshDownloadStates() {
        ensureLoaded()
        var states = trackDownloads
        for (id, snapshot) in snapshots where states[id]?.phase != .downloading {
            if let state = stateForSnapshot(snapshot) { states[id] = state } else { states.removeValue(forKey: id) }
        }
        if states != trackDownloads { trackDownloads = states }
    }

    /// Fetch a track's bundle for on-device evaluation, without its audio —
    /// what a static server needs before anything can play. Skipped when the
    /// saved copy matches the index's hash, or is under a day old when the
    /// index carries none. A track the user has downloaded keeps its audio.
    @discardableResult
    func ensureBundle(for track: Track, api: GrandTourAPI, hash: String?) async -> Bool {
        ensureLoaded()
        let key = Self.serverKey(serverURL())
        if let existing = snapshots[track.id], existing.serverKey == key {
            let fresh = hash != nil ? existing.hash == hash : Date().timeIntervalSince(existing.downloadedAt) < 86_400
            if fresh { return true }
        }
        do {
            let bundle = try await bundleFetcher(api, track)
            guard bundle.track.id == track.id, Self.serverKey(serverURL()) == key else { return false }
            let keepsAudio = snapshots[track.id].map { stateForSnapshot($0)?.phase == .downloaded } ?? false
            let snapshot = DownloadSnapshot(serverKey: key, downloadedAt: Date(), bundle: bundle, metadataOnly: !keepsAudio, hash: hash)
            let folder = downloadDirectory(serverKey: key)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            excludeFromBackup(dir)
            try JSONEncoder.iso.encode(snapshot).write(to: folder.appendingPathComponent(Self.digest(track.id) + ".json"), options: .atomic)
            snapshots[track.id] = snapshot
            if let state = stateForSnapshot(snapshot) { trackDownloads[track.id] = state } else { trackDownloads.removeValue(forKey: track.id) }
            return true
        } catch {
            TourDiagnostics.shared.log("bundle_fetch_failed", ["slug": track.slug, "error": error.localizedDescription])
            return false
        }
    }

    /// The saved snapshot of a track on the current server, if any — what a
    /// demo plots its route from after `ensureBundle`.
    func bundle(for track: Track) -> TrackDownloadBundle? {
        ensureLoaded()
        guard let snapshot = snapshots[track.id], snapshot.serverKey == Self.serverKey(serverURL()) else { return nil }
        return snapshot.bundle
    }

    func downloadState(for track: Track) -> TrackDownloadState? {
        guard downloadServerKey == Self.serverKey(serverURL()) else { return nil }
        return trackDownloads[track.id]
    }

    /// Cheap enough for the GPS hot path: only metadata membership, no
    /// per-file validation. Missing recordings can still use the saved text.
    func hasDownloadedTracks(trackSlugs: Set<String>) -> Bool {
        ensureLoaded()
        return snapshots.values.contains {
            trackSlugs.isEmpty || trackSlugs.contains($0.bundle.track.slug)
        }
    }

    /// Fetch a complete published snapshot, then every recording it names.
    /// Explicit downloads ignore the device-voice preference. Partial audio
    /// stays on disk for retries, but only an atomic, successful metadata
    /// commit earns the downloaded checkmark or pins this track for offline.
    func downloadTrack(_ track: Track) async {
        ensureLoaded()
        let baseURL = serverURL()
        let key = Self.serverKey(baseURL)
        let generation = downloadGeneration
        let taskKey = "\(generation.uuidString):\(track.id)"
        guard activeTrackDownloads.insert(taskKey).inserted else { return }
        defer { activeTrackDownloads.remove(taskKey) }
        let api = GrandTourAPI(baseURL: baseURL)
        trackDownloads[track.id] = TrackDownloadState(phase: .downloading, completed: 0, total: 0, errorText: nil)
        var wanted: [String] = []
        do {
            let bundle = try await bundleFetcher(api, track)
            try Task.checkCancellation()
            guard downloadIsCurrent(key: key, generation: generation) else { return }
            guard bundle.track.id == track.id else { throw URLError(.cannotParseResponse) }
            wanted = Array(Set(bundle.audioURLs)).sorted()
            let audioFolder = downloadDirectory(serverKey: key).appendingPathComponent("audio", isDirectory: true)
            try FileManager.default.createDirectory(at: audioFolder, withIntermediateDirectories: true)
            excludeFromBackup(dir)
            var completed = wanted.filter { hasAudioFile(downloadedAudioURL($0, serverKey: key)) }.count
            trackDownloads[track.id] = TrackDownloadState(
                phase: .downloading, completed: completed, total: wanted.count + 1, errorText: nil
            )
            let missing = wanted.filter { !hasAudioFile(downloadedAudioURL($0, serverKey: key)) }
            try await withThrowingTaskGroup(of: Void.self) { group in
                var pending = missing.makeIterator()
                // Bound network pressure while keeping large tracks practical
                // to save before a drive. MainActor only does the short file
                // commits; URLSession requests run concurrently.
                for _ in 0..<6 {
                    guard let remote = pending.next() else { break }
                    group.addTask { try await self.downloadTrackAudio(remote, api: api, key: key, generation: generation) }
                }
                var lastUpdate = Date.distantPast
                while try await group.next() != nil {
                    try Task.checkCancellation()
                    guard downloadIsCurrent(key: key, generation: generation) else { throw CancellationError() }
                    completed += 1
                    if Date().timeIntervalSince(lastUpdate) > 0.15 || completed == wanted.count {
                        trackDownloads[track.id] = TrackDownloadState(
                            phase: .downloading, completed: completed, total: wanted.count + 1, errorText: nil
                        )
                        lastUpdate = Date()
                    }
                    if let remote = pending.next() {
                        group.addTask { try await self.downloadTrackAudio(remote, api: api, key: key, generation: generation) }
                    }
                }
            }
            try Task.checkCancellation()
            guard downloadIsCurrent(key: key, generation: generation) else { return }
            guard wanted.allSatisfy({ hasAudioFile(downloadedAudioURL($0, serverKey: key)) }) else {
                throw URLError(.fileDoesNotExist)
            }
            let snapshot = DownloadSnapshot(serverKey: key, downloadedAt: Date(), bundle: bundle, metadataOnly: false, hash: nil)
            let data = try JSONEncoder.iso.encode(snapshot)
            let file = downloadDirectory(serverKey: key).appendingPathComponent(Self.digest(track.id) + ".json")
            try data.write(to: file, options: .atomic)
            snapshots[track.id] = snapshot
            trackDownloads[track.id] = TrackDownloadState(
                phase: .downloaded, completed: wanted.count + 1, total: wanted.count + 1, errorText: nil
            )
        } catch {
            guard downloadIsCurrent(key: key, generation: generation) else { return }
            let completed = wanted.filter { hasAudioFile(downloadedAudioURL($0, serverKey: key)) }.count
            trackDownloads[track.id] = TrackDownloadState(
                phase: .failed, completed: completed, total: max(1, wanted.count + 1),
                errorText: error is CancellationError
                    ? "Download paused. Tap to retry; saved audio will be kept."
                    : "Download incomplete. Tap to retry; saved audio will be kept."
            )
        }
    }

    private func downloadIsCurrent(key: String, generation: UUID) -> Bool {
        ensureDownloadSnapshotsLoaded()
        return downloadServerKey == key && downloadGeneration == generation
    }

    private func downloadTrackAudio(_ remoteString: String, api: GrandTourAPI, key: String, generation: UUID) async throws {
        try Task.checkCancellation()
        guard downloadIsCurrent(key: key, generation: generation) else { throw CancellationError() }
        let destination = downloadedAudioURL(remoteString, serverKey: key)
        if hasAudioFile(destination) { return }
        guard let remoteURL = api.resolveAudioURL(remoteString) else { throw URLError(.badURL) }
        var request = URLRequest(url: remoteURL)
        request.timeoutInterval = 60
        let (temporary, response) = try await audioDownloader(request)
        defer { try? FileManager.default.removeItem(at: temporary) }
        try Task.checkCancellation()
        guard downloadIsCurrent(key: key, generation: generation) else { throw CancellationError() }
        guard let http = response as? HTTPURLResponse, http.statusCode == 200,
              hasAudioFile(temporary) else { throw URLError(.badServerResponse) }
        let bytes = (try temporary.resourceValues(forKeys: [.fileSizeKey])).fileSize ?? 0
        if response.expectedContentLength > 0, Int64(bytes) != response.expectedContentLength {
            throw URLError(.networkConnectionLost)
        }
        // Concurrent tracks can share a recording. Whichever finishes first
        // owns the saved file; the other request can discard its temporary.
        if !hasAudioFile(destination) {
            try? FileManager.default.removeItem(at: destination)
            try FileManager.default.moveItem(at: temporary, to: destination)
        }
    }

    private var allCachedSpots: [String: NearbySpot] {
        var all = entries.mapValues(\.spot)
        for snapshot in snapshots.values {
            for spot in snapshot.bundle.nearbySpots {
                // A saved track must not roll a newly fetched recording back
                // to its old text-only version on every GPS update. Keep the
                // newest observation; explicit re-downloads still supersede
                // older nearby responses, and pinned-only stops never expire.
                if let live = entries[spot.id], live.fetchedAt > snapshot.downloadedAt {
                    continue
                }
                all[spot.id] = spot
            }
        }
        return all
    }

    // ─── Spots & tracks ──────────────────────────────────────────────────────

    /// Merge fresh results into the cache and start downloading their audio.
    func absorb(_ spots: [NearbySpot]) {
        ensureLoaded()
        let now = Date()
        for s in spots {
            entries[s.spot.id] = Entry(spot: s, fetchedAt: now)
        }
        persistSpots()
        Task { await self.cacheAudio(for: spots, trackProgress: false) }
    }

    func absorb(tracks: [Track]) {
        ensureLoaded()
        cachedTracks = tracks
        if let data = try? JSONEncoder.iso.encode(tracks) {
            try? data.write(to: tracksURL, options: .atomic)
        }
    }

    func tracksFallback() -> [Track] {
        ensureLoaded()
        var tracks = cachedTracks
        for snapshot in snapshots.values {
            let track = snapshot.bundle.track
            if let index = tracks.firstIndex(where: { $0.id == track.id }) { tracks[index] = track }
            else { tracks.append(track) }
        }
        return tracks
    }

    /// Cache fill-in items (and their audio) so gaps still fill offline —
    /// long silent stretches are exactly where there's often no signal.
    func absorb(fillInItems items: [FillInItem]) {
        ensureLoaded()
        cachedFillIns = items
        if let data = try? JSONEncoder.iso.encode(items) {
            try? data.write(to: fillInURL, options: .atomic)
        }
        guard NarrationPreference.current.prefersServerAudio else { return }
        let urls = items.compactMap { $0.content?.audioUrl }
        Task { await self.downloadMissing(urls, trackProgress: false) }
    }

    func fillInItemsFallback() -> [FillInItem] {
        ensureLoaded()
        let pinnedIds = Set(snapshots.keys)
        return cachedFillIns.filter { !pinnedIds.contains($0.trackId) }
            + snapshots.values.flatMap { $0.bundle.fillInItems }
    }

    /// Manifests cached whole, like the track catalog: sequence eligibility
    /// and completion must keep working offline, where /nearby already does.
    func absorb(manifests: [TrackManifest]) {
        ensureLoaded()
        cachedManifests = manifests
        if let data = try? JSONEncoder.iso.encode(manifests) {
            try? data.write(to: manifestURL, options: .atomic)
        }
    }

    func manifestsFallback() -> [TrackManifest] {
        ensureLoaded()
        let pinnedIds = Set(snapshots.keys)
        return cachedManifests.filter { !pinnedIds.contains($0.trackId) }
            + snapshots.values.map { $0.bundle.manifest }
    }

    var cachedSpotCount: Int {
        ensureLoaded()
        return allCachedSpots.count
    }

    /// Rebuild a nearby list from cache, triggers evaluated on-device.
    /// Locating is dropped: a "look to your left" resolved for some past
    /// course would confidently point the wrong way half the time.
    func offlineNearby(
        at loc: CLLocation,
        radiusM: Double,
        trackSlugs: Set<String>,
        mode: String?
    ) -> [NearbySpot] {
        ensureLoaded()
        var out: [NearbySpot] = []
        for s in allCachedSpots.values {
            guard trackSlugs.isEmpty || trackSlugs.contains(s.track.slug) else { continue }
            // nil = browsing: every spot, whatever mode it is authored for.
            guard mode == nil || s.spot.modes.isEmpty || s.spot.modes.contains(mode!) else { continue }
            // Kind-aware, via the one shared evaluator. An area spot's
            // distance reads 0 while inside its fence, which also keeps it in
            // range even when its centroid sits beyond the search cap (a
            // town-sized fence).
            let (triggered, d) = TriggerEvaluator.evaluate(s.spot.trigger, at: loc)
            guard d <= radiusM else { continue }
            out.append(NearbySpot(
                spot: s.spot,
                track: s.track,
                locating: nil,
                distanceM: d,
                triggered: triggered,
                content: s.content,
                guide: s.guide
            ))
        }
        return out.sorted { $0.distanceM < $1.distanceM }
    }

    /// Point-in-polygon; the math lives in TriggerEvaluator (shared with the
    /// watch), this forwarder keeps existing call sites working.
    static func inside(_ p: CLLocationCoordinate2D, ring: [LngLat]?) -> Bool {
        TriggerEvaluator.inside(p, ring: ring)
    }

    // ─── Audio ───────────────────────────────────────────────────────────────

    /// Local file for a remote audio URL, if we have it.
    func localAudioURL(for remoteURLString: String) -> URL? {
        ensureLoaded()
        let downloaded = downloadedAudioURL(remoteURLString, serverKey: Self.serverKey(serverURL()))
        if hasAudioFile(downloaded) { return downloaded }
        let f = audioDir.appendingPathComponent(Self.fileName(for: remoteURLString))
        return hasAudioFile(f) ? f : nil
    }

    /// Download every audio file the given spots reference that isn't
    /// already on disk. `trackProgress` drives the journey UI; the passive
    /// post-fetch caching stays silent.
    ///
    /// Locating clips are tiny and always worth having, but narration audio
    /// is skipped when the traveler prefers the on-device voice — no point
    /// spending the download and the disk space on a recording that won't
    /// be played.
    func cacheAudio(for spots: [NearbySpot], trackProgress: Bool) async {
        ensureLoaded()
        let wantNarration = NarrationPreference.current.prefersServerAudio
        var wanted: [String] = []
        for s in spots {
            if wantNarration, let u = s.content?.audioUrl { wanted.append(u) }
            if let u = s.locating?.audioUrl { wanted.append(u) }
        }
        await downloadMissing(wanted, trackProgress: trackProgress)
    }

    /// Fetch one audio URL into the cache right now — the play-time path for
    /// a spot whose prefetch hasn't caught up. Returns the local file, or nil
    /// on failure; callers fall back to the on-device voice. Narration is
    /// never streamed: a flaky cellular link turns streaming into stutter
    /// and silent starts, which is exactly what field drives hit.
    func ensureCached(
        _ urlString: String,
        api: GrandTourAPI,
        timeoutS: TimeInterval = 8
    ) async -> URL? {
        ensureLoaded()
        if let local = localAudioURL(for: urlString) { return local }
        guard let remote = api.resolveAudioURL(urlString) else { return nil }
        var req = URLRequest(url: remote)
        req.timeoutInterval = timeoutS
        do {
            let (tmp, resp) = try await URLSession.shared.download(for: req)
            guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
                TourDiagnostics.shared.log("audio_cache_failed", [
                    "url": urlString,
                    "status": (resp as? HTTPURLResponse)?.statusCode ?? -1,
                ])
                return nil
            }
            let dest = audioDir.appendingPathComponent(Self.fileName(for: urlString))
            try? FileManager.default.removeItem(at: dest)
            try FileManager.default.moveItem(at: tmp, to: dest)
            return dest
        } catch {
            TourDiagnostics.shared.log("audio_cache_failed", [
                "url": urlString, "error": error.localizedDescription,
            ])
            return nil
        }
    }

    /// The shared download loop: fetch every wanted URL not already on disk.
    private func downloadMissing(_ wanted: [String], trackProgress: Bool) async {
        let api = GrandTourAPI()
        let missing = wanted.filter {
            localAudioURL(for: $0) == nil && !inFlight.contains($0)
        }
        guard !missing.isEmpty else {
            if trackProgress { audioProgress = (wanted.count, wanted.count) }
            return
        }
        if trackProgress { audioProgress = (wanted.count - missing.count, wanted.count) }

        for urlString in missing {
            inFlight.insert(urlString)
            defer { inFlight.remove(urlString) }
            guard let remote = api.resolveAudioURL(urlString) else { continue }
            do {
                let (tmp, resp) = try await URLSession.shared.download(from: remote)
                guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
                    TourDiagnostics.shared.log("audio_cache_failed", [
                        "url": urlString,
                        "status": (resp as? HTTPURLResponse)?.statusCode ?? -1,
                    ])
                    continue
                }
                let dest = audioDir.appendingPathComponent(Self.fileName(for: urlString))
                try? FileManager.default.removeItem(at: dest)
                try FileManager.default.moveItem(at: tmp, to: dest)
            } catch {
                TourDiagnostics.shared.log("audio_cache_failed", [
                    "url": urlString, "error": error.localizedDescription,
                ])
            }
            if trackProgress, let p = audioProgress {
                audioProgress = (p.done + 1, p.total)
            }
        }
    }

    func clearAudioProgress() { audioProgress = nil }

    /// Stable filename from the URL path — hosts vary (localhost vs tailnet),
    /// paths don't.
    private static func fileName(for urlString: String) -> String {
        let path = URL(string: urlString)?.path ?? urlString
        return path.replacingOccurrences(of: "/", with: "_")
    }
}

/// ISO-8601 coders matching the server's date strings.
extension JSONDecoder {
    static var iso: JSONDecoder {
        let d = JSONDecoder()
        let precise = ISO8601DateFormatter()
        precise.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let legacy = ISO8601DateFormatter()
        d.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let value = try container.decode(String.self)
            guard let date = precise.date(from: value) ?? legacy.date(from: value) else {
                throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid cache date")
            }
            return date
        }
        return d
    }
}

extension JSONEncoder {
    static var iso: JSONEncoder {
        let e = JSONEncoder()
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        // Preserve ordering when a nearby refresh and download complete in
        // the same second. The decoder also accepts older whole-second files.
        e.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(formatter.string(from: date))
        }
        return e
    }
}
