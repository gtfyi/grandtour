import SwiftUI

@main
struct GrandTourApp: App {
    init() {
        // Claim the audio route for the whole run — GrandTour is the primary
        // audio app from launch, not just while a spot is narrating — and
        // start logging what the route does, so a field drive can be read.
        AudioSession.startMonitoring()
        AudioSession.takeOver()
        // Remote playback can launch the process before any phone view
        // appears. Register commands and hydrate the tour at process launch.
        AppServices.shared.bootstrap()
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
