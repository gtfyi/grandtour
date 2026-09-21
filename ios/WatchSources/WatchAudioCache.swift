import Foundation
import Combine

/// Audio-file cache for the watch — the audio-only slice of the phone's
/// TourCache. Same rule as everywhere else in GrandTour: narration is NEVER
/// streamed. A spot plays from a local file or falls back to the on-device
/// voice; this cache is how files get local. No spot/track persistence in
/// v1 (that's the phone's offline story); the engine keeps its last nearby
/// list in memory instead.
@MainActor
final class WatchAudioCache: ObservableObject {
    static let shared = WatchAudioCache()

    /// Prefetch progress for the settings screen's download button.
    @Published private(set) var progress: (done: Int, total: Int)?

    /// Remote URL paths currently being downloaded, to dedupe requests.
    private var inFlight: Set<String> = []
    private var dirReady = false

    private let audioDir: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("GrandTour/audio", isDirectory: true)
    }()

    private func ensureDir() {
        guard !dirReady else { return }
        dirReady = true
        try? FileManager.default.createDirectory(at: audioDir, withIntermediateDirectories: true)
    }

    /// Local file for a remote audio URL, if we have it.
    func localAudioURL(for remoteURLString: String) -> URL? {
        ensureDir()
        let f = audioDir.appendingPathComponent(Self.fileName(for: remoteURLString))
        return FileManager.default.fileExists(atPath: f.path) ? f : nil
    }

    /// Fetch one audio URL into the cache right now — the play-time path for
    /// a spot whose prefetch hasn't caught up. Returns the local file, or nil
    /// on failure; callers fall back to the on-device voice.
    func ensureCached(
        _ urlString: String,
        api: GrandTourAPI,
        timeoutS: TimeInterval = 8
    ) async -> URL? {
        ensureDir()
        if let local = localAudioURL(for: urlString) { return local }
        guard let remote = api.resolveAudioURL(urlString) else { return nil }
        var req = URLRequest(url: remote)
        req.timeoutInterval = timeoutS
        do {
            let (tmp, resp) = try await URLSession.shared.download(for: req)
            guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
                return nil
            }
            let dest = audioDir.appendingPathComponent(Self.fileName(for: urlString))
            try? FileManager.default.removeItem(at: dest)
            try FileManager.default.moveItem(at: tmp, to: dest)
            return dest
        } catch {
            print("WatchAudioCache: download failed for \(urlString): \(error.localizedDescription)")
            return nil
        }
    }

    /// Download every audio file the given spots reference that isn't
    /// already on disk. Locating clips are tiny and always worth having;
    /// narration is skipped when the traveler prefers the on-device voice.
    func cacheAudio(for spots: [NearbySpot], trackProgress: Bool = false) async {
        let wantNarration = NarrationPreference.current.prefersServerAudio
        var wanted: [String] = []
        for s in spots {
            if wantNarration, let u = s.content?.audioUrl { wanted.append(u) }
            if let u = s.locating?.audioUrl { wanted.append(u) }
        }
        await downloadMissing(wanted, trackProgress: trackProgress)
    }

    private func downloadMissing(_ wanted: [String], trackProgress: Bool) async {
        ensureDir()
        let api = GrandTourAPI()
        let missing = wanted.filter {
            localAudioURL(for: $0) == nil && !inFlight.contains($0)
        }
        guard !missing.isEmpty else {
            if trackProgress { progress = (wanted.count, wanted.count) }
            return
        }
        if trackProgress { progress = (wanted.count - missing.count, wanted.count) }

        for urlString in missing {
            inFlight.insert(urlString)
            defer { inFlight.remove(urlString) }
            guard let remote = api.resolveAudioURL(urlString) else { continue }
            do {
                let (tmp, resp) = try await URLSession.shared.download(from: remote)
                guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else { continue }
                let dest = audioDir.appendingPathComponent(Self.fileName(for: urlString))
                try? FileManager.default.removeItem(at: dest)
                try FileManager.default.moveItem(at: tmp, to: dest)
            } catch {
                print("WatchAudioCache: download failed for \(urlString): \(error.localizedDescription)")
            }
            if trackProgress, let p = progress {
                progress = (p.done + 1, p.total)
            }
        }
    }

    func clearProgress() { progress = nil }

    /// Stable filename from the URL path — hosts vary (localhost vs tailnet),
    /// paths don't. Matches the phone's TourCache scheme.
    private static func fileName(for urlString: String) -> String {
        let path = URL(string: urlString)?.path ?? urlString
        return path.replacingOccurrences(of: "/", with: "_")
    }
}
