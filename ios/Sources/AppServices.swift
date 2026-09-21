import Foundation
import Combine

/// Process-wide services shared by every scene. The phone UI and the CarPlay
/// scene must drive the SAME tour — one audio player, one scheduler, one
/// location pipeline — and scenes connect in any order (CarPlay can launch
/// the app with the phone still in a pocket), so ownership can't live in a
/// view. ContentView and CarPlaySceneDelegate both read from here.
@MainActor
final class AppServices {
    static let shared = AppServices()

    let location = LocationManager()
    let tour = TourViewModel()
    let journey = JourneyPlanner()
    let recordings = RecordingLibrary(directory: RecordingEngine.recordingsDir)
    private lazy var recordingSync = RecordingSync(library: recordings)
    /// Lock screen / Control Center / CarPlay Now Playing and remote commands.
    /// Also the home of the start/stop-tour, skip and replay actions the
    /// CarPlay templates share with the head-unit buttons.
    let nowPlaying: NowPlayingController

    private var cancellables: Set<AnyCancellable> = []
    private var bootstrapped = false

    private init() {
        nowPlaying = NowPlayingController(tour: tour, location: location)
        // Location drives the tour no matter which scene is up. This lived in
        // ContentView.onChange before, which only worked with the phone UI on
        // screen.
        location.$location
            .compactMap { $0 }
            .sink { [tour] loc in
                Task { await tour.locationDidUpdate(loc) }
            }
            .store(in: &cancellables)
    }

    /// Idempotent startup shared by every scene: begin foreground location,
    /// publish Now Playing state, and load the track catalog. The first scene
    /// to appear does the work; later scenes and reconnects are no-ops.
    func bootstrap() {
        guard !bootstrapped else { return }
        bootstrapped = true
        location.startBrowsing()
        nowPlaying.start()
        recordings.onUpload = { [weak self] in
            Task { await self?.tour.loadTracks() }
        }
        recordingSync.start()
        Task { await tour.loadTracks() }
        // `GRANDTOUR_AUTOSTART_TOUR=1` (simulator launch env; the watch app
        // has the same switch) turns the tour on without a tap, so headless
        // runs can exercise playback, keepalive and diagnostics.
        if ProcessInfo.processInfo.environment["GRANDTOUR_AUTOSTART_TOUR"] == "1" {
            nowPlaying.startTour()
        }
    }
}
