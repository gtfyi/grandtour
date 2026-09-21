import Foundation

/// Persistent per-spot play history: how many times each spot's narration has
/// started, and when it last did. The decision point consults this so the
/// tour keeps surfacing stories the traveler hasn't heard — a spot never
/// played outranks one played last week, which outranks one played this
/// morning — and so a story heard only hours ago isn't replayed at all.
/// The replay cooldown it feeds also covers the immediate case (standing in
/// a trigger after the story played); this is the across-sessions memory
/// that survives app restarts.
///
/// Not actor-isolated on purpose: the scheduler reads it through plain
/// closures in `SpotScheduler.Context`, and everything — view model and
/// scheduler alike — runs on the main thread.
final class PlayHistory {
    static let shared = PlayHistory()

    struct Record: Codable {
        var playCount: Int
        var lastPlayedAt: Date
    }

    private static let key = "spotPlayHistory"
    /// Entries idle this long are dropped on load: a spot not heard in half a
    /// year is effectively new again, and the store stays bounded.
    private static let retentionS: TimeInterval = 180 * 24 * 3600

    private var records: [String: Record]
    /// nil: an in-memory history — a demo's, remembered for as long as it runs.
    private let defaults: UserDefaults?

    init(defaults: UserDefaults? = .standard) {
        self.defaults = defaults
        let now = Date()
        if let data = defaults?.data(forKey: Self.key),
           let decoded = try? JSONDecoder().decode([String: Record].self, from: data) {
            records = decoded.filter {
                now.timeIntervalSince($0.value.lastPlayedAt) < Self.retentionS
            }
        } else {
            records = [:]
        }
    }

    /// Call when a spot's narration starts (auto or manual — heard is heard).
    func recordPlay(spotId: String, at date: Date = Date()) {
        var r = records[spotId] ?? Record(playCount: 0, lastPlayedAt: date)
        r.playCount += 1
        r.lastPlayedAt = date
        records[spotId] = r
        save()
    }

    func playCount(_ spotId: String) -> Int {
        records[spotId]?.playCount ?? 0
    }

    func lastPlayedAt(_ spotId: String) -> Date? {
        records[spotId]?.lastPlayedAt
    }

    func playedWithin(_ interval: TimeInterval, spotId: String, now: Date = Date()) -> Bool {
        guard let last = records[spotId]?.lastPlayedAt else { return false }
        return now.timeIntervalSince(last) < interval
    }

    /// Forget a set of units — "start over" on a completed series track wipes
    /// exactly that track's history so its stories count as never heard.
    func removeAll(ids: some Sequence<String>) {
        for id in ids { records.removeValue(forKey: id) }
        save()
    }

    /// A history that loads nothing and saves nothing: what a demo plays is
    /// heard there only, so the real road never finds its stories in cooldown.
    static func inMemory() -> PlayHistory { PlayHistory(defaults: nil) }

    private func save() {
        guard let defaults, let data = try? JSONEncoder().encode(records) else { return }
        defaults.set(data, forKey: Self.key)
    }
}
