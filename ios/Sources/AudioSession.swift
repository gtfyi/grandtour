import AVFoundation
import Combine

/// Owns the app's audio session. GrandTour is a normal, primary audio app:
/// plain non-mixable `.playback`, claimed at launch and held full-time.
/// Activating interrupts other media. Never deliberately deactivate or notify
/// other apps to resume, including between stories or on tour pause/stop.
/// iOS can still impose a higher-priority interruption (for example a call).
///
/// This preserves the existing primary-media configuration while the actual
/// car route is diagnosed. A category/mode alone does not establish the
/// cause of a particular head unit's dropouts.
///
/// "Held" is not the same as "rendering": an active session with no client
/// running audio IO lets a Bluetooth/CarPlay link go quiet, and the head unit
/// re-opens it — clipping the first syllables — on the next play. Keeping the
/// stream warm is `AudioKeepalive`'s job; this type only configures,
/// activates, and reports what the session is doing to the field log.
@MainActor
enum AudioSession {
    private static var isConfigured = false
    private static var observers: [NSObjectProtocol] = []
    /// Audio focus belongs to the session, including the silence BETWEEN
    /// stories. Otherwise a call during a gap lets the scheduler consume
    /// unheard stories while every activation fails.
    static let playbackAvailability = CurrentValueSubject<Bool, Never>(true)
    static var canPlay: Bool { playbackAvailability.value }
    private(set) static var isInterrupted = false

    /// Claim the audio route outright. Idempotent — the category is set once,
    /// and re-activating an already-active session is a no-op, so it's safe
    /// to call before every play and after interruptions.
    ///
    /// Preserve `.default` / `.longFormAudio` from the existing build.
    /// Apple also supports `.spokenAudio` for media such as podcasts; our
    /// historic car reports did not record enough route data to attribute
    /// the cutouts to that mode. Log the actual configuration for comparison.
    @discardableResult
    static func takeOver(userInitiated: Bool = false) -> Bool {
        guard canPlay || userInitiated else { return false }
        let session = AVAudioSession.sharedInstance()
        do {
            if !isConfigured {
                // .playback already supports Bluetooth A2DP. Do not add a
                // microphone/HFP option or speaker override for CarPlay:
                // narration uses the same media route with or without its UI.
                try session.setCategory(.playback, mode: .default, policy: .longFormAudio)
                isConfigured = true
            }
            try session.setActive(true)
            isInterrupted = false
            setPlaybackAllowed(true)
            return true
        } catch {
            // Never swallowed silently: a failed activation in the car is
            // exactly the "logs say it played, ears heard nothing" case.
            print("AudioSession takeOver failed: \(error)")
            TourDiagnostics.shared.log("audio_session_error", [
                "op": isConfigured ? "activate" : "configure",
                "error": error.localizedDescription,
                "domain": (error as NSError).domain,
                "code": (error as NSError).code,
                "outputs": outputSummary(),
            ])
            setPlaybackAllowed(false)
            return false
        }
    }

    // MARK: Record mode (walk and record)

    /// Borrow the hardware for the microphone. Record mode is the one place
    /// the ears invariant yields: the tour is off (RecordModeView enforces
    /// that), and `.playAndRecord` replaces `.playback` only while a take is
    /// in progress. `.defaultToSpeaker` keeps the post-take preview audible
    /// instead of routing to the phone's earpiece.
    static func beginRecordSession() -> Bool {
        let session = AVAudioSession.sharedInstance()
        do {
            // Policy explicitly back to .default: the playback claim uses
            // .longFormAudio, and a long-form route cannot negotiate a mic —
            // left in place it hangs AVAudioRecorder inside CoreAudio.
            try session.setCategory(
                .playAndRecord, mode: .default, policy: .default, options: [.defaultToSpeaker]
            )
            try session.setActive(true)
            // The playback claim must be re-applied from scratch afterwards.
            isConfigured = false
            TourDiagnostics.shared.log("record_session_begin", ["outputs": outputSummary()])
            return true
        } catch {
            print("AudioSession beginRecordSession failed: \(error)")
            TourDiagnostics.shared.log("audio_session_error", [
                "op": "record_configure",
                "error": error.localizedDescription,
                "outputs": outputSummary(),
            ])
            return false
        }
    }

    /// Hand the ears back: re-establish the full-time `.playback` claim.
    static func endRecordSession() {
        TourDiagnostics.shared.log("record_session_end", ["outputs": outputSummary()])
        takeOver(userInitiated: true)
    }

