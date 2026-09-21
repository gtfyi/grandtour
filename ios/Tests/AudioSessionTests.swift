import AVFoundation
import Combine
import CoreLocation
import XCTest

/// Interruptions can begin between stories, when AudioPlayer has no item to
/// pause. Exercise the process-wide gate through the real tour decision path
/// so a phone call cannot silently consume unheard stories in that gap.
@MainActor
final class AudioSessionTests: XCTestCase {
    nonisolated override class func setUp() {
        super.setUp()
        URLProtocol.registerClass(AudioSessionOfflineProtocol.self)
    }

    func testInterruptionBetweenStoriesBlocksBothTourStylesWithoutRecordingHistory() {
        for style in [TourStyle.wander, .guided(trackSlug: "test-track")] {
            withIdleTour(style: style) { model, history, spot in
                interrupt(.began)

                XCTAssertTrue(AudioSession.isInterrupted)
                XCTAssertFalse(AudioSession.canPlay)
                for _ in 0..<3 { model.decideNext() }

                XCTAssertNil(model.player.nowPlayingSpotId)
                XCTAssertEqual(history.playCount(spot.spot.id), 0,
                               "Polling during a call must not count an inaudible story as heard")
                XCTAssertNil(model.upNext, "An unavailable session must not select a new story")
            }
        }
    }

    func testEndWithoutResumePermissionKeepsIdleTourBlocked() {
        for style in [TourStyle.wander, .guided(trackSlug: "test-track")] {
            withIdleTour(style: style) { model, history, spot in
                interrupt(.began)
                interrupt(.ended)

                XCTAssertFalse(AudioSession.isInterrupted)
                XCTAssertFalse(AudioSession.canPlay)
                XCTAssertFalse(AudioSession.takeOver(),
                               "A scheduler or keepalive retry cannot override a no-resume interruption")
                model.decideNext()

                XCTAssertNil(model.player.nowPlayingSpotId)
                XCTAssertEqual(history.playCount(spot.spot.id), 0)
            }
        }
    }

    func testEndWithResumePermissionReleasesTheSameUnheardStory() {
        for style in [TourStyle.wander, .guided(trackSlug: "test-track")] {
            withIdleTour(style: style) { model, history, spot in
                var availability: [Bool] = []
                let observation = AudioSession.playbackAvailability
                    .removeDuplicates()
                    .sink { availability.append($0) }
                defer { observation.cancel() }

                interrupt(.began)
                model.decideNext()
                XCTAssertEqual(history.playCount(spot.spot.id), 0)

                interrupt(.ended, options: .shouldResume)
                XCTAssertFalse(AudioSession.isInterrupted)
                XCTAssertTrue(AudioSession.canPlay)
                model.decideNext()

                XCTAssertEqual(model.player.nowPlayingSpotId, spot.spot.id)
                XCTAssertEqual(history.playCount(spot.spot.id), 1)
                XCTAssertEqual(availability, [true, false, true])
            }
        }
    }

    func testMissingEndNotificationCannotBeOverriddenByAutomaticRetries() {
        withIdleTour(style: .wander) { model, history, spot in
            interrupt(.began)
            for _ in 0..<3 {
                XCTAssertFalse(AudioSession.takeOver(),
                               "Only an explicit user action may retry a missing-ended session")
                model.decideNext()
            }

            XCTAssertTrue(AudioSession.isInterrupted)
            XCTAssertFalse(AudioSession.canPlay)
            XCTAssertNil(model.player.nowPlayingSpotId)
            XCTAssertEqual(history.playCount(spot.spot.id), 0)
        }
    }

