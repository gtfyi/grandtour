import AVFoundation
import Combine

/// Plays a piece of narration and publishes playback position for text sync.
///
/// GrandTour is the primary audio app: `AudioSession.takeOver()` claims the
/// route outright and the app holds it full-time — the session is never
/// deactivated between spots or on pause/stop. (`AudioKeepalive`, owned by
/// the tour, keeps the car/Bluetooth stream rendering between plays.)
@MainActor
final class AudioPlayer: ObservableObject {
    @Published var isPlaying = false
    @Published var currentMs: Double = 0
    @Published var nowPlayingSpotId: String?

    /// The play-time locator sentence, for the NowPlaying card. Set while an
    /// intro is spoken and kept for the rest of the narration.
    @Published var introText: String?

    /// Fires once per playback, a few seconds before recorded narration ends,
    /// so the tour can refresh its position and pre-warm the likely next story
    /// while this one is still talking. Best-effort: on-device speech has no
    /// reliable duration, so there it never fires and the tour simply decides
    /// at the end — the callback is an optimization, never a dependency.
    var onApproachingEnd: (() -> Void)?
    private var approachingEndFired = false
    /// `GRANDTOUR_SILENT=1` (simulator launch env) mutes every output, so a
    /// tour can be driven headlessly on a shared machine; the tour logic and
    /// the audio session behave exactly as with sound.
    static let silent = ProcessInfo.processInfo.environment["GRANDTOUR_SILENT"] == "1"

    private var player: AVQueuePlayer?
    /// Speaks the dynamic locator ("Back 500 feet on your left…") before the
    /// narration, and stands in for the narration itself when there's no
    /// recorded clip (no audio published, or the traveler prefers the
    /// on-device voice): free, offline, and can say a distance computed one
    /// second ago — which no pre-rendered clip can.
    private var synth: AVSpeechSynthesizer
    private let makeSynthesizer: () -> AVSpeechSynthesizer
    private let cacheRecording: (String, GrandTourAPI) async -> URL?
    private let synthDelegate = SpeechDelegate()
    /// Invalidates a pending speech-completion callback after stop()/replay.
    private var speechGeneration = 0
    /// Invalidates an in-flight play-time audio download when a newer play()
    /// or stop() supersedes it.
    private var playGeneration = 0
    private var timeObserver: Any?
    /// The narration item; transcript sync ignores the locating clip before it.
    private var narrationItem: AVPlayerItem?
    private var endObserver: NSObjectProtocol?
    private var playbackObservers: [NSObjectProtocol] = []
    private var playbackStatusObserver: NSKeyValueObservation?
    private var sessionObservers: [NSObjectProtocol] = []
    /// Set when the system interrupted us (a call); governs whether we resume.
    private var wasInterrupted = false
    /// Set when the output we were playing on disappeared (car Bluetooth or
    /// CarPlay link dropped, headphones pulled). Playback is parked, not
    /// stopped: it resumes when a route comes back or the traveler taps play,
    /// and the watchdog gives it the same two-minute budget as an
    /// interruption before reclaiming the tour.
    private var routeLost = false
    /// True while the *narration itself* (not the locator) is being spoken
    /// on-device, so toggle()/stop()/interruption handling know which engine
    /// to drive.
    private var speakingNarration = false
    /// A denied audio-session activation must not send speech to an inactive
    /// route. Keep the utterances until an allowed resume starts them.
    private var pendingUtterances: [AVSpeechUtterance] = []
    /// Set by toggle(): the traveler chose this pause, so the watchdog must
    /// not "rescue" it.
    private var userPaused = false
    /// Playback watchdog. iOS does not guarantee an interruption `.ended`
    /// after a `.began`, and a missed end-of-item notification is possible —
    /// either leaves `nowPlayingSpotId` set forever, which deadlocks the whole
    /// tour (every queued spot and fill-in waits on an idle check). The
    /// watchdog forces `stop()` when playback has clearly died: no progress
    /// while nominally playing, or an interruption that never ends.
    private var watchdogTask: Task<Void, Never>?
    private var lastWatchdogTime: Double = -1
    /// When the synthesizer last reported real progress (an utterance
    /// starting or a range being spoken). The watchdog reads this rather
    /// than `synth.isSpeaking`, which stays true for a synthesizer that is
    /// paused or wedged with utterances queued — field drives produced
    /// on-device narrations that hung for minutes with no watchdog fire.
    private var lastSpeechProgressAt: Date = .distantPast
    private var lastWatchdogSpeechAt: Date = .distantPast
    private var stalledTicks = 0
    private var interruptedTicks = 0

