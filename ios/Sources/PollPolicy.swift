import Foundation

/// The watch's nearby-poll throttle. The phone polls every 1.5s while
/// touring — fine on a phone battery, ruinous on a watch. The watch instead
/// catches triggers locally on every GPS fix (TriggerEvaluator over the held
/// list) and asks the server only this often: enough to learn about spots
/// entering the 2 km window, published content, and locating sides.
struct PollPolicy {
    /// Minimum seconds between polls while the traveler is moving.
    static let movingIntervalS: TimeInterval = 10
    /// Poll interval while stationary — the heartbeat that still delivers
    /// newly published content to someone sitting on a bench.
    static let stationaryIntervalS: TimeInterval = 60

    /// One decision, pure so it can be tested: fetch now, or hold?
    static func shouldFetch(
        now: Date,
        lastFetchAt: Date,
        isMoving: Bool,
        isFetching: Bool
    ) -> Bool {
        guard !isFetching else { return false }
        let interval = isMoving ? movingIntervalS : stationaryIntervalS
        return now.timeIntervalSince(lastFetchAt) >= interval
    }
}
