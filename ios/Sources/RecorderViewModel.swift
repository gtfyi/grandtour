import Foundation
import CoreLocation
import Combine

/// Recording controls backed by a durable, process-wide authoring library.
@MainActor
final class RecorderViewModel: ObservableObject {
    let engine = RecordingEngine()
    let library: RecordingLibrary
    @Published var take: Take?
    @Published var takeTitle = ""
    @Published var isSaving = false
    @Published var error: String?
    @Published var micDenied = false
    private var subscriptions: Set<AnyCancellable> = []
    private let geocoder = CLGeocoder()
    private var takeTrackID: String?
    private var takeStartedAt = Date()

    init(library: RecordingLibrary? = nil) {
        self.library = library ?? AppServices.shared.recordings
        self.library.objectWillChange.sink { [weak self] in self?.objectWillChange.send() }
            .store(in: &subscriptions)
        engine.objectWillChange.sink { [weak self] in self?.objectWillChange.send() }
            .store(in: &subscriptions)
        NotificationCenter.default.publisher(for: ServerPreference.didChange).sink { [weak self] _ in
            Task { @MainActor [weak self] in await self?.loadTracks() }
        }.store(in: &subscriptions)
    }

    var tracks: [RecordingTrack] { library.availableTracks() }
    var selectedTrack: RecordingTrack? {
        tracks.first { $0.id == library.selectedTrackID } ?? tracks.first
    }
    var localRecordings: [LocalRecording] {
        library.recordings.filter { $0.trackID == selectedTrack?.id }.reversed()
    }
    var spots: [Spot] {
        let localIDs = Set(localRecordings.compactMap { $0.remoteSpot?.id })
        return (selectedTrack?.spots ?? []).filter { !localIDs.contains($0.id) }
    }
    var canEnablePlayback: Bool {
        selectedTrack?.remoteTrack != nil && selectedTrack?.serverURL == ServerPreference.currentURL
    }

    struct Take {
        let fileURL: URL
        let durationMs: Double
        let location: CLLocation?
        let recordedAt: Date
    }

    func loadTracks() async {
        if let storageError = library.storageError { error = storageError.localizedDescription }
        await library.sync(refreshCatalog: true)
        await loadSpots()
    }

    func createTrack(named name: String) async {
        do {
            _ = try library.createTrack(named: name)
            error = nil
            Task { await library.sync() }
        } catch {
            self.error = "Couldn’t save the track on this phone. Use a name of 1–120 characters and check available storage."
        }
    }

    func selectTrack(_ track: RecordingTrack) {
        guard !engine.isRecording, take == nil else { return }
        do { try library.selectTrack(track.id) }
        catch { self.error = "Couldn’t save your track selection." }
        Task { await loadSpots() }
    }

    func loadSpots() async {
        if let track = selectedTrack { await library.refreshSpots(trackID: track.id) }
    }

    // MARK: Recording

    func beginTake() async {
        guard let track = selectedTrack, take == nil, !engine.isRecording else { return }
        error = nil
        takeTrackID = track.id
        TourDiagnostics.shared.log("record_take_requested", [:])
        let permitted = await RecordingEngine.requestPermission()
        TourDiagnostics.shared.log("record_permission", ["granted": permitted])
        guard permitted else {
            micDenied = true
            return
        }
        guard engine.start() != nil else {
            error = "Couldn't start recording — is another app using the microphone?"
            return
        }
        takeLocation = AppServices.shared.location.location
        takeStartedAt = Date()
    }

    /// The fix at record start; a walker drifts while narrating.
    private var takeLocation: CLLocation?

    func endTake() async {
        guard let stopped = engine.stop() else {
            // Too short to keep. Nothing to name.
            engine.finish()
            return
        }
        let location = takeLocation ?? AppServices.shared.location.location
        take = Take(
            fileURL: stopped.fileURL,
            durationMs: stopped.durationMs,
            location: location,
            recordedAt: takeStartedAt
        )
        takeTitle = ""
        takeTitle = defaultTitle()
        if let location { Task { await suggestTitle(for: location) } }
    }

    private func defaultTitle() -> String {
        "Spot \(spots.count + localRecordings.count + 1)"
    }

    /// Prefill the title with the nearest address/place name; purely a
    /// convenience, freely editable, and skipped silently offline.
    private func suggestTitle(for location: CLLocation) async {
        guard let originalFile = take?.fileURL else { return }
        let originalTitle = takeTitle
        guard let placemark = try? await geocoder.reverseGeocodeLocation(location).first else { return }
        let suggestion = placemark.name ?? placemark.thoroughfare ?? placemark.locality
        if let suggestion, !suggestion.isEmpty, take?.fileURL == originalFile, takeTitle == originalTitle {
            takeTitle = suggestion
        }
    }

    func discardTake() {
        if engine.isRecording, let stopped = engine.stop() {
            try? FileManager.default.removeItem(at: stopped.fileURL)
        }
        if let take { try? FileManager.default.removeItem(at: take.fileURL) }
        take = nil
        takeTrackID = nil
        geocoder.cancelGeocode()
        engine.finish()
    }

    func saveTake() async {
        guard !isSaving, let take, let id = takeTrackID ?? selectedTrack?.id,
              let track = library.tracks.first(where: { $0.id == id }),
              let location = take.location, location.horizontalAccuracy >= 0 else { return }
        let meta = makeMeta(for: take, track: track)
        guard meta.title.utf16.count <= 200 else {
            error = "Use a spot name of 200 characters or fewer. Your recording is still here."
            return
        }
        isSaving = true
        defer { isSaving = false }
        do {
            _ = try library.saveRecording(trackID: track.id, meta: meta, audioURL: take.fileURL)
            self.take = nil
            takeTrackID = nil
            geocoder.cancelGeocode()
            engine.finish()
            error = nil
            Task { await library.sync() }
        } catch {
            // Keep the take and its audio available for another save attempt.
            self.error = "Couldn’t save this recording on the phone. Free some storage and try Save again."
        }
    }

    private func makeMeta(for take: Take, track: RecordingTrack) -> CreatorSpotMeta {
        let coord = take.location?.coordinate
        var meta = CreatorSpotMeta(
            trackId: track.id,
            title: takeTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? defaultTitle()
                : takeTitle.trimmingCharacters(in: .whitespacesAndNewlines),
            lat: coord?.latitude ?? 0,
            lng: coord?.longitude ?? 0
        )
        meta.durationMs = take.durationMs
        meta.recordedAt = ISO8601DateFormatter().string(from: take.recordedAt)
        if let loc = take.location {
            if loc.course >= 0 { meta.courseDeg = min(loc.course, 360) }
            if loc.speed >= 0 { meta.speedMps = loc.speed }
            meta.altitudeM = loc.altitude
            if loc.horizontalAccuracy >= 0 { meta.horizontalAccuracyM = loc.horizontalAccuracy }
        }
        return meta
    }

    func deleteSpot(_ spot: Spot) async {
        guard let track = selectedTrack else { return }
        do { try await library.deleteSpot(spot, trackID: track.id) }
        catch { self.error = "Couldn’t delete “\(spot.title)” — check the connection." }
    }

    func deleteRecording(_ recording: LocalRecording) async {
        do {
            if let spot = recording.remoteSpot {
                try await library.deleteSpot(spot, trackID: recording.trackID)
            } else {
                try library.deleteLocalRecording(recording.id)
            }
        } catch let error as RecordingLibraryError {
            self.error = error.localizedDescription
        } catch { self.error = "Couldn’t delete this recording. It has been kept." }
    }

    func retryPending() async {
        await library.sync(refreshCatalog: true)
        await loadSpots()
    }
}
