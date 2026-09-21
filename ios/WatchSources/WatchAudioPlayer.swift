import AVFoundation
import Combine

/// Plays narration on the watch. A slimmed port of the phone's AudioPlayer
/// with the same contracts the tour engine depends on:
///   - narration is NEVER streamed — recorded audio plays from a local file
///     (downloaded first if needed) or the on-device voice speaks instead;
///   - `nowPlayingSpotId` going nil is the decision signal;
///   - a watchdog force-stops a wedged playback so the tour can't deadlock.
/// Differences: session take-over is async (watchOS long-form activation),
/// and there's no transcript sync UI, though `currentMs` is still published.
@MainActor
final class WatchAudioPlayer: ObservableObject {
    @Published var isPlaying = false
    @Published var currentMs: Double = 0
    @Published var nowPlayingSpotId: String?
    /// The play-time locator sentence, for the now-playing screen.
    @Published var introText: String?
    /// Set when long-form activation failed at play time (headphones gone).
    /// The UI turns this into "connect headphones"; cleared on the next
    /// successful activation.
    @Published var routeUnavailable = false

    /// Fires once per playback, a few seconds before recorded narration ends,
    /// so the engine can refresh position and pre-warm the next story.
    /// Best-effort: on-device speech never fires it.
    var onApproachingEnd: (() -> Void)?
    private var approachingEndFired = false

    private var player: AVQueuePlayer?
    private let synth = AVSpeechSynthesizer()
    private let synthDelegate = WatchSpeechDelegate()
    private var speechGeneration = 0
    private var playGeneration = 0
    private var timeObserver: Any?
    /// The narration item; progress tracking ignores the locating clip.
    private var narrationItem: AVPlayerItem?
    private var endObserver: NSObjectProtocol?
    private var interruptionObserver: NSObjectProtocol?
    private var wasInterrupted = false
    /// True while the narration itself (not the locator) is being spoken
    /// on-device.
    private var speakingNarration = false
    /// Set by toggle(): the traveler chose this pause; the watchdog must not
    /// "rescue" it.
    private var userPaused = false
    private var watchdogTask: Task<Void, Never>?
    private var lastWatchdogTime: Double = -1
    private var stalledTicks = 0
    private var interruptedTicks = 0

