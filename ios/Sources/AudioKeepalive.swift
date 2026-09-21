import AVFoundation
import Combine

    /// Keeps the audio output stream warm while a tour runs on an external route
/// (Bluetooth, CarPlay, AirPlay, USB).
///
/// Narration is bursty: a minute of story, then minutes of nothing. This
/// mitigation was introduced for suspected head-unit unmuting delays at
/// clip boundaries. It has not been verified on the affected car, and it
/// does not explain the reported once-per-second gaps DURING a recording.
/// A player's advancing clock cannot prove that a head unit rendered it.
///
/// This renders near-silence continuously to keep audio IO running. It loops a 2-second
/// 16-bit file of ±1 LSB dither — −96 dBFS, inaudible at any car volume, but
/// not digital zero. The setting allows a real-car A/B comparison of this
/// live stream alongside the buffered AVQueuePlayer narration. It
/// runs only while the tour is ON and the route is external, so a pocketed
/// phone on its own speaker pays no battery for it.
///
/// This does not change the session contract in CLAUDE.md ("GrandTour owns
/// the ears"): same `.playback`/`.default`/`.longFormAudio`, never
/// deactivated — it just makes "held" mean "rendering".
@MainActor
final class AudioKeepalive {
    static let shared = AudioKeepalive()
    // This is deliberately versioned: build 2026.9.8 enabled the experimental
    // second-player path by default, and that can contend with AVQueuePlayer
    // on some CarPlay/Bluetooth routes. Do not carry that unsafe preference
    // into the rollback build.
    private static let enabledKey = "carAudioKeepaliveEnabledV2"
    /// Keep the experimental mitigation opt-in until it is proven on the
    /// affected head unit. The normal playback session does not need it.
    static var isEnabled: Bool {
        (UserDefaults.standard.object(forKey: enabledKey) as? Bool) ?? false
    }

    private var wanted = false
    private var running = false
    private var player: AVAudioPlayer?
    private var observers: [NSObjectProtocol] = []
    private var focusObserver: AnyCancellable?

    private init() {
        AudioSession.startMonitoring()
        let session = AVAudioSession.sharedInstance()
        focusObserver = AudioSession.playbackAvailability
            .removeDuplicates()
            .dropFirst()
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.apply(reason: "audio_focus") }
        // The route decides whether we're needed at all; re-evaluate on every
        // change (car connects, Bluetooth flaps, back to the speaker).
        observers.append(NotificationCenter.default.addObserver(
            forName: AVAudioSession.routeChangeNotification, object: session, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.apply(reason: "route_change") }
        })
        // An interruption pauses every client, this one included; `.ended`
        // is the cue to warm the link back up before narration resumes.
        observers.append(NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification, object: session, queue: .main
        ) { [weak self] note in
            guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  AVAudioSession.InterruptionType(rawValue: raw) == .ended else { return }
            MainActor.assumeIsolated { self?.apply(reason: "interruption_ended") }
        })
        // After a media-server reset every AVAudioPlayer is dead; rebuild.
        observers.append(NotificationCenter.default.addObserver(
            forName: AVAudioSession.mediaServicesWereResetNotification, object: session, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.player = nil
                self?.running = false
                self?.apply(reason: "media_reset")
            }
        })
    }

    /// Tour ON/OFF. The keepalive follows the tour, not individual plays —
    /// the silence between plays is exactly what it exists to cover.
    func setWanted(_ on: Bool) {
        wanted = on
        apply(reason: on ? "tour_on" : "tour_off")
    }

    func setEnabled(_ enabled: Bool) {
        UserDefaults.standard.set(enabled, forKey: Self.enabledKey)
        TourDiagnostics.shared.log("keepalive_setting", [
            "enabled": enabled, "outputs": AudioSession.outputSummary(),
        ])
        apply(reason: "setting_changed")
    }

    /// `GRANDTOUR_FORCE_KEEPALIVE=1` (simulator launch env) runs it on the
    /// built-in route too, so the mechanism can be exercised without a car.
    private var forced: Bool {
        ProcessInfo.processInfo.environment["GRANDTOUR_FORCE_KEEPALIVE"] == "1"
    }

    private var shouldRun: Bool {
        wanted && Self.isEnabled && AudioSession.canPlay && (forced || AudioSession.isExternalRoute)
    }

    private func apply(reason: String) {
        if shouldRun { start(reason: reason) } else { stop(reason: reason) }
    }

    private func start(reason: String) {
        if player == nil { player = Self.makePlayer() }
        guard let player else { return }
        // Already warm, and not silently parked by an interruption.
        if running, player.isPlaying { return }
        guard AudioSession.takeOver() else { return }
        running = player.play()
        TourDiagnostics.shared.log("keepalive_start", [
            "reason": reason,
            "ok": running,
            "outputs": AudioSession.outputSummary(),
        ])
    }

    private func stop(reason: String) {
        guard running || player?.isPlaying == true else { return }
        player?.stop()
        running = false
        TourDiagnostics.shared.log("keepalive_stop", [
            "reason": reason,
            "outputs": AudioSession.outputSummary(),
        ])
    }

    private static func makePlayer() -> AVAudioPlayer? {
        guard let url = silentFileURL() else { return nil }
        do {
            let p = try AVAudioPlayer(contentsOf: url)
            p.numberOfLoops = -1
            // The file itself is the silence; a zero volume would let the
            // mixer treat the client as idle, which defeats the purpose.
            p.volume = 1
            p.prepareToPlay()
            return p
        } catch {
            print("AudioKeepalive: could not open silence: \(error)")
            return nil
        }
    }

    /// Two seconds of 16-bit mono 44.1 kHz ±1 LSB dither, generated once into
    /// Caches (no bundled asset; the project is XcodeGen-generated from
    /// sources only). A versioned name so a future change of format doesn't
    /// pick up a stale file.
    private static func silentFileURL() -> URL? {
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        let url = dir.appendingPathComponent("keepalive-dither-v1.wav")
        if FileManager.default.fileExists(atPath: url.path) { return url }

        let sampleRate: UInt32 = 44_100
        let frames = Int(sampleRate) * 2
        var data = Data(capacity: 44 + frames * 2)
        func put16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) } }
        func put32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) } }
        data.append(contentsOf: Array("RIFF".utf8))
        put32(UInt32(36 + frames * 2))
        data.append(contentsOf: Array("WAVE".utf8))
        data.append(contentsOf: Array("fmt ".utf8))
        put32(16)              // PCM fmt chunk size
        put16(1)               // PCM
        put16(1)               // mono
        put32(sampleRate)
        put32(sampleRate * 2)  // byte rate
        put16(2)               // block align
        put16(16)              // bits per sample
        data.append(contentsOf: Array("data".utf8))
        put32(UInt32(frames * 2))
        var seed: UInt32 = 0x9E37_79B9
        for _ in 0..<frames {
            seed = seed &* 1_664_525 &+ 1_013_904_223
            let r = (seed >> 30) & 3
            let d: Int16 = r == 3 ? 0 : Int16(r) - 1
            put16(UInt16(bitPattern: d))
        }
        do {
            try data.write(to: url, options: .atomic)
            return url
        } catch {
            print("AudioKeepalive: could not write silence: \(error)")
            return nil
        }
    }
}
