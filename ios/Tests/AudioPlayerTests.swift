import AVFoundation
import XCTest

@MainActor
final class AudioPlayerTests: XCTestCase {
    private var previousNarration: NarrationPreference = .serverOnly

    override func setUp() async throws {
        previousNarration = NarrationPreference.current
        NarrationPreference.current = .serverWhenAvailable
    }

    override func tearDown() async throws {
        NarrationPreference.current = previousNarration
    }

    func testServerOnlyNeverSpeaksMissingNarrationOrDynamicCues() throws {
        NarrationPreference.current = .serverOnly
        let synth = RecordingSpeechSynthesizer()
        let player = AudioPlayer(makeSynthesizer: { synth })
        let content = ContentPiece(id: "unvoiced", locale: "en", variant: "default",
            document: FiloDocument(id: "script", text: "Unvoiced story", byteLength: 14, tiers: []),
            audioUrl: nil, durationMs: nil, source: "human", provenance: nil)
        player.play(content: content, spotId: "unvoiced", intro: "Look left")
        player.speakCue("Continue along the trail", id: "cue")
        XCTAssertTrue(synth.spoken.isEmpty)
        XCTAssertNil(player.nowPlayingSpotId)
        XCTAssertFalse(player.isPlaying)
    }

    func testServerOnlyFailedDownloadNeverFallsBackToSpeech() async {
        NarrationPreference.current = .serverOnly
        let synth = RecordingSpeechSynthesizer()
        let attempted = expectation(description: "Recording download attempted")
        let player = AudioPlayer(makeSynthesizer: { synth }, cacheRecording: { _, _ in
            attempted.fulfill()
            return nil
        })
        let content = ContentPiece(id: "missing", locale: "en", variant: "default",
            document: FiloDocument(id: "script", text: "Unreachable recording", byteLength: 21, tiers: []),
            audioUrl: "https://unavailable.invalid/\(UUID().uuidString).mp3", durationMs: 1000,
            source: "human", provenance: nil)
        player.play(content: content, spotId: "missing", intro: "Look left")
        await fulfillment(of: [attempted], timeout: 2)
        await drainCallbacks()
        XCTAssertTrue(synth.spoken.isEmpty)
        XCTAssertNil(player.nowPlayingSpotId)
        XCTAssertFalse(player.isPlaying)
    }

    func testQueuedCancellationCannotCallReplacementPlaybackHandler() async {
        let delegate = SpeechDelegate()
        let synth = AVSpeechSynthesizer()
        let old = AVSpeechUtterance(string: "Previous story")
        let next = AVSpeechUtterance(string: "Next story")
        var oldCancellations = 0
        var nextCancellations = 0
        delegate.activeUtterances = [old]
        delegate.onCancel = { oldCancellations += 1 }
        delegate.speechSynthesizer(synth, didCancel: old)

        // Replay replaces the callbacks before the delegate's main-queue hop.
        delegate.activeUtterances = [next]
        delegate.onCancel = { nextCancellations += 1 }
        await drainCallbacks()

        XCTAssertEqual(oldCancellations, 1)
        XCTAssertEqual(nextCancellations, 0, "An old cancellation must not stop the new story")
    }

    func testCancellationArrivingAfterReplacementIgnoresOldUtterance() async {
        let delegate = SpeechDelegate()
        let synth = AVSpeechSynthesizer()
        let old = AVSpeechUtterance(string: "Stopped intro")
        let next = AVSpeechUtterance(string: "New intro")
        var cancellations = 0
        delegate.activeUtterances = [next]
        delegate.onCancel = { cancellations += 1 }
        delegate.speechSynthesizer(synth, didCancel: old)
        await drainCallbacks()
        XCTAssertEqual(cancellations, 0)

        delegate.speechSynthesizer(synth, didCancel: next)
        await drainCallbacks()
        XCTAssertEqual(cancellations, 1, "A system cancellation of the active queue must still be handled")
    }

    func testQueuedFinishCannotStartReplacementNarration() async {
        let delegate = SpeechDelegate()
        let synth = AVSpeechSynthesizer()
        let old = AVSpeechUtterance(string: "Previous locator")
        let next = AVSpeechUtterance(string: "Current locator")
        var oldFinishes = 0
        var nextFinishes = 0
        delegate.activeUtterances = [old]
        delegate.watchedUtterance = old
        delegate.onFinish = { oldFinishes += 1 }
        delegate.speechSynthesizer(synth, didFinish: old)
        delegate.activeUtterances = [next]
        delegate.watchedUtterance = next
        delegate.onFinish = { nextFinishes += 1 }
        await drainCallbacks()
        XCTAssertEqual(oldFinishes, 1)
        XCTAssertEqual(nextFinishes, 0)
    }

