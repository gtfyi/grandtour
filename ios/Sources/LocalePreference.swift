import Foundation

/// Narration language: a global default plus optional per-track overrides,
/// so a traveler can hear one track (e.g. a Welsh-language import) in a
/// different language than everything else without changing their default.
/// Global and user-set, like NarrationPreference/ServerPreference — every
/// nearby/route-nearby call reads the current selection.
///
/// The server picks the best-matching published `ContentPiece.locale` for
/// whatever we ask for and silently falls back to any published piece if
/// the exact locale doesn't exist for a spot — so offering a language here
/// never blanks a track that hasn't been translated yet.
enum LocalePreference {
    static let didChange = Notification.Name("GrandTourLocalePreferenceDidChange")

    private static let defaultKey = "grandtourDefaultLocale"
    private static let perTrackKey = "grandtourTrackLocales"

    /// Languages the app offers in its picker. Not a claim that content
    /// exists in all of these yet — just what's selectable; unavailable
    /// choices fall back to any published piece for that spot.
    static let known: [(code: String, label: String)] = [
        ("en", "English"),
        ("cy", "Cymraeg (Welsh)"),
        ("es", "Español"),
        ("fr", "Français"),
        ("de", "Deutsch"),
    ]

    static func label(for code: String) -> String {
        known.first { $0.code == code }?.label ?? code
    }

    /// The app-wide default when a track has no override.
    static var defaultLocale: String {
        get { UserDefaults.standard.string(forKey: defaultKey) ?? "en" }
        set {
            guard newValue != defaultLocale else { return }
            UserDefaults.standard.set(newValue, forKey: defaultKey)
            notify()
        }
    }

    /// Track slug → locale code, for tracks the user set independently of
    /// the default.
    private static var overrides: [String: String] {
        get { UserDefaults.standard.dictionary(forKey: perTrackKey) as? [String: String] ?? [:] }
        set { UserDefaults.standard.set(newValue, forKey: perTrackKey) }
    }

    /// The locale to request for a given track: its override if set, else
    /// the default.
    static func locale(forTrack slug: String) -> String {
        overrides[slug] ?? defaultLocale
    }

    /// Nil means "follows the default".
    static func override(forTrack slug: String) -> String? {
        overrides[slug]
    }

    static func setOverride(_ locale: String?, forTrack slug: String) {
        var o = overrides
        if let locale, locale != defaultLocale {
            o[slug] = locale
        } else {
            o.removeValue(forKey: slug)
        }
        guard o != overrides else { return }
        overrides = o
        notify()
    }

    /// Serialized `slug:locale` pairs for tracks whose locale differs from
    /// `locale`, in the wire format `GrandTourAPI.nearby(trackLocales:)`
    /// expects (`NearbyQuery.trackLocales` on the server).
    static func trackLocalesParam(activeTracks: [String], defaultLocale locale: String) -> [String: String] {
        let o = overrides
        var out: [String: String] = [:]
        for slug in activeTracks {
            if let l = o[slug], l != locale { out[slug] = l }
        }
        return out
    }

    private static func notify() {
        NotificationCenter.default.post(name: didChange, object: nil)
    }
}
