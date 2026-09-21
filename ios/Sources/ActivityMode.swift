import Foundation

/// The traveler's activity mode as the user set it: `auto` (infer from GPS
/// speed) or one of the explicit server modes. Persisted, because the mode
/// filters `/nearby` server-side — a track authored driving-only returns
/// NOTHING to a walker — and an unpersisted "walking" default silently
/// emptied a whole afternoon's drive.
enum ActivityModePreference {
    static let auto = "auto"
    /// Every mode the server accepts, in picker order.
    static let explicit = ["walking", "driving", "cycling", "hiking", "museum", "transit", "boating", "aviation"]

    private static let key = "activityModePreference"

    static func load(from defaults: UserDefaults = .standard) -> String {
        guard let v = defaults.string(forKey: key), v == auto || explicit.contains(v) else { return auto }
        return v
    }

    static func save(_ value: String, to defaults: UserDefaults = .standard) {
        defaults.set(value, forKey: key)
    }
}

/// Infers walking vs driving from recent GPS speeds. Pure and deterministic
/// so the journey simulators can drive it.
///
/// Hysteresis by design: a median over the last window must be clearly fast
/// (≥ 7 m/s ≈ 16 mph, sustained) to become `driving`, or clearly slow
/// (≤ 2.5 m/s, a brisk walk) to become `walking`; anything in between keeps
/// the current answer. Cycling sits in that band and is never inferred —
/// pick it explicitly. Traffic stops don't flip a driver back to walking:
/// a red light is shorter than the window, and the median resists it.
struct ActivityModeDetector {
    private(set) var current: String
    private var samples: [(at: Date, speed: Double)] = []

    let window: TimeInterval
    let minSamples: Int
    let drivingMps: Double
    let walkingMps: Double

    init(initial: String = "walking", window: TimeInterval = 20, minSamples: Int = 5,
         drivingMps: Double = 7, walkingMps: Double = 2.5) {
        current = initial
        self.window = window
        self.minSamples = minSamples
        self.drivingMps = drivingMps
        self.walkingMps = walkingMps
    }

    /// Feed one fix. Negative speeds (CoreLocation's "unknown") are ignored.
    /// Returns the new mode when the inference changes, else nil.
    mutating func observe(speedMps: Double, at: Date) -> String? {
        guard speedMps >= 0 else { return nil }
        samples.append((at, speedMps))
        samples.removeAll { at.timeIntervalSince($0.at) > window }
        guard samples.count >= minSamples,
              let first = samples.first, at.timeIntervalSince(first.at) >= window / 2
        else { return nil }
        let sorted = samples.map(\.speed).sorted()
        let median = sorted[sorted.count / 2]
        let next: String
        if median >= drivingMps { next = "driving" }
        else if median <= walkingMps { next = "walking" }
        else { return nil }
        guard next != current else { return nil }
        current = next
        return next
    }
}
