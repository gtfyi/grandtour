import Foundation

/// Whether narration should prefer the server's recorded voice or always
/// speak on-device. Global and user-set: this is a bandwidth/storage
/// tradeoff, not authoring policy, so it applies to every track alike.
enum NarrationPreference: String, CaseIterable {
    /// Play recordings only. Missing/unreachable audio stays silent; dynamic
    /// locating and guided cues must not invoke the device synthesizer.
    case serverOnly
    /// Play the server's recording when we have (or can fetch) one; speak
    /// on-device only when a spot has no audio at all.
    case serverWhenAvailable
    /// Never fetch or play server audio for narration; always use the
    /// on-device voice. Saves the download and the disk space it'd take.
    case deviceVoiceOnly

    // New opt-in boundary: upgrading also disables device speech by default,
    // including devices that saved the former automatic-fallback setting.
    private static let key = "narrationPreferenceV2"

    static func load(from defaults: UserDefaults) -> NarrationPreference {
        defaults.string(forKey: key).flatMap(NarrationPreference.init(rawValue:)) ?? .serverOnly
    }

    static var current: NarrationPreference {
        get {
            load(from: .standard)
        }
        set { UserDefaults.standard.set(newValue.rawValue, forKey: key) }
    }

    var label: String {
        switch self {
        case .serverOnly: "Server audio only"
        case .serverWhenAvailable: "Server audio with on-device fallback"
        case .deviceVoiceOnly: "Always use on-device voice"
        }
    }

    var prefersServerAudio: Bool { self != .deviceVoiceOnly }
    var allowsDeviceSpeech: Bool { self != .serverOnly }

    func canNarrate(_ content: ContentPiece?) -> Bool {
        guard let content else { return false }
        if prefersServerAudio, content.audioUrl?.isEmpty == false { return true }
        return allowsDeviceSpeech && content.document?.text.isEmpty == false
    }
}
