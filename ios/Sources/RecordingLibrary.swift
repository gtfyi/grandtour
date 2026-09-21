import Foundation
import Combine

/// A stable local identity survives the later assignment of a server track ID.
struct RecordingTrack: Codable, Identifiable {
    let id: String
    var name: String
    var serverURL: URL?
    var remoteTrack: Track?
    var createdLocally: Bool
    var needsServerMatch = false
    var spots: [Spot] = []
}

struct LocalRecording: Codable, Identifiable {
    let id: String
    var trackID: String
    let audioFilename: String
    var meta: CreatorSpotMeta
    var remoteSpot: Spot?
    var uploadAttempted: Bool?
}

enum RecordingLibraryError: LocalizedError {
    case unconfirmedUpload
    var errorDescription: String? {
        "This recording may already be on its server. Reconnect and finish uploading before deleting it."
    }
}

/// Authoring is local first. Every mutation commits atomically before the UI
/// reports success or a network request starts. Audio remains on disk after
/// upload, so recordings can still be reviewed without their server.
@MainActor
final class RecordingLibrary: ObservableObject {
    struct State: Codable {
        var tracks: [RecordingTrack] = []
        var recordings: [LocalRecording] = []
        var selectedTrackID: String?
    }

    @Published private var state = State()
    @Published private(set) var isSyncing = false
    @Published private(set) var syncMessage: String?
    private(set) var storageError: Error?
    let directory: URL
    private let serverURL: () -> URL
    private let makeAPI: (URL) -> GrandTourAPI
    private let write: (Data, URL) throws -> Void
    private var libraryURL: URL { directory.appendingPathComponent("library.json") }
    var onUpload: (() -> Void)?

    var tracks: [RecordingTrack] { state.tracks }
    var recordings: [LocalRecording] { state.recordings }
    var selectedTrackID: String? { state.selectedTrackID }
    var pendingCount: Int {
        state.recordings.filter { $0.remoteSpot == nil }.count
        + state.tracks.filter { $0.remoteTrack == nil }.count
    }