    func testOnlyFinalCurrentUtteranceFinishesPlayback() async {
        let delegate = SpeechDelegate()
        let synth = AVSpeechSynthesizer()
        let intro = AVSpeechUtterance(string: "Look left")
        let story = AVSpeechUtterance(string: "Here is the story")
        let unrelated = AVSpeechUtterance(string: "Old story")
        var finishes = 0
        delegate.activeUtterances = [intro, story]
        delegate.watchedUtterance = story
        delegate.onFinish = { finishes += 1 }
        delegate.speechSynthesizer(synth, didFinish: intro)
        delegate.speechSynthesizer(synth, didFinish: unrelated)
        await drainCallbacks()
        XCTAssertEqual(finishes, 0)
        delegate.speechSynthesizer(synth, didFinish: story)
        await drainCallbacks()
        XCTAssertEqual(finishes, 1)
    }

    func testLateSpeechProgressDoesNotHideAStalledReplacement() async {
        let delegate = SpeechDelegate()
        let synth = AVSpeechSynthesizer()
        let old = AVSpeechUtterance(string: "Stopped story")
        let next = AVSpeechUtterance(string: "Current story")
        var progress = 0
        delegate.activeUtterances = [next]
        delegate.onProgress = { progress += 1 }
        delegate.speechSynthesizer(synth, didStart: old)
        delegate.speechSynthesizer(synth, willSpeakRangeOfSpeechString: NSRange(location: 0, length: 4), utterance: old)
        await drainCallbacks()
        XCTAssertEqual(progress, 0)
        delegate.speechSynthesizer(synth, didStart: next)
        await drainCallbacks()
        XCTAssertEqual(progress, 1)
    }

    func testMediaResetReplacesEvenAnIdleSpeechSynthesizer() {
        var synthesizers: [AVSpeechSynthesizer] = []
        let player = AudioPlayer(makeSynthesizer: {
            let synth = AVSpeechSynthesizer()
            synthesizers.append(synth)
            return synth
        })
        XCTAssertEqual(synthesizers.count, 1)
        NotificationCenter.default.post(
            name: AVAudioSession.mediaServicesWereResetNotification,
            object: AVAudioSession.sharedInstance()
        )
        XCTAssertEqual(synthesizers.count, 2)
        XCTAssertFalse(synthesizers[0] === synthesizers[1])
        XCTAssertNil(synthesizers[0].delegate)
        XCTAssertNotNil(synthesizers[1].delegate)
        XCTAssertNil(player.nowPlayingSpotId)
    }

    func testSpeechWaitsWhenInterruptionBeganBetweenStories() {
        let synth = RecordingSpeechSynthesizer()
        let player = AudioPlayer(makeSynthesizer: { synth })
        postInterruption(.began)
        defer {
            player.stop()
            postInterruption(.ended, options: .shouldResume)
        }

        player.speakCue("A story that must wait for the phone call", id: "pending-story")

        XCTAssertEqual(player.nowPlayingSpotId, "pending-story")
        XCTAssertFalse(player.isPlaying)
        XCTAssertTrue(synth.spoken.isEmpty, "Speech must not be sent to an inactive audio session")
    }

    func testDeclinedResumePreservesTheUnheardNarration() {
        let synth = RecordingSpeechSynthesizer()
        let player = AudioPlayer(makeSynthesizer: { synth })
        postInterruption(.began)
        defer {
            player.stop()
            postInterruption(.ended, options: .shouldResume)
        }
        player.speakCue("Keep this story until the user resumes", id: "parked-story")
        postInterruption(.ended)

        XCTAssertEqual(player.nowPlayingSpotId, "parked-story")
        XCTAssertFalse(player.isPlaying)
        XCTAssertTrue(synth.spoken.isEmpty)
        XCTAssertFalse(AudioSession.canPlay)
    }