    init(
        makeSynthesizer: @escaping () -> AVSpeechSynthesizer = { AVSpeechSynthesizer() },
        cacheRecording: @escaping (String, GrandTourAPI) async -> URL? = {
            await TourCache.shared.ensureCached($0, api: $1)
        }
    ) {
        self.makeSynthesizer = makeSynthesizer
        self.cacheRecording = cacheRecording
        synth = makeSynthesizer()
        synth.delegate = synthDelegate
        synthDelegate.onProgress = { [weak self] in self?.lastSpeechProgressAt = Date() }
        AudioSession.startMonitoring()
        let session = AVAudioSession.sharedInstance()
        sessionObservers.append(NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification, object: session, queue: .main
        ) { [weak self] note in
            MainActor.assumeIsolated { self?.handleInterruption(note) }
        })
        sessionObservers.append(NotificationCenter.default.addObserver(
            forName: AVAudioSession.routeChangeNotification, object: session, queue: .main
        ) { [weak self] note in
            MainActor.assumeIsolated { self?.handleRouteChange(note) }
        })
        // A media-server reset kills every AVPlayer and synthesizer instance:
        // whatever was playing is gone. Stop cleanly so the tour decides again
        // (AudioSession re-applies the category on the same signal).
        sessionObservers.append(NotificationCenter.default.addObserver(
            forName: AVAudioSession.mediaServicesWereResetNotification, object: session, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.stop(reason: "media_reset")
                // Reusing a synthesizer after a media-services reset can leave
                // every subsequent narration queued but permanently silent.
                self.synth.delegate = nil
                self.synth = self.makeSynthesizer()
                self.synth.delegate = self.synthDelegate
            }
        })
    }

    deinit {
        for o in sessionObservers { NotificationCenter.default.removeObserver(o) }
    }

    /// Resolve an audio reference to something playable: the cached local
    /// file when we have it (works offline, no buffering), else the server.
    private func playableURL(_ urlString: String, api: GrandTourAPI) -> URL? {
        if let local = TourCache.shared.localAudioURL(for: urlString) { return local }
        return api.resolveAudioURL(urlString)
    }

    func play(
        content: ContentPiece,
        spotId: String,
        locating: LocatingResolved? = nil,
        intro: String? = nil,
        deviceSegments: [SpokenSegment]? = nil
    ) {
        let api = GrandTourAPI()
        playGeneration += 1
        let gen = playGeneration

        let wantsRecorded = NarrationPreference.current.prefersServerAudio
        guard wantsRecorded, let remote = content.audioUrl else {
            playSpoken(content: content, spotId: spotId, intro: intro, deviceSegments: deviceSegments)
            return
        }

        if let local = TourCache.shared.localAudioURL(for: remote) {
            playRecorded(local, content: content, spotId: spotId, locating: locating, intro: intro, api: api)
            return
        }

        // Not cached yet: fetch the file first, never stream it. A flaky
        // cellular link makes streamed narration stutter and start silent;
        // a one-shot download either lands in a couple of seconds or we
        // speak the text on-device instead. Reserve the player meanwhile so
        // the idle-decide loop doesn't start something else mid-download.
        nowPlayingSpotId = spotId
        TourDiagnostics.shared.log("audio_fetch_at_play", ["spotId": spotId])
        Task { [weak self] in
            guard let self else { return }
            let local = await self.cacheRecording(remote, api)
            guard self.playGeneration == gen else { return }
            if let local {
                self.playRecorded(local, content: content, spotId: spotId, locating: locating, intro: intro, api: api)
            } else {
                self.playSpoken(content: content, spotId: spotId, intro: intro, deviceSegments: deviceSegments)
            }
        }
    }

    /// One short on-device line — a guided-tour direction cue ("Next stop:
    /// the old mill. About 200 meters to the northeast."). Occupies the
    /// player exactly like narration so nothing talks over it, and clears
    /// the way for the next decision when it finishes.
    func speakCue(_ text: String, id: String) {
        guard NarrationPreference.current.allowsDeviceSpeech else { return }
        playGeneration += 1
        playOnDevice(segments: [SpokenSegment(text: text, pauseAfter: 0.3)], spotId: id, intro: nil)
    }

    /// The on-device voice path, from structured segments when the caller has
    /// them (vocab beats) or from the document text.
    private func playSpoken(
        content: ContentPiece,
        spotId: String,
        intro: String?,
        deviceSegments: [SpokenSegment]?
    ) {
        guard NarrationPreference.current.allowsDeviceSpeech else {
            stop(reason: "server_audio_unavailable")
            return
        }
        if let segments = deviceSegments, !segments.isEmpty {
            playOnDevice(segments: segments, spotId: spotId, intro: intro)
        } else if let text = content.document?.text, !text.isEmpty {
            playOnDevice(segments: SpokenSegment.segments(from: text), spotId: spotId, intro: intro)
        } else {
            stop(reason: "nothing_playable") // release the reservation
        }
    }

    private func playRecorded(
        _ url: URL,
        content: ContentPiece,
        spotId: String,
        locating: LocatingResolved?,
        intro: String?,
        api: GrandTourAPI
    ) {
        TourDiagnostics.shared.log("play_source", [
            "spotId": spotId,
            "engine": "recorded",
            "local": url.isFileURL,
            "outputs": AudioSession.outputSummary(),
        ])

        let pausedWhilePreparing = userPaused && nowPlayingSpotId == spotId && player == nil && !speakingNarration
        teardown()
        let canPlay = !pausedWhilePreparing && AudioSession.takeOver()
        userPaused = pausedWhilePreparing
        approachingEndFired = false

        // Queue: optional locating clip ("Look to your left."), then narration.
        // The clip plays only from cache — a tiny nicety is not worth a
        // cellular stream stalling the whole queue; prefetch usually has it.
        var items: [AVPlayerItem] = []
        if let locStr = locating?.audioUrl, let locUrl = TourCache.shared.localAudioURL(for: locStr) {
            items.append(AVPlayerItem(url: locUrl))
        }
        let narration = AVPlayerItem(url: url)
        items.append(narration)
        narrationItem = narration

        let p = AVQueuePlayer(items: items)
        if Self.silent { p.volume = 0 }
        player = p
        nowPlayingSpotId = spotId

        timeObserver = p.addPeriodicTimeObserver(
            forInterval: CMTime(seconds: 0.05, preferredTimescale: 600),
            queue: .main
        ) { [weak self, weak p] time in
            guard let self, let p, self.player === p else { return }
            // Byte-range highlights are aligned to the narration file only.
            let onNarration = self.player?.currentItem === self.narrationItem
            self.currentMs = onNarration ? time.seconds * 1000 : 0
            if onNarration, !self.approachingEndFired,
               let dur = self.narrationItem?.duration.seconds, dur.isFinite,
               dur - time.seconds <= 8 {
                self.approachingEndFired = true
                self.onApproachingEnd?()
            }
        }

        // The narration is the last item in the queue, so its end is the end
        // of what we have to say — that's the cue to give the ears back.
        endObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime,
            object: narration,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.narrationItem === narration else { return }
                TourDiagnostics.shared.log("play_finish", [
                    "spotId": spotId, "engine": "recorded",
                ])
                self.stop(reason: "finished")
            }
        }

        for event in [Notification.Name.AVPlayerItemPlaybackStalled, .AVPlayerItemFailedToPlayToEndTime] {
            playbackObservers.append(NotificationCenter.default.addObserver(
                forName: event, object: narration, queue: .main
            ) { [weak self] note in
                MainActor.assumeIsolated {
                    guard let self, self.narrationItem === narration else { return }
                    var fields: [String: Any] = [
                        "spotId": spotId,
                        "event": event == .AVPlayerItemPlaybackStalled ? "stalled" : "failed",
                        "timeMs": self.currentMs,
                        "local": url.isFileURL,
                        "outputs": AudioSession.outputSummary(),
                    ]
                    if let error = note.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? NSError {
                        fields["error"] = error.localizedDescription
                        fields["errorDomain"] = error.domain
                        fields["errorCode"] = error.code
                    }
                    TourDiagnostics.shared.log("audio_playback_event", fields)
                }
            })
        }
        playbackStatusObserver = p.observe(\.timeControlStatus, options: [.new]) { [weak self] observed, change in
            let status = change.newValue ?? observed.timeControlStatus
            let waitingReason = observed.reasonForWaitingToPlay?.rawValue ?? ""
            Task { @MainActor [weak self, weak observed] in
                guard let self, let observed, self.player === observed else { return }
                let label: String
                switch status {
                case .paused: label = "paused"
                case .waitingToPlayAtSpecifiedRate: label = "waiting"
                case .playing: label = "playing"
                @unknown default: label = "unknown"
                }
                TourDiagnostics.shared.log("audio_playback_state", [
                    "spotId": spotId,
                    "state": label,
                    "waitingReason": waitingReason,
                    "timeMs": self.currentMs,
                ])
            }
        }

        startWatchdog(spotId: spotId)
        isPlaying = canPlay
        wasInterrupted = !canPlay
        if let intro, canPlay, NarrationPreference.current.allowsDeviceSpeech {
            introText = intro
            speechGeneration += 1
            let gen = speechGeneration
            synth.delegate = synthDelegate
            let utterance = Self.utterance(intro)
            synthDelegate.activeUtterances = [utterance]
            synthDelegate.watchedUtterance = utterance
            let startNarration: () -> Void = { [weak self] in
                guard let self, self.speechGeneration == gen, self.isPlaying,
                      !self.userPaused, !self.wasInterrupted, !self.routeLost else { return }
                self.player?.play()
            }
            synthDelegate.onFinish = startNarration
            // An intro the system cancelled (route change, media reset) must
            // not strand the narration behind it; our own cancellations are
            // filtered by the generation counter.
            synthDelegate.onCancel = startNarration
            synth.speak(utterance)
        } else {
            synthDelegate.onCancel = nil
            if canPlay { p.play() }
        }
    }

    /// No recorded clip (none published, or the traveler prefers on-device
    /// voice): speak the narration as a queue of utterances, one per segment,
    /// with each segment's pause rendered as real silence. Pacing lives in
    /// the segments; a monolithic utterance is what made on-device speech
    /// sound breathless. No `currentMs`/transcript highlight — that byte↔ms
    /// alignment only exists for the server's recorded audio.
    private func playOnDevice(
        segments: [SpokenSegment],
        spotId: String,
        intro: String?
    ) {
        TourDiagnostics.shared.log("play_source", [
            "spotId": spotId,
            "engine": "device_tts",
            "segments": segments.count,
            "outputs": AudioSession.outputSummary(),
        ])

        let pausedWhilePreparing = userPaused && nowPlayingSpotId == spotId && player == nil && !speakingNarration
        teardown()
        let canPlay = !pausedWhilePreparing && AudioSession.takeOver()
        userPaused = pausedWhilePreparing

        nowPlayingSpotId = spotId
        isPlaying = canPlay
        wasInterrupted = !canPlay
        speakingNarration = true

        speechGeneration += 1
        let gen = speechGeneration
        let narration = segments.map { Self.utterance($0.text, pauseAfter: $0.pauseAfter) }
        let utterances = intro.map { [Self.utterance($0, pauseAfter: 0.4)] + narration } ?? narration
        synth.delegate = synthDelegate
        synthDelegate.activeUtterances = utterances
        // Only the final utterance's completion ends playback — everything
        // queued ahead of it finishes first and must not trigger stop().
        synthDelegate.watchedUtterance = utterances.last
        synthDelegate.onFinish = { [weak self] in
            guard let self, self.speechGeneration == gen else { return }
            TourDiagnostics.shared.log("play_finish", [
                "spotId": spotId, "engine": "device_tts",
            ])
            self.stop(reason: "finished")
        }
        // A cancel we didn't ask for (the system tore the queue down) ends
        // the narration: waiting for a last utterance that will never speak
        // is how the tour used to deadlock.
        synthDelegate.onCancel = { [weak self] in
            guard let self, self.speechGeneration == gen else { return }
            self.stop(reason: "speech_cancelled")
        }
        startWatchdog(spotId: spotId)

        introText = intro
        if canPlay {
            for u in utterances { synth.speak(u) }
        } else {
            pendingUtterances = utterances
        }
    }

    /// Best installed American English voice for narration. A downloaded
    /// premium voice from another region must not override the accent.
    /// Resolved once — voice enumeration is not free.
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
        if silent { u.volume = 0 }
        return u
    }

    // ─── Watchdog ────────────────────────────────────────────────────────────

    /// One tick every 10s while something is nominally loaded. Progress means
    /// either engine is audibly moving: the synthesizer reported a spoken
    /// range since the last tick, or the player's clock advanced.
    private func startWatchdog(spotId: String) {
        watchdogTask?.cancel()
        lastWatchdogTime = -1
        // Grace for voice loading: the first tick counts as progress.
        lastSpeechProgressAt = Date()
        lastWatchdogSpeechAt = .distantPast
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
        // A pause the traveler asked for is not a stall.
        if userPaused {
            stalledTicks = 0
            interruptedTicks = 0
            return
        }
        // A call or declined auto-resume can outlast the watchdog budget.
        // Preserve the loaded narration until audio is allowed or the user
        // explicitly resumes, instead of skipping story after story silently.
        if !AudioSession.canPlay {
            stalledTicks = 0
            interruptedTicks = 0
            return
        }
        if wasInterrupted || routeLost {
            // `.ended` is not guaranteed to arrive, and a lost route may never
            // come back. Give a real phone call two minutes, then reclaim the
            // tour; losing one auto-resume beats a silent tour for the rest
            // of the day.
            interruptedTicks += 1
            stalledTicks = 0
            if interruptedTicks >= 12 {
                fireWatchdog(
                    spotId: spotId,
                    reason: wasInterrupted ? "interruption_never_ended" : "route_never_returned"
                )
            }
            return
        }
        interruptedTicks = 0
        let playerTime = player?.currentTime().seconds
        let speechProgressed = lastSpeechProgressAt > lastWatchdogSpeechAt
        lastWatchdogSpeechAt = lastSpeechProgressAt
        let progressing = speechProgressed
            || (playerTime != nil && playerTime != lastWatchdogTime)
        lastWatchdogTime = playerTime ?? -1
        stalledTicks = progressing ? 0 : stalledTicks + 1
        // Three silent ticks = 30s with nothing moving while claiming to play.
        // (The longest scripted pause, a 10s quiz think-gap, spans one tick.)
        if stalledTicks >= 3 { fireWatchdog(spotId: spotId, reason: "stalled") }
    }

    private func fireWatchdog(spotId: String, reason: String) {
        TourDiagnostics.shared.log("play_watchdog", [
            "spotId": spotId,
            "reason": reason,
            "engine": speakingNarration ? "device_tts" : "recorded",
            "outputs": AudioSession.outputSummary(),
        ])
        stop(reason: "watchdog") // clears nowPlayingSpotId, which lets the queue move again
    }

    func toggle() {
        guard nowPlayingSpotId != nil else { return }
        if isPlaying { pause() } else { resume(reason: "user") }
    }

    /// Idempotent pause also records user intent while Siri already has the
    /// session interrupted. Looking only at isPlaying loses that intent and
    /// resumes unexpectedly when Siri's interruption ends.
    func pause() {
        guard nowPlayingSpotId != nil, !userPaused else { return }
        let midIntro = !speakingNarration && synth.isSpeaking
        if speakingNarration {
            if synth.isSpeaking, !synth.isPaused { synth.pauseSpeaking(at: .word) }
        } else if midIntro {
            // A recorded narration resumes directly after a user-cancelled
            // locator; its old completion must not start playback on its own.
            speechGeneration += 1
            synthDelegate.activeUtterances = []
            synth.stopSpeaking(at: .immediate)
        }
        player?.pause()
        isPlaying = false
        userPaused = true
        TourDiagnostics.shared.log("play_pause", [
            "spotId": nowPlayingSpotId ?? "",
            "reason": midIntro ? "user_mid_intro" : "user",
        ])
    }

    /// Bring a paused or parked narration back on whatever route is live now.
    /// A paused synthesizer is resumed whichever engine owns the narration:
    /// on the recorded path it is the locator intro, and its completion
    /// callback is what starts the player.
    private func resume(reason: String) {
        guard AudioSession.takeOver(userInitiated: reason == "user") else {
            wasInterrupted = true
            isPlaying = false
            return
        }
        if !pendingUtterances.isEmpty {
            let utterances = pendingUtterances
            pendingUtterances = []
            for utterance in utterances { synth.speak(utterance) }
        } else if synth.isPaused {
            synth.continueSpeaking()
        } else if !speakingNarration {
            player?.play()
        }
        isPlaying = true
        userPaused = false
        routeLost = false
        wasInterrupted = false
        lastSpeechProgressAt = Date()
        TourDiagnostics.shared.log("play_resume", [
            "spotId": nowPlayingSpotId ?? "",
            "reason": reason,
            "outputs": AudioSession.outputSummary(),
        ])
    }

    /// Stop at the traveler's request (or the tour's, when it turns off).
    func stop() {
        stop(reason: "user")
    }

    /// `reason` goes to the field log: 20 of 431 logged plays ended without a
    /// `play_finish`, and nothing said whether that was a tap, a watchdog, an
    /// interruption we were told not to resume from, or a media reset.
    func stop(reason: String) {
        // A stopped player must stay stopped: outdate any play-time download
        // still in flight so it can't start narration after the fact.
        playGeneration += 1
        if let id = nowPlayingSpotId, reason != "finished" {
            TourDiagnostics.shared.log("play_stop", [
                "spotId": id,
                "reason": reason,
                "engine": speakingNarration ? "device_tts" : "recorded",
            ])
        }
        teardown()
    }

    private func teardown() {
        watchdogTask?.cancel()
        watchdogTask = nil
        userPaused = false
        speechGeneration += 1
        // Clear identities and handlers before requesting cancellation: both
        // synchronous and delayed events can belong to the outgoing queue.
        synthDelegate.activeUtterances = []
        synthDelegate.watchedUtterance = nil
        synthDelegate.onFinish = nil
        synthDelegate.onCancel = nil
        pendingUtterances = []
        if synth.isSpeaking || synth.isPaused { synth.stopSpeaking(at: .immediate) }
        introText = nil
        if let obs = timeObserver { player?.removeTimeObserver(obs); timeObserver = nil }
        if let o = endObserver { NotificationCenter.default.removeObserver(o); endObserver = nil }
        for observer in playbackObservers { NotificationCenter.default.removeObserver(observer) }
        playbackObservers = []
        playbackStatusObserver = nil
        player?.pause()
        player = nil
        narrationItem = nil
        isPlaying = false
        speakingNarration = false
        wasInterrupted = false
        routeLost = false
        currentMs = 0
        nowPlayingSpotId = nil
    }

    /// A phone call (or another app taking the route outright) pauses us. On
    /// `.began` the system has already stopped our audio; on `.ended` we
    /// resume only if it says we should, and only if a spot is still loaded.
    /// Every interruption is logged: in the car they come from Siri, nav
    /// prompts and head-unit source switches, and the field log used to be
    /// blind to all of them.
    private func handleInterruption(_ note: Notification) {
        // NotificationCenter does not promise observer ordering. Apply the
        // shared gate before attempting to resume this loaded narration.
        AudioSession.handleInterruption(note)
        guard
            let info = note.userInfo,
            let raw = info[AVAudioSessionInterruptionTypeKey] as? UInt,
            let type = AVAudioSession.InterruptionType(rawValue: raw)
        else { return }
        let loaded = player != nil || speakingNarration

        switch type {
        case .began:
            var fields: [String: Any] = [
                "type": "began",
                "loaded": loaded,
                "spotId": nowPlayingSpotId ?? "",
                "outputs": AudioSession.outputSummary(),
            ]
            if let r = info[AVAudioSessionInterruptionReasonKey] as? UInt {
                fields["reason"] = Self.describe(reason: AVAudioSession.InterruptionReason(rawValue: r))
            }
            TourDiagnostics.shared.log("audio_interruption", fields)
            guard loaded else { return }
            // The system has already silenced us; pausing the synthesizer
            // ourselves (narration or locator intro alike) is what makes
            // `continueSpeaking()` possible later.
            if synth.isSpeaking, !synth.isPaused {
                synth.pauseSpeaking(at: .immediate)
            }
            wasInterrupted = true
            isPlaying = false
        case .ended:
            let opts = (info[AVAudioSessionInterruptionOptionKey] as? UInt)
                .map(AVAudioSession.InterruptionOptions.init(rawValue:)) ?? []
            TourDiagnostics.shared.log("audio_interruption", [
                "type": "ended",
                "shouldResume": opts.contains(.shouldResume),
                "loaded": loaded,
                "wasInterrupted": wasInterrupted,
                "spotId": nowPlayingSpotId ?? "",
            ])
            guard wasInterrupted, loaded else { return }
            wasInterrupted = false
            guard !userPaused else { return }
            if opts.contains(.shouldResume) {
                resume(reason: "interruption_ended")
            } else {
                // Preserve the current narration for an explicit play action.
                // Clearing it here makes the tour skip unheard material.
                TourDiagnostics.shared.log("play_parked", [
                    "spotId": nowPlayingSpotId ?? "",
                    "reason": "interruption_no_resume",
                ])
            }
        @unknown default:
            break
        }
    }

    /// The output route changed under us. Losing the device we were playing
    /// on (the car's link dropping, headphones pulled) parks the narration;
    /// the next usable route — or a tap on play — resumes it. Other route
    /// changes while playing are left alone: AVPlayer follows the route on
    /// its own, and `AudioSession.startMonitoring` already logs them.
    private func handleRouteChange(_ note: Notification) {
        guard let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
              let reason = AVAudioSession.RouteChangeReason(rawValue: raw),
              player != nil || speakingNarration
        else { return }
        switch reason {
        case .oldDeviceUnavailable:
            guard isPlaying, !userPaused else { return }
            // Park both engines: the synthesizer may be mid-intro ahead of
            // a recorded narration that hasn't started yet.
            if synth.isSpeaking, !synth.isPaused { synth.pauseSpeaking(at: .immediate) }
            if !speakingNarration { player?.pause() }
            routeLost = true
            isPlaying = false
            TourDiagnostics.shared.log("play_parked", [
                "spotId": nowPlayingSpotId ?? "",
                "reason": "route_lost",
                "outputs": AudioSession.outputSummary(),
            ])
        case .newDeviceAvailable, .override, .routeConfigurationChange, .wakeFromSleep:
            guard routeLost, !wasInterrupted, !userPaused else { return }
            resume(reason: "route_restored")
        default:
            break
        }
    }

    private static func describe(reason: AVAudioSession.InterruptionReason?) -> String {
        guard let reason else { return "unknown" }
        switch reason {
        case .default: return "default"
        case .builtInMicMuted: return "mic_muted"
        case .routeDisconnected: return "route_disconnected"
        default: return "other_\(reason.rawValue)"
        }
    }
}