    init(directory: URL, serverURL: @escaping () -> URL = { ServerPreference.currentURL },
         makeAPI: @escaping (URL) -> GrandTourAPI = { GrandTourAPI(baseURL: $0) },
         write: @escaping (Data, URL) throws -> Void = { try $0.write(to: $1, options: .atomic) }) {
        self.directory = directory
        self.serverURL = serverURL
        self.makeAPI = makeAPI
        self.write = write
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            if FileManager.default.fileExists(atPath: libraryURL.path) {
                state = try JSONDecoder().decode(State.self, from: Data(contentsOf: libraryURL))
            }
            try importLegacyTakes()
        } catch {
            storageError = error
            syncMessage = "Couldn’t read the recordings saved on this phone. Your files have been kept."
        }
    }

    private func commit(_ change: (inout State) -> Void) throws {
        if let storageError { throw storageError }
        var next = state
        change(&next)
        try write(JSONEncoder().encode(next), libraryURL)
        state = next
    }

    func availableTracks() -> [RecordingTrack] {
        tracks.filter { $0.createdLocally || $0.serverURL == serverURL() }
    }

    @discardableResult
    func createTrack(named name: String) throws -> RecordingTrack {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name.utf16.count <= 120 else { throw CocoaError(.fileWriteInvalidFileName) }
        let track = RecordingTrack(id: UUID().uuidString, name: name, createdLocally: true)
        try commit { $0.tracks.insert(track, at: 0); $0.selectedTrackID = track.id }
        return track
    }

    func selectTrack(_ id: String) throws {
        try commit { $0.selectedTrackID = id }
    }

    func audioURL(for recording: LocalRecording) -> URL {
        directory.appendingPathComponent(recording.audioFilename)
    }

    /// The recorder writes directly to this directory; do not clear its take
    /// until the matching metadata has been committed here.
    @discardableResult
    func saveRecording(trackID: String, meta: CreatorSpotMeta, audioURL: URL) throws -> LocalRecording {
        guard state.tracks.contains(where: { $0.id == trackID }),
              audioURL.deletingLastPathComponent().standardizedFileURL == directory.standardizedFileURL,
              FileManager.default.fileExists(atPath: audioURL.path) else { throw CocoaError(.fileNoSuchFile) }
        let id = UUID().uuidString
        var meta = meta
        meta.clientId = id
        let recording = LocalRecording(id: id, trackID: trackID,
                                       audioFilename: audioURL.lastPathComponent, meta: meta)
        try commit { $0.recordings.append(recording) }
        return recording
    }

    func deleteLocalRecording(_ id: String) throws {
        guard !isSyncing, let recording = recordings.first(where: { $0.id == id }) else { return }
        guard recording.remoteSpot == nil, recording.uploadAttempted != true else {
            throw RecordingLibraryError.unconfirmedUpload
        }
        try commit { $0.recordings.removeAll { $0.id == id } }
        try? FileManager.default.removeItem(at: audioURL(for: recording))
    }

    /// Pin the API and persist destination BEFORE sending anything. A server
    /// switch or a lost response must never move a queued take to another host.
    func sync(refreshCatalog: Bool = false) async {
        guard !isSyncing, storageError == nil, refreshCatalog || pendingCount > 0 else { return }
        isSyncing = true
        defer { isSyncing = false }
        let destination = serverURL()
        let api = makeAPI(destination)
        var uploaded = false
        defer { if uploaded { onUpload?() } }
        do {
            try await api.checkRecordingUploads()
            let catalog = try await api.tracks().filter { !$0.isFillIn }
            try mergeCatalog(catalog, server: destination)
            // Snapshot only IDs. Recording can continue while this task awaits
            // the server; each commit edits the current state, never a stale copy.
            let trackIDs = tracks.map(\.id)
            var failures = 0
            for id in trackIDs {
                guard serverURL() == destination else { break }
                guard var track = tracks.first(where: { $0.id == id }),
                      !track.needsServerMatch,
                      track.serverURL == nil || track.serverURL == destination else { continue }
                do {
                    if track.remoteTrack == nil {
                        try commit { state in
                            if let i = state.tracks.firstIndex(where: { $0.id == id }) {
                                state.tracks[i].serverURL = destination
                            }
                        }
                        let remote = try await api.createTrack(name: track.name, clientId: track.id)
                        try commit { state in
                            if let i = state.tracks.firstIndex(where: { $0.id == id }) {
                                state.tracks[i].remoteTrack = remote
                                // A previous response may have been lost, leaving
                                // a catalog copy of this same remote track.
                                let duplicateIDs = Set(state.tracks.filter {
                                    $0.id != id && $0.serverURL == destination && $0.remoteTrack?.id == remote.id
                                }.map(\.id))
                                for n in state.recordings.indices where duplicateIDs.contains(state.recordings[n].trackID) {
                                    state.recordings[n].trackID = id
                                }
                                state.tracks.removeAll { duplicateIDs.contains($0.id) }
                                if let selected = state.selectedTrackID, duplicateIDs.contains(selected) {
                                    state.selectedTrackID = id
                                }
                            }
                        }
                        track.remoteTrack = remote
                        uploaded = true
                    }
                    guard let remote = track.remoteTrack else { continue }
                    let pending = recordings.filter { $0.trackID == id && $0.remoteSpot == nil }
                    for recording in pending {
                        guard serverURL() == destination else { break }
                        do {
                            var meta = recording.meta
                            meta.trackId = remote.id
                            try commit { state in
                                if let i = state.recordings.firstIndex(where: { $0.id == recording.id }) {
                                    state.recordings[i].uploadAttempted = true
                                }
                            }
                            let spot = try await api.createSpot(meta: meta, audioFileURL: audioURL(for: recording))
                            try commit { state in
                                if let i = state.recordings.firstIndex(where: { $0.id == recording.id }) {
                                    state.recordings[i].remoteSpot = spot
                                }
                            }
                            uploaded = true
                        } catch { failures += 1 }
                    }
                } catch { failures += 1 }
            }
            if failures > 0 {
                syncMessage = "Some recordings are still waiting to upload. They’re safe on this phone; we’ll retry when connected."
            } else if pendingCount > 0 {
                syncMessage = "Saved on this phone. Connect to the original server to upload the remaining recordings."
            } else {
                syncMessage = "Saved on this phone and uploaded to \(destination.host ?? destination.absoluteString)."
            }
        } catch let error as CreatorAPIError {
            syncMessage = error.localizedDescription
        } catch {
            syncMessage = "Saved on this phone. Uploads resume automatically when the server is reachable."
        }
    }

    func refreshSpots(trackID: String) async {
        guard let track = tracks.first(where: { $0.id == trackID }),
              let remote = track.remoteTrack, let server = track.serverURL,
              server == serverURL() else { return }
        do {
            let spots = try await makeAPI(server).creatorSpots(trackId: remote.id)
            try commit { state in
                if let i = state.tracks.firstIndex(where: { $0.id == trackID }) { state.tracks[i].spots = spots }
            }
        } catch { /* Cached spots and local recordings remain usable offline. */ }
    }

    func deleteSpot(_ spot: Spot, trackID: String) async throws {
        guard !isSyncing, let track = tracks.first(where: { $0.id == trackID }),
              let server = track.serverURL else { return }
        // Always use the track's actual host, even if the selected server changed.
        try await makeAPI(server).deleteCreatorSpot(id: spot.id)
        let local = recordings.filter { $0.trackID == trackID && $0.remoteSpot?.id == spot.id }
        try commit { state in
            if let i = state.tracks.firstIndex(where: { $0.id == trackID }) {
                state.tracks[i].spots.removeAll { $0.id == spot.id }
            }
            state.recordings.removeAll { $0.trackID == trackID && $0.remoteSpot?.id == spot.id }
        }
        for recording in local { try? FileManager.default.removeItem(at: audioURL(for: recording)) }
    }

    private func mergeCatalog(_ catalog: [Track], server: URL) throws {
        try commit { state in
            for remote in catalog {
                if let i = state.tracks.firstIndex(where: {
                    $0.remoteTrack?.id == remote.id && ($0.serverURL == server || $0.needsServerMatch)
                }) {
                    state.tracks[i].remoteTrack = remote
                    state.tracks[i].name = remote.name
                    state.tracks[i].serverURL = server
                    state.tracks[i].needsServerMatch = false
                } else {
                    state.tracks.append(RecordingTrack(id: UUID().uuidString, name: remote.name,
                        serverURL: server, remoteTrack: remote, createdLocally: false))
                }
            }
        }
    }

    /// Old versions only had .m4a + CreatorSpotMeta sidecars, with no server
    /// identity. Retain them and require a matching server track before upload.
    private func importLegacyTakes() throws {
        let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
        var next = state
        for sidecar in files where sidecar.pathExtension == "json" && sidecar != libraryURL {
            let audio = sidecar.deletingPathExtension().appendingPathExtension("m4a")
            guard !next.recordings.contains(where: { $0.audioFilename == audio.lastPathComponent }),
                  FileManager.default.fileExists(atPath: audio.path),
                  var meta = try? JSONDecoder().decode(CreatorSpotMeta.self, from: Data(contentsOf: sidecar)) else { continue }
            var track = next.tracks.first { $0.remoteTrack?.id == meta.trackId }
            if track == nil {
                let remote = Track(id: meta.trackId, slug: "", name: "Recovered recordings", description: "",
                                   kind: "tour", icon: nil, color: nil, official: false)
                track = RecordingTrack(id: UUID().uuidString, name: remote.name, remoteTrack: remote,
                                       createdLocally: true, needsServerMatch: true)
                next.tracks.append(track!)
            }
            let id = meta.clientId ?? UUID().uuidString
            meta.clientId = id
            next.recordings.append(LocalRecording(id: id, trackID: track!.id,
                                                  audioFilename: audio.lastPathComponent, meta: meta))
        }
        if next.recordings.count != state.recordings.count {
            try write(JSONEncoder().encode(next), libraryURL)
            state = next
        }
        // Only retire legacy sidecars after the durable library contains them.
        for recording in state.recordings {
            let sidecar = audioURL(for: recording).deletingPathExtension().appendingPathExtension("json")
            if sidecar != libraryURL { try? FileManager.default.removeItem(at: sidecar) }
        }
    }
}