    func testUserPauseSurvivesInterruptionThatAllowsResume() {
        let synth = RecordingSpeechSynthesizer()
        let player = AudioPlayer(makeSynthesizer: { synth })
        defer { player.stop() }
        postInterruption(.ended, options: .shouldResume)
        XCTAssertTrue(AudioSession.takeOver(userInitiated: true))
        player.speakCue("Narration", id: "paused-story")
        player.toggle()
        XCTAssertFalse(player.isPlaying)

        postInterruption(.began)
        postInterruption(.ended, options: .shouldResume)

        XCTAssertFalse(player.isPlaying)
        XCTAssertEqual(player.nowPlayingSpotId, "paused-story")
        XCTAssertEqual(synth.resumeCount, 0)
        player.toggle()
        XCTAssertTrue(player.isPlaying)
        XCTAssertEqual(synth.resumeCount, 1)
    }

    func testPauseDuringSiriInterruptionPreventsAutomaticResume() {
        let synth = RecordingSpeechSynthesizer()
        let player = AudioPlayer(makeSynthesizer: { synth })
        defer { player.stop() }
        postInterruption(.ended, options: .shouldResume)
        XCTAssertTrue(AudioSession.takeOver(userInitiated: true))
        player.speakCue("Narration", id: "siri-story")
        postInterruption(.began)
        XCTAssertFalse(player.isPlaying)

        player.pause()
        player.pause() // remote pause is idempotent
        postInterruption(.ended, options: .shouldResume)

        XCTAssertFalse(player.isPlaying)
        XCTAssertEqual(player.nowPlayingSpotId, "siri-story")
        XCTAssertEqual(synth.resumeCount, 0)
        player.toggle()
        XCTAssertTrue(player.isPlaying)
        XCTAssertEqual(synth.resumeCount, 1)
    }

    func testRouteReconnectCannotResumeDuringInterruption() {
        let synth = RecordingSpeechSynthesizer()
        let player = AudioPlayer(makeSynthesizer: { synth })
        defer { player.stop() }
        postInterruption(.ended, options: .shouldResume)
        XCTAssertTrue(AudioSession.takeOver(userInitiated: true))
        player.speakCue("Narration", id: "route-story")
        postRouteChange(.oldDeviceUnavailable)
        postInterruption(.began)
        postRouteChange(.newDeviceAvailable)

        XCTAssertFalse(player.isPlaying)
        XCTAssertEqual(synth.resumeCount, 0)
        postInterruption(.ended, options: .shouldResume)
        XCTAssertTrue(player.isPlaying)
        XCTAssertEqual(synth.resumeCount, 1)
    }

    func testPendingSpeechStartsWhenInterruptionAllowsResume() {
        let synth = RecordingSpeechSynthesizer()
        let player = AudioPlayer(makeSynthesizer: { synth })
        defer { player.stop() }
        postInterruption(.began)
        player.speakCue("Pending narration", id: "waiting")
        XCTAssertTrue(synth.spoken.isEmpty)

        postInterruption(.ended, options: .shouldResume)

        XCTAssertTrue(player.isPlaying)
        XCTAssertEqual(synth.spoken.map(\.speechString), ["Pending narration"])
        XCTAssertEqual(synth.spoken.first?.voice?.language, "en-US", "Device narration must use an American voice")
    }

    func testBluetoothRouteUpdatesDoNotRestartAnOngoingStory() {
        let synth = RecordingSpeechSynthesizer()
        let player = AudioPlayer(makeSynthesizer: { synth })
        defer { player.stop() }
        postInterruption(.ended, options: .shouldResume)
        player.speakCue("Keep reading this story", id: "ongoing-bluetooth-story")
        player.currentMs = 12_000

        for reason: AVAudioSession.RouteChangeReason in [
            .newDeviceAvailable, .routeConfigurationChange, .categoryChange, .override, .wakeFromSleep,
        ] {
            postRouteChange(reason)
            XCTAssertTrue(player.isPlaying)
            XCTAssertEqual(player.nowPlayingSpotId, "ongoing-bluetooth-story")
            XCTAssertEqual(player.currentMs, 12_000)
        }
        XCTAssertEqual(synth.spoken.count, 1, "Attaching a route must not enqueue another copy")
        XCTAssertEqual(synth.resumeCount, 0, "An already-playing story needs no restart")
    }