/// NSObject shim: forwards speech events to closures on the main actor.
///
/// `AVSpeechSynthesizer` reports one `didFinish` per utterance, not per
/// queue — when an intro is queued ahead of the narration, `onFinish` must
/// fire only once the *narration* utterance (not the intro) completes, so
/// `watchedUtterance` names which one the caller actually cares about.
/// `onCancel` fires for ANY cancelled utterance: a cancel the app didn't ask
/// for means the whole queue is gone. `onProgress` is the watchdog's
/// heartbeat — utterance starts and spoken ranges, not `isSpeaking`.
final class SpeechDelegate: NSObject, AVSpeechSynthesizerDelegate {
    var onFinish: (() -> Void)?
    var onCancel: (() -> Void)?
    var onProgress: (() -> Void)?
    weak var watchedUtterance: AVSpeechUtterance?
    /// Strong references prevent identity reuse until the queue is replaced.
    var activeUtterances: [AVSpeechUtterance] = []

    private func owns(_ utterance: AVSpeechUtterance) -> Bool {
        activeUtterances.contains { $0 === utterance }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        progress(utterance)
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didContinue utterance: AVSpeechUtterance) {
        progress(utterance)
    }

    func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer,
        willSpeakRangeOfSpeechString characterRange: NSRange,
        utterance: AVSpeechUtterance
    ) {
        progress(utterance)
    }

    func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer,
        didFinish utterance: AVSpeechUtterance
    ) {
        guard owns(utterance), watchedUtterance === utterance else { return }
        // Capture this generation's handler now; reading the mutable handler
        // in the dispatched block can run the next playback's completion.
        let callback = onFinish
        DispatchQueue.main.async { callback?() }
    }

    func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer,
        didCancel utterance: AVSpeechUtterance
    ) {
        guard owns(utterance) else { return }
        let callback = onCancel
        DispatchQueue.main.async { callback?() }
    }

    private func progress(_ utterance: AVSpeechUtterance) {
        guard owns(utterance) else { return }
        let callback = onProgress
        DispatchQueue.main.async { callback?() }
    }
}
