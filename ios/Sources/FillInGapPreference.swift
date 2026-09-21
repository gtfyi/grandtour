import Foundation

/// How long narration must be silent before a fill-in item is inserted.
/// User-set: filling every 30-second lull suits a highway drive or study
/// session; a longer setting suits a walk where the world should mostly
/// speak for itself.
enum FillInGapPreference: String, CaseIterable {
    case off
    case thirtySeconds
    case oneMinute
    case twoMinutes
    case fiveMinutes

    private static let key = "fillInGapPreference"

    static var current: FillInGapPreference {
        get {
            UserDefaults.standard.string(forKey: key).flatMap(FillInGapPreference.init(rawValue:))
                ?? .thirtySeconds
        }
        set { UserDefaults.standard.set(newValue.rawValue, forKey: key) }
    }

    /// Nil = fill-ins disabled.
    var seconds: TimeInterval? {
        switch self {
        case .off: nil
        case .thirtySeconds: 30
        case .oneMinute: 60
        case .twoMinutes: 120
        case .fiveMinutes: 300
        }
    }

    var label: String {
        switch self {
        case .off: "Off"
        case .thirtySeconds: "After 30 seconds"
        case .oneMinute: "After 1 minute"
        case .twoMinutes: "After 2 minutes"
        case .fiveMinutes: "After 5 minutes"
        }
    }
}
