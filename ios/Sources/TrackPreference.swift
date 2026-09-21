import Foundation

/// Optional user-set ordering of tracks, as track slugs. Among equally
/// fresh candidates (never heard, or heard the same number of days ago),
/// spots from tracks earlier in this list win; predicted distance breaks
/// ties. Freshness itself outranks this order — a never-heard story from a
/// low-ranked track beats a heard one from the favorite. Empty (the
/// default) means no preference.
enum TrackPreference {
    private static let key = "trackPreferenceOrder"

    static var current: [String] {
        get { UserDefaults.standard.stringArray(forKey: key) ?? [] }
        set { UserDefaults.standard.set(newValue, forKey: key) }
    }
}
