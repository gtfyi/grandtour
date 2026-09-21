import Foundation

/// How the tour chooses what to play.
///
/// - `wander`: every enabled track; the scheduler predicts the traveler's
///   path and narrates the least-heard spot ahead as they reach it. The
///   "walk around and see what plays" experience.
/// - `guided(trackSlug)`: one track as a walking tour — the app names the
///   next stop, gives directions, and narrates on arrival. No fill-ins.
enum TourStyle: Hashable {
    case wander
    case guided(trackSlug: String)

    var guidedTrackSlug: String? {
        if case .guided(let slug) = self { return slug }
        return nil
    }

    var isGuided: Bool { guidedTrackSlug != nil }

    // ─── Persistence ─────────────────────────────────────────────────────────

    private static let key = "tourStyle"

    static var current: TourStyle {
        get {
            guard let raw = UserDefaults.standard.string(forKey: key) else { return .wander }
            if raw.hasPrefix("guided:") { return .guided(trackSlug: String(raw.dropFirst("guided:".count))) }
            return .wander
        }
        set {
            switch newValue {
            case .wander: UserDefaults.standard.removeObject(forKey: key)
            case .guided(let slug): UserDefaults.standard.set("guided:\(slug)", forKey: key)
            }
        }
    }
}