    init() {
        interruptionObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: AVAudioSession.sharedInstance(),
            queue: .main
        ) { [weak self] note in
            MainActor.assumeIsolated { self?.handleInterruption(note) }
        }
    }

    deinit {
        if let o = interruptionObserver { NotificationCenter.default.removeObserver(o) }
    }

    func play(
        content: ContentPiece,
        spotId: String,
        locating: LocatingResolved? = nil,
        intro: String? = nil
    ) {
        let api = GrandTourAPI()
        playGeneration += 1
        let gen = playGeneration
        // Reserve the player right away so the decision loop doesn't start
        // something else while activation/download are in flight.
        nowPlayingSpotId = spotId

        Task { [weak self] in
            guard let self else { return }
            let ok = await WatchAudioSession.takeOver()
            guard self.playGeneration == gen else { return }
            guard ok else {
                // No headphone route: nothing can play. Release the
                // reservation and tell the UI why.
                self.routeUnavailable = true
                self.stop()
                return
            }
            self.routeUnavailable = false

            let wantsRecorded = NarrationPreference.current.prefersServerAudio
            guard wantsRecorded, let remote = content.audioUrl else {
                self.playSpoken(content: content, spotId: spotId, intro: intro)
                return
            }
            if let local = WatchAudioCache.shared.localAudioURL(for: remote) {
                self.playRecorded(local, spotId: spotId, locating: locating, intro: intro)
                return
            }
            // Not cached yet: fetch the file first, never stream it. Either
            // the download lands in a couple of seconds or the on-device
            // voice speaks instead.
            let local = await WatchAudioCache.shared.ensureCached(remote, api: api)
            guard self.playGeneration == gen else { return }
            if let local {
                self.playRecorded(local, spotId: spotId, locating: locating, intro: intro)
            } else {
                self.playSpoken(content: content, spotId: spotId, intro: intro)
            }
        }
    }

    private func playSpoken(content: ContentPiece, spotId: String, intro: String?) {
        guard NarrationPreference.current.allowsDeviceSpeech else { stop(); return }
        if let text = content.document?.text, !text.isEmpty {
            playOnDevice(segments: SpokenSegment.segments(from: text), spotId: spotId, intro: intro)
        } else {
            stop() // nothing playable: release the reservation
        }
    }

    private func playRecorded(
        _ url: URL,
        spotId: String,
        locating: LocatingResolved?,
        intro: String?
    ) {
        teardown(keepSpotId: true)
        approachingEndFired = false

        // Queue: optional locating clip ("Look to your left."), then
        // narration. The clip plays only from cache — same as the phone.
        var items: [AVPlayerItem] = []
        if let locStr = locating?.audioUrl,
           let locUrl = WatchAudioCache.shared.localAudioURL(for: locStr) {
            items.append(AVPlayerItem(url: locUrl))
        }
        let narration = AVPlayerItem(url: url)
        items.append(narration)
        narrationItem = narration

        let p = AVQueuePlayer(items: items)
        player = p
        nowPlayingSpotId = spotId

        timeObserver = p.addPeriodicTimeObserver(
            forInterval: CMTime(seconds: 0.05, preferredTimescale: 600),
            queue: .main
        ) { [weak self] time in
            guard let self else { return }
            let onNarration = self.player?.currentItem === self.narrationItem
            self.currentMs = onNarration ? time.seconds * 1000 : 0
            if onNarration, !self.approachingEndFired,
               let dur = self.narrationItem?.duration.seconds, dur.isFinite,
               dur - time.seconds <= 8 {
                self.approachingEndFired = true
                self.onApproachingEnd?()
            }
        }

        endObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime,
            object: narration,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.stop() }
        }

        startWatchdog(spotId: spotId)
        isPlaying = true
        if let intro, NarrationPreference.current.allowsDeviceSpeech {
            introText = intro
            speechGeneration += 1
            let gen = speechGeneration
            synth.delegate = synthDelegate
            synthDelegate.watchedUtterance = nil // only one utterance queued here
            synthDelegate.onFinish = { [weak self] in
                guard let self, self.speechGeneration == gen else { return }
                self.player?.play()
            }
            synth.speak(Self.utterance(intro))
        } else {
            p.play()
        }
    }

    /// No recorded clip: speak the narration as a queue of utterances, one
    /// per segment, with each segment's pause rendered as real silence.
    private func playOnDevice(segments: [SpokenSegment], spotId: String, intro: String?) {
        teardown(keepSpotId: true)

        nowPlayingSpotId = spotId
        isPlaying = true
        speakingNarration = true

        speechGeneration += 1
        let gen = speechGeneration
        let utterances = segments.map { Self.utterance($0.text, pauseAfter: $0.pauseAfter) }
        synth.delegate = synthDelegate
        synthDelegate.watchedUtterance = utterances.last
        synthDelegate.onFinish = { [weak self] in
            guard let self, self.speechGeneration == gen else { return }
            self.stop()
        }
        startWatchdog(spotId: spotId)

        if let intro {
            introText = intro
            synth.speak(Self.utterance(intro, pauseAfter: 0.4))
        }
        for u in utterances { synth.speak(u) }
    }

    /// Best installed American English voice for narration, resolved once.
    private static let narrationVoice: AVSpeechSynthesisVoice? = {
        let en = AVSpeechSynthesisVoice.speechVoices()
            .filter { $0.language == "en-US" }
        func rank(_ v: AVSpeechSynthesisVoice) -> Int {
            var score = 0
            switch v.quality {
            case .premium: score += 20
            case .enhanced: score += 10
            default: break
            }
            return score
        }
        let best = en.max { rank($0) < rank($1) }
        return best ?? AVSpeechSynthesisVoice(language: "en-US")
    }()

    private static func utterance(_ text: String, pauseAfter: TimeInterval = 0) -> AVSpeechUtterance {
        let u = AVSpeechUtterance(string: text)
        u.voice = narrationVoice
        u.postUtteranceDelay = pauseAfter
        return u
    }

    // ─── Watchdog ────────────────────────────────────────────────────────────

    private func startWatchdog(spotId: String) {
        watchdogTask?.cancel()
        lastWatchdogTime = -1
        stalledTicks = 0
        interruptedTicks = 0
        watchdogTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(10))
                guard !Task.isCancelled, let self else { return }
                self.watchdogTick(spotId: spotId)
            }
        }
    }

    private func watchdogTick(spotId: String) {
        guard nowPlayingSpotId == spotId else {
            watchdogTask?.cancel()
            return
        }
        if userPaused {
            stalledTicks = 0
            interruptedTicks = 0
            return
        }
        if wasInterrupted {
            interruptedTicks += 1
            stalledTicks = 0
            if interruptedTicks >= 12 { stop() }
            return
        }
        interruptedTicks = 0
        let playerTime = player?.currentTime().seconds
        let progressing = synth.isSpeaking
            || (playerTime != nil && playerTime != lastWatchdogTime)
        lastWatchdogTime = playerTime ?? -1
        stalledTicks = progressing ? 0 : stalledTicks + 1
        if stalledTicks >= 3 { stop() }
    }

    func toggle() {
        if speakingNarration {
            if isPlaying {
                synth.pauseSpeaking(at: .word)
                isPlaying = false
                userPaused = true
            } else if synth.isPaused {
                synth.continueSpeaking()
                isPlaying = true
                userPaused = false
            }
            return
        }
        guard let p = player else { return }
        if synth.isSpeaking {
            // Mid-intro: cancel the spoken locator, treat as a pause.
            speechGeneration += 1
            synth.stopSpeaking(at: .immediate)
            isPlaying = false
            userPaused = true
            return
        }
        if isPlaying {
            p.pause()
            isPlaying = false
            userPaused = true
        } else {
            p.play()
            isPlaying = true
            userPaused = false
        }
    }

    func stop() {
        playGeneration += 1
        teardown(keepSpotId: false)
    }

    private func teardown(keepSpotId: Bool) {
        watchdogTask?.cancel()
        watchdogTask = nil
        userPaused = false
        speechGeneration += 1
        if synth.isSpeaking || synth.isPaused { synth.stopSpeaking(at: .immediate) }
        synthDelegate.watchedUtterance = nil
        introText = nil
        if let obs = timeObserver { player?.removeTimeObserver(obs); timeObserver = nil }
        if let o = endObserver { NotificationCenter.default.removeObserver(o); endObserver = nil }
        player?.pause()
        player = nil
        narrationItem = nil
        isPlaying = false
        speakingNarration = false
        wasInterrupted = false
        currentMs = 0
        if !keepSpotId { nowPlayingSpotId = nil }
    }

    private func handleInterruption(_ note: Notification) {
        guard
            let info = note.userInfo,
            let raw = info[AVAudioSessionInterruptionTypeKey] as? UInt,
            let type = AVAudioSession.InterruptionType(rawValue: raw)
        else { return }

        switch type {
        case .began:
            guard player != nil || speakingNarration else { return }
            wasInterrupted = true
            isPlaying = false
        case .ended:
            guard wasInterrupted else { return }
            guard player != nil || speakingNarration else { return }
            wasInterrupted = false
            let opts = (info[AVAudioSessionInterruptionOptionKey] as? UInt)
                .map(AVAudioSession.InterruptionOptions.init(rawValue:)) ?? []
            if opts.contains(.shouldResume) {
                if speakingNarration {
                    if synth.isPaused { synth.continueSpeaking() }
                } else {
                    player?.play()
                }
                isPlaying = true
            } else {
                stop()
            }
        @unknown default:
            break
        }
    }
}

/// NSObject shim: forwards speech completion to a closure on the main actor.
/// `watchedUtterance` names the utterance whose completion actually ends
/// playback — everything queued ahead of it must not trigger stop().
private final class WatchSpeechDelegate: NSObject, AVSpeechSynthesizerDelegate {
    var onFinish: (() -> Void)?
    weak var watchedUtterance: AVSpeechUtterance?

    func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer,
        didFinish utterance: AVSpeechUtterance
    ) {
        guard watchedUtterance == nil || watchedUtterance === utterance else { return }
        DispatchQueue.main.async { [weak self] in self?.onFinish?() }
    }
}
