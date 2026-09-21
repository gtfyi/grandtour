import Foundation

/// Persistent record of series-track completions. Completion itself is
/// *derived* (manifest units ∩ PlayHistory), but the moment of completion is
/// *stored*: PlayHistory prunes idle entries after 180 days, and a finished
/// track must not silently "un-complete" because its plays aged out. What
/// does un-complete it is new content — a manifest with more units, or one
/// updated after `completedAt` (see TourViewModel.reconcileCompletions).
///
/// Not actor-isolated on purpose, like PlayHistory: everything runs on the
/// main thread, and keeping it Foundation-only leaves it shareable with the
/// watch target.
final class TrackProgress {
    static let shared = TrackProgress()

    struct Completion: Codable {
        var completedAt: Date
        /// Manifest unit count at completion; a bigger manifest later means
        /// new content arrived.
        var unitCount: Int
    }

    private static let key = "trackCompletions"

    private var completions: [String: Completion] // by track slug
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        if let data = defaults.data(forKey: Self.key),
           let decoded = try? JSONDecoder().decode([String: Completion].self, from: data) {
            completions = decoded
        } else {
            completions = [:]
        }
    }

    func completion(_ slug: String) -> Completion? {
        completions[slug]
    }

    func markCompleted(slug: String, unitCount: Int, at date: Date = Date()) {
        completions[slug] = Completion(completedAt: date, unitCount: unitCount)
        save()
    }

    func clearCompletion(_ slug: String) {
        completions.removeValue(forKey: slug)
        save()
    }

    private func save() {
        guard let data = try? JSONEncoder().encode(completions) else { return }
        defaults.set(data, forKey: Self.key)
    }
}
