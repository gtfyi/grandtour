import Foundation
import Combine
import Network
import UIKit

/// iOS may suspend us in the background. Retry on foreground, network changes,
/// server selection and periodically while running (a server can return while
/// the network path itself remains unchanged).
@MainActor
final class RecordingSync {
    private let library: RecordingLibrary
    private let monitor = NWPathMonitor()
    private var subscriptions: Set<AnyCancellable> = []
    private var started = false

    init(library: RecordingLibrary) { self.library = library }

    func start() {
        guard !started else { return }
        started = true
        monitor.pathUpdateHandler = { [weak self] path in
            guard path.status == .satisfied else { return }
            Task { @MainActor [weak self] in await self?.library.sync() }
        }
        monitor.start(queue: DispatchQueue(label: "GrandTour.recordingConnection"))
        for name in [UIApplication.didBecomeActiveNotification, ServerPreference.didChange] {
            NotificationCenter.default.publisher(for: name).sink { [weak self] _ in
                Task { @MainActor [weak self] in await self?.library.sync() }
            }.store(in: &subscriptions)
        }
        Timer.publish(every: 30, on: .main, in: .common).autoconnect().sink { [weak self] _ in
            Task { @MainActor [weak self] in await self?.library.sync() }
        }.store(in: &subscriptions)
        Task { await library.sync() }
    }

    deinit { monitor.cancel() }
}