    func testNarrationUsesBluetoothMediaConfigurationAcrossRepeatedActivations() {
        let originalInterrupted = AudioSession.isInterrupted
        let originalCanPlay = AudioSession.canPlay
        defer {
            interrupt(.ended, options: .shouldResume)
            if originalInterrupted { interrupt(.began) }
            else if !originalCanPlay { interrupt(.ended) }
        }
        interrupt(.ended, options: .shouldResume)
        let session = AVAudioSession.sharedInstance()
        XCTAssertTrue(AudioSession.takeOver())
        let initialPolicy = session.routeSharingPolicy
        // Catalyst reports .default even after accepting .longFormAudio.
        // Its audio backend cannot verify the effective iPhone route policy.
        // Native host runs still check stability; iOS runs check the value.
        #if !targetEnvironment(macCatalyst)
        XCTAssertEqual(initialPolicy, .longFormAudio)
        #endif
        for _ in 0..<3 {
            XCTAssertTrue(AudioSession.takeOver())
            XCTAssertEqual(session.category, .playback)
            XCTAssertEqual(session.mode, .default)
            XCTAssertEqual(session.routeSharingPolicy, initialPolicy)
            XCTAssertEqual(session.categoryOptions, [],
                           "Narration must not switch to HFP, force the speaker, duck, or mix")
        }
    }

    private func interrupt(
        _ type: AVAudioSession.InterruptionType,
        options: AVAudioSession.InterruptionOptions = []
    ) {
        AudioSession.handleInterruption(Notification(
            name: AVAudioSession.interruptionNotification,
            object: AVAudioSession.sharedInstance(),
            userInfo: [
                AVAudioSessionInterruptionTypeKey: type.rawValue,
                AVAudioSessionInterruptionOptionKey: options.rawValue,
            ]
        ))
    }

    private func withIdleTour(
        style: TourStyle,
        _ body: (TourViewModel, PlayHistory, NearbySpot) -> Void
    ) {
        let originalInterrupted = AudioSession.isInterrupted
        let originalCanPlay = AudioSession.canPlay
        let originalStyle = TourStyle.current
        let originalNarration = NarrationPreference.current
        let originalDiagnostics = TourDiagnostics.shared.enabled
        interrupt(.ended, options: .shouldResume)
        NarrationPreference.current = .serverWhenAvailable

        let suite = "AudioSessionTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        let history = PlayHistory(defaults: defaults)
        let model = TourViewModel(history: history, selectionDefaults: defaults)
        model.tourStyle = style
        model.startTour(at: nil)
        TourDiagnostics.shared.enabled = false
        let spot = recordedSpot()
        model.allTracks = [spot.track]
        model.enabledTrackSlugs = [spot.track.slug]
        model.nearby = [spot]
        defer {
            // These tests never yield the main actor: a successful decision
            // only reserves the recorded item. Cancel it before its download
            // can complete or any speech fallback can begin.
            model.stopTour()
            model.returnToHere(nil)
            TourStyle.current = originalStyle
            NarrationPreference.current = originalNarration
            interrupt(.ended, options: .shouldResume)
            if originalInterrupted {
                interrupt(.began)
            } else if !originalCanPlay {
                interrupt(.began)
                interrupt(.ended)
            }
            TourDiagnostics.shared.enabled = originalDiagnostics
            defaults.removePersistentDomain(forName: suite)
        }
        body(model, history, spot)
    }

    private func recordedSpot() -> NearbySpot {
        let id = "interruption-\(UUID().uuidString)"
        let source = TestFixtures.nearbySpot(
            id: id, title: "Unheard story", center: TestFixtures.base,
            radiusM: 35, distanceM: 0, triggered: true
        )
        let content = source.content!
        return NearbySpot(
            spot: source.spot, track: source.track, locating: nil,
            distanceM: source.distanceM, triggered: true,
            content: ContentPiece(
                id: content.id, locale: content.locale, variant: content.variant,
                document: content.document,
                audioUrl: "/test-audio/\(id).mp3", durationMs: 30_000,
                source: content.source, provenance: content.provenance
            ), guide: nil
        )
    }
}

private final class AudioSessionOfflineProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
    }
    override func stopLoading() {}
}