    /// Watch the session-level events a field drive could never see before:
    /// route changes (the car connecting/disconnecting, wired ↔ wireless
    /// CarPlay, Bluetooth flapping) and media-server resets, after which the
    /// category must be re-applied and every player instance is stale.
    /// Idempotent; called once at launch.
    static func startMonitoring() {
        guard observers.isEmpty else { return }
        let session = AVAudioSession.sharedInstance()
        observers.append(NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification, object: session, queue: .main
        ) { note in
            MainActor.assumeIsolated { handleInterruption(note) }
        })
        observers.append(NotificationCenter.default.addObserver(
            forName: AVAudioSession.routeChangeNotification, object: session, queue: .main
        ) { note in
            MainActor.assumeIsolated { logRouteChange(note) }
        })
        observers.append(NotificationCenter.default.addObserver(
            forName: AVAudioSession.mediaServicesWereResetNotification, object: session, queue: .main
        ) { _ in
            MainActor.assumeIsolated {
                TourDiagnostics.shared.log("audio_media_reset", ["outputs": outputSummary()])
                isConfigured = false
                takeOver()
            }
        })
    }

    static func handleInterruption(_ note: Notification) {
        guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        switch type {
        case .began:
            isInterrupted = true
            setPlaybackAllowed(false)
        case .ended:
            isInterrupted = false
            let options = AVAudioSession.InterruptionOptions(
                rawValue: note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
            )
            setPlaybackAllowed(options.contains(.shouldResume))
        @unknown default: break
        }
    }

    private static func setPlaybackAllowed(_ allowed: Bool) {
        guard allowed != canPlay else { return }
        playbackAvailability.send(allowed)
        TourDiagnostics.shared.log("audio_focus", [
            "allowed": allowed, "interrupted": isInterrupted,
        ])
    }

    private static func logRouteChange(_ note: Notification) {
        let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
        let reason = raw.flatMap(AVAudioSession.RouteChangeReason.init(rawValue:))
        let previous = note.userInfo?[AVAudioSessionRouteChangePreviousRouteKey] as? AVAudioSessionRouteDescription
        var fields = routeSummary()
        fields["reason"] = describe(reason)
        fields["from"] = previous.map { summarize($0.outputs) } ?? []
        fields["to"] = outputSummary()
        TourDiagnostics.shared.log("audio_route_change", fields)
    }

    /// Current output ports as "type:name" strings, for diagnostics.
    static func outputSummary() -> [String] {
        summarize(AVAudioSession.sharedInstance().currentRoute.outputs)
    }

    /// The route fields logged at tour start, so a session can be told apart
    /// as "car" or "speaker" after the fact.
    static func routeSummary() -> [String: Any] {
        let session = AVAudioSession.sharedInstance()
        return [
            "outputs": outputSummary(), "external": isExternalRoute,
            "category": session.category.rawValue, "mode": session.mode.rawValue,
            "policy": session.routeSharingPolicy.rawValue,
            "options": session.categoryOptions.rawValue,
            "sampleRate": session.sampleRate, "ioBufferS": session.ioBufferDuration,
            "outputLatencyS": session.outputLatency, "canPlay": canPlay,
        ]
    }

    /// True when audio leaves the phone over a link that spins down when idle
    /// (Bluetooth, CarPlay, AirPlay, USB/HDMI). The built-in speaker and wired
    /// headphones have no such handshake and need no keepalive.
    static var isExternalRoute: Bool {
        AVAudioSession.sharedInstance().currentRoute.outputs.contains {
            externalPorts.contains($0.portType)
        }
    }

    private static let externalPorts: Set<AVAudioSession.Port> = [
        .bluetoothA2DP, .bluetoothLE, .bluetoothHFP, .carAudio, .airPlay, .usbAudio, .HDMI,
    ]

    private static func summarize(_ ports: [AVAudioSessionPortDescription]) -> [String] {
        ports.map { "\($0.portType.rawValue):\($0.portName)" }
    }

    private static func describe(_ reason: AVAudioSession.RouteChangeReason?) -> String {
        switch reason {
        case .newDeviceAvailable: "new_device"
        case .oldDeviceUnavailable: "old_device_unavailable"
        case .categoryChange: "category_change"
        case .override: "override"
        case .wakeFromSleep: "wake_from_sleep"
        case .noSuitableRouteForCategory: "no_suitable_route"
        case .routeConfigurationChange: "route_config_change"
        case .unknown, .none: "unknown"
        @unknown default: "unknown"
        }
    }
}