    func testBluetoothDisconnectReconnectResumesSameStoryOnlyOnce() {
        let synth = RecordingSpeechSynthesizer()
        let player = AudioPlayer(makeSynthesizer: { synth })
        defer { player.stop() }
        postInterruption(.ended, options: .shouldResume)
        player.speakCue("Reconnect this story", id: "reconnecting-story")
        player.currentMs = 12_000

        postRouteChange(.oldDeviceUnavailable)
        XCTAssertFalse(player.isPlaying)
        XCTAssertEqual(player.nowPlayingSpotId, "reconnecting-story")
        postRouteChange(.newDeviceAvailable)
        postRouteChange(.routeConfigurationChange)
        postRouteChange(.newDeviceAvailable)

        XCTAssertTrue(player.isPlaying)
        XCTAssertEqual(player.nowPlayingSpotId, "reconnecting-story")
        XCTAssertEqual(player.currentMs, 12_000)
        XCTAssertEqual(synth.spoken.count, 1)
        XCTAssertEqual(synth.resumeCount, 1)
    }

    func testBluetoothReconnectPreservesExplicitPause() {
        let synth = RecordingSpeechSynthesizer()
        let player = AudioPlayer(makeSynthesizer: { synth })
        defer { player.stop() }
        postInterruption(.ended, options: .shouldResume)
        player.speakCue("Keep this story paused", id: "paused-bluetooth-story")
        postRouteChange(.oldDeviceUnavailable)
        player.pause()

        for reason: AVAudioSession.RouteChangeReason in [
            .newDeviceAvailable, .routeConfigurationChange, .override, .wakeFromSleep,
        ] { postRouteChange(reason) }

        XCTAssertFalse(player.isPlaying)
        XCTAssertEqual(player.nowPlayingSpotId, "paused-bluetooth-story")
        XCTAssertEqual(synth.resumeCount, 0)
        player.toggle()
        XCTAssertTrue(player.isPlaying)
        XCTAssertEqual(synth.resumeCount, 1)
    }

    func testBluetoothReconnectCannotOverrideDeclinedInterruptionResume() {
        let synth = RecordingSpeechSynthesizer()
        let player = AudioPlayer(makeSynthesizer: { synth })
        defer {
            player.stop()
            postInterruption(.ended, options: .shouldResume)
        }
        postInterruption(.ended, options: .shouldResume)
        player.speakCue("Wait for explicit play", id: "interrupted-bluetooth-story")
        postRouteChange(.oldDeviceUnavailable)
        postInterruption(.began)
        postInterruption(.ended)
        postRouteChange(.newDeviceAvailable)

        XCTAssertFalse(player.isPlaying)
        XCTAssertFalse(AudioSession.canPlay)
        XCTAssertEqual(player.nowPlayingSpotId, "interrupted-bluetooth-story")
        XCTAssertEqual(synth.resumeCount, 0)
    }

    private func postRouteChange(_ reason: AVAudioSession.RouteChangeReason) {
        NotificationCenter.default.post(
            name: AVAudioSession.routeChangeNotification,
            object: AVAudioSession.sharedInstance(),
            userInfo: [AVAudioSessionRouteChangeReasonKey: reason.rawValue]
        )
    }

    private func postInterruption(
        _ type: AVAudioSession.InterruptionType,
        options: AVAudioSession.InterruptionOptions = []
    ) {
        NotificationCenter.default.post(
            name: AVAudioSession.interruptionNotification,
            object: AVAudioSession.sharedInstance(),
            userInfo: [
                AVAudioSessionInterruptionTypeKey: type.rawValue,
                AVAudioSessionInterruptionOptionKey: options.rawValue,
            ]
        )
    }

    private func drainCallbacks() async {
        await withCheckedContinuation { continuation in
            DispatchQueue.main.async { continuation.resume() }
        }
    }
}

private final class RecordingSpeechSynthesizer: AVSpeechSynthesizer {
    var spoken: [AVSpeechUtterance] = []
    var resumeCount = 0
    private var mockSpeaking = false
    private var mockPaused = false

    override var isSpeaking: Bool { mockSpeaking }
    override var isPaused: Bool { mockPaused }

    override func speak(_ utterance: AVSpeechUtterance) {
        spoken.append(utterance)
        mockSpeaking = true
        mockPaused = false
    }

    override func pauseSpeaking(at boundary: AVSpeechBoundary) -> Bool {
        mockPaused = true
        return true
    }

    override func continueSpeaking() -> Bool {
        resumeCount += 1
        mockPaused = false
        return true
    }

    override func stopSpeaking(at boundary: AVSpeechBoundary) -> Bool {
        mockSpeaking = false
        mockPaused = false
        return true
    }
}
