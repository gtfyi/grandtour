import SwiftUI

@main
struct GrandTourWatchApp: App {
    var body: some Scene {
        WindowGroup {
            WatchRootView()
                .task {
                    WatchAppServices.shared.bootstrap()
                    // Simulator-testing hook (same spirit as the phone's
                    // GRANDTOUR_FILLIN_GAP_S): start the tour on launch so
                    // headless runs can exercise the loop without a tap.
                    // Skips the workout session too — its HealthKit prompt
                    // can't be answered in a headless run.
                    if ProcessInfo.processInfo.environment["GRANDTOUR_AUTOSTART_TOUR"] == "1" {
                        _ = await WatchAppServices.shared.startTour(skipWorkout: true)
                    }
                }
        }
    }
}
