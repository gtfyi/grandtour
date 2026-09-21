import AVFoundation
import MediaPlayer
import XCTest

@MainActor
final class NowPlayingControllerTests: XCTestCase {
    func testRemoteStopStopsAutomaticTourAsWellAsCurrentStory() {
        withController { model, _, controller in
            model.startTour(at: nil)
            model.player.nowPlayingSpotId = "current-story"
            model.player.isPlaying = true
            XCTAssertEqual(controller.handle("stop"), .success)
            XCTAssertFalse(model.isTouring, "Stop must not let the scheduler start the next story")
            XCTAssertNil(model.player.nowPlayingSpotId)
        }
    }

    func testRemoteStopAlsoStopsManualPlaybackWithTourOff() {
        withController { model, _, controller in
            model.player.nowPlayingSpotId = "manual-story"
            model.player.isPlaying = true
            XCTAssertEqual(controller.handle("stop"), .success)
            XCTAssertNil(model.player.nowPlayingSpotId)
            XCTAssertFalse(model.player.isPlaying)
        }
    }

    func testRemotePausePreservesLoadedNarration() {
        withController { model, _, controller in
            model.startTour(at: nil)
            model.player.nowPlayingSpotId = "paused-story"
            model.player.isPlaying = true
            XCTAssertEqual(controller.handle("pause"), .success)
            XCTAssertTrue(model.isTouring)
            XCTAssertEqual(model.player.nowPlayingSpotId, "paused-story")
            XCTAssertFalse(model.player.isPlaying)
        }
    }

    func testStopKeepsGrandTourMetadataAndDisablesSkip() async {
        await withPublishingController { model, controller in
            controller.start()
            controller.start() // Reconnect/bootstrap is idempotent.
            model.player.nowPlayingSpotId = "story"
            model.player.isPlaying = true
            await self.drainCallbacks()
            XCTAssertNotNil(MPNowPlayingInfoCenter.default().nowPlayingInfo)
            XCTAssertTrue(MPRemoteCommandCenter.shared().nextTrackCommand.isEnabled)
            XCTAssertEqual(controller.handle("stop"), .success)
            await self.drainCallbacks()
            let info = MPNowPlayingInfoCenter.default().nowPlayingInfo
            XCTAssertEqual(info?[MPMediaItemPropertyTitle] as? String, "GrandTour")
            XCTAssertEqual(info?[MPNowPlayingInfoPropertyPlaybackRate] as? Double, 0)
            XCTAssertTrue(MPRemoteCommandCenter.shared().playCommand.isEnabled)
            XCTAssertFalse(MPRemoteCommandCenter.shared().nextTrackCommand.isEnabled)
            XCTAssertFalse(MPRemoteCommandCenter.shared().previousTrackCommand.isEnabled)
        }
    }

    func testIdleStartupKeepsGrandTourAsNowPlayingApp() async {
        await withPublishingController { model, controller in
            controller.start()
            await self.drainCallbacks()
            let info = MPNowPlayingInfoCenter.default().nowPlayingInfo
            XCTAssertFalse(model.isTouring)
            XCTAssertNil(model.player.nowPlayingSpotId)
            XCTAssertEqual(info?[MPMediaItemPropertyTitle] as? String, "GrandTour")
            XCTAssertEqual(info?[MPNowPlayingInfoPropertyPlaybackRate] as? Double, 0)
            XCTAssertTrue(MPRemoteCommandCenter.shared().playCommand.isEnabled)
        }
    }

    func testReplayBecomesUnavailableWhenStoryLeavesCatalog() async {
        await withPublishingController { model, controller in
            let spot = TestFixtures.nearbySpot(id: "replay", title: "Story", center: TestFixtures.base,
                radiusM: 35, distanceM: 0, triggered: true)
            let narration = NarrationPreference.current
            NarrationPreference.current = .serverWhenAvailable
            defer { NarrationPreference.current = narration }
            model.nearby = [spot]
            controller.start()
            model.player.nowPlayingSpotId = spot.spot.id
            await self.drainCallbacks()
            XCTAssertTrue(controller.canReplayLast)
            model.nearby = []
            await self.drainCallbacks()
            XCTAssertFalse(controller.canReplayLast)
            XCTAssertEqual(controller.replayLast(), .noSuchContent)
            XCTAssertFalse(MPRemoteCommandCenter.shared().previousTrackCommand.isEnabled)
        }
    }

    func testAttachingNowPlayingControlsPreservesNarrationAndAudioConfiguration() async {
        await withPublishingController { model, controller in
            model.player.nowPlayingSpotId = "bluetooth-story"
            model.player.isPlaying = true
            model.player.currentMs = 12_000
            let session = AVAudioSession.sharedInstance()
            let category = session.category
            let mode = session.mode
            let policy = session.routeSharingPolicy
            let options = session.categoryOptions

            controller.start()
            controller.start()
            await self.drainCallbacks()

            XCTAssertEqual(model.player.nowPlayingSpotId, "bluetooth-story")
            XCTAssertTrue(model.player.isPlaying)
            XCTAssertEqual(model.player.currentMs, 12_000)
            XCTAssertEqual(session.category, category)
            XCTAssertEqual(session.mode, mode)
            XCTAssertEqual(session.routeSharingPolicy, policy)
            XCTAssertEqual(session.categoryOptions, options)
        }
    }

    private func withController(_ body: (TourViewModel, LocationManager, NowPlayingController) -> Void) {
        let suite = "NowPlayingTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        let model = TourViewModel(history: PlayHistory(defaults: defaults), selectionDefaults: defaults)
        let location = LocationManager()
        let controller = NowPlayingController(tour: model, location: location)
        defer {
            model.stopTour()
            model.player.stop()
            defaults.removePersistentDomain(forName: suite)
        }
        body(model, location, controller)
    }

    private func withPublishingController(_ body: (TourViewModel, NowPlayingController) async -> Void) async {
        let suite = "NowPlayingTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        let model = TourViewModel(history: PlayHistory(defaults: defaults), selectionDefaults: defaults)
        let controller = NowPlayingController(tour: model, location: LocationManager())
        await body(model, controller)
        model.player.stop()
        await drainCallbacks()
        defaults.removePersistentDomain(forName: suite)
    }

    private func drainCallbacks() async {
        // @Published changes are deliberately delivered on the main run loop.
        try? await Task.sleep(for: .milliseconds(50))
    }
}
