import Foundation
import Combine

/// Process-wide services for the watch app — the watch mirror of the phone's
/// AppServices: one location pipeline, one engine, wired together no matter
/// which screen is up.
@MainActor
final class WatchAppServices {
    static let shared = WatchAppServices()

    let location = WatchLocationManager()
    let engine = WatchTourEngine()

    private var cancellables: Set<AnyCancellable> = []
    private var bootstrapped = false

    private init() {
        location.$location
            .compactMap { $0 }
            .sink { [engine] loc in
                Task { await engine.locationDidUpdate(loc) }
            }
            .store(in: &cancellables)
    }

    /// Idempotent startup: begin foreground location and load the catalog.
    func bootstrap() {
        guard !bootstrapped else { return }
        bootstrapped = true
        location.startBrowsing()
        Task { await engine.loadTracks() }
    }

    /// Tour ON: audio route + workout + GPS, in that order — the engine's
    /// half is fallible (headphones), and GPS only tightens once it starts.
    /// `skipWorkout` is for headless simulator runs (no HealthKit prompt).
    func startTour(skipWorkout: Bool = false) async -> Bool {
        let ok = await engine.startTour(at: location.location, skipWorkout: skipWorkout)
        if ok { location.startTour() }
        return ok
    }

    func stopTour() {
        engine.stopTour()
        location.stopTour()
    }
}
