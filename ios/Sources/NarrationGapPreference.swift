import Foundation

/// Silence is a playback policy; recordings contain narration only.
enum NarrationGapPreference: Int, CaseIterable {
    case three = 3, fifteen = 15, thirty = 30, fortyFive = 45, sixty = 60
    private static let key = "narrationGapSecondsV2"
    static var current: Self {
        get { load(from: .standard) }
        set { UserDefaults.standard.set(newValue.rawValue, forKey: key) }
    }
    static func load(from defaults: UserDefaults) -> Self {
        if let selected = Self(rawValue: defaults.integer(forKey: key)) { return selected }
        // Upgrade the previous 15-second default as well as fresh installs.
        // Deliberately longer choices remain available and are preserved.
        let legacy = Self(rawValue: defaults.integer(forKey: "narrationGapSeconds"))
        return legacy == nil || legacy == .fifteen ? .three : legacy!
    }
    var seconds: TimeInterval { TimeInterval(rawValue) }
    var label: String { "\(rawValue) seconds" }
}

/// Initial idle state adds no delay. Only the end of an actual playback does.
/// Observing the published transition synchronously closes the race between
/// an audio completion and the next GPS decision.
struct NarrationGap {
    private var previousID: String?
    private(set) var endedAt: Date?

    mutating func observe(_ id: String?, at date: Date) -> Bool {
        let ended = previousID != nil && id == nil
        if ended { endedAt = date }
        previousID = id
        return ended
    }

    func remaining(at date: Date, seconds: TimeInterval) -> TimeInterval {
        guard let endedAt else { return 0 }
        return max(0, seconds - date.timeIntervalSince(endedAt))
    }
}
