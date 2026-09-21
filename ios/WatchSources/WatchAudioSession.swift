import AVFoundation

/// The watch's adaptation of the phone's "GrandTour owns the ears" rule.
///
/// Same spirit: category is configured once, the session is never deactivated
/// between spots or on pause/stop. Different mechanics: watchOS long-form
/// audio (`.longFormAudio` — the only policy that reaches Bluetooth
/// headphones for media playback; the watch speaker is not a valid route)
/// must be activated with the async `activate(options:)`, which presents the
/// system route picker when no headphones are paired and reports failure when
/// the user dismisses it. So take-over is async and fallible here, and the
/// tour engine awaits it at tour start — while the traveler is still looking
/// at the screen — rather than at first spot trigger with the wrist down.
@MainActor
enum WatchAudioSession {
    private static var isConfigured = false

    /// Configure once, then (re-)activate. Returns false when no headphone
    /// route was established; callers surface "connect headphones" instead
    /// of failing silently. Re-activation of an active session succeeds
    /// immediately, so calling this before every play is cheap.
    static func takeOver() async -> Bool {
        let session = AVAudioSession.sharedInstance()
        if !isConfigured {
            do {
                try session.setCategory(.playback, mode: .default, policy: .longFormAudio)
                isConfigured = true
            } catch {
                print("WatchAudioSession: setCategory failed: \(error)")
                return false
            }
        }
        return await withCheckedContinuation { cont in
            session.activate(options: []) { success, error in
                if let error {
                    print("WatchAudioSession: activate failed: \(error)")
                }
                cont.resume(returning: success)
            }
        }
    }
}
