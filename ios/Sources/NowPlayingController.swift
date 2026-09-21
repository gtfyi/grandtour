import Combine
import Foundation
import MediaPlayer
import MapKit

/// Makes GrandTour the system's Now Playing app. The lock screen, Control
/// Center, CarPlay's Now Playing screen and Bluetooth head units all read
/// `MPNowPlayingInfoCenter`, and steering-wheel / head-unit buttons arrive as
/// `MPRemoteCommandCenter` commands. Until this existed the car showed
/// whatever app last published info, and its play/pause buttons went there —
/// which could start Music over our non-mixable session. None of this needs
/// a CarPlay entitlement; it works in any car today.
///
/// Command semantics — a tour is not a playlist:
///   play              paused narration → resume; idle with the tour off → start the tour
///   pause             narration → pause; idle with the tour on → stop the tour
///   togglePlayPause   narration → toggle; otherwise start/stop the tour
///   stop              stop the tour and any manual narration
///   nextTrack         skip: stop the current narration so the tour moves on
///   previousTrack     replay the last spot from the top
///
/// Info is published on STATE CHANGES only, never from the 20 Hz time
/// observer: high-rate metadata updates glitch some head units. Elapsed time
/// is set on each change and the playback rate carries the clock.
@MainActor
final class NowPlayingController {
    private let tour: TourViewModel
    private let location: LocationManager
    private var cancellables: Set<AnyCancellable> = []
    /// Metadata captured when a play starts. Resolved once, because the spot
    /// can leave the 2 km `nearby` list while it is still narrating.
    private var current: Item?
    /// The last spot that played (fill-ins excluded), for "previous" = replay.
    private(set) var lastSpotId: String?
    private var lastPublished: String?
    private var started = false
    private var commandTargets: [(MPRemoteCommand, Any)] = []
    private let distanceFormatter = MKDistanceFormatter()

    private struct Item {
        let id: String
        let title: String
        let subtitle: String
        let durationS: Double?
    }

    init(tour: TourViewModel, location: LocationManager) {
        self.tour = tour
        self.location = location
    }

    func start() {
        guard !started else { return }
        started = true
        registerCommands()
        tour.player.$nowPlayingSpotId
            .removeDuplicates()
            .receive(on: RunLoop.main)
            .sink { [weak self] id in self?.itemChanged(id) }
            .store(in: &cancellables)
        tour.player.$isPlaying
            .removeDuplicates()
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.publish() }
            .store(in: &cancellables)
        tour.$isTouring
            .removeDuplicates()
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.publish() }
            .store(in: &cancellables)
        AudioSession.playbackAvailability
            .removeDuplicates()
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.publish() }
            .store(in: &cancellables)
        // Idle + touring shows what's up next. `nearby` changes every poll,
        // but publish() only writes when the composed text actually changed.
        tour.$nearby
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in
                guard let self else { return }
                self.publish()
            }
            .store(in: &cancellables)
        publish()
    }

    deinit {
        for (command, target) in commandTargets { command.removeTarget(target) }
    }

    // ─── Tour controls shared with CarPlay ───────────────────────────────────

    /// Same two calls as the phone's tour switch (ContentView.tourToggle).
    /// A demo drives its own fixes, so real GPS stays as it was.
    func startTour() {
        if tour.demo == nil { location.startTour() }
        tour.startTour(at: location.location)
    }

    func stopTour() {
        tour.stopTour()
        if tour.demo == nil { location.stopTour() }
    }

    var canReplayLast: Bool { replaySpot != nil }

    private var replaySpot: NearbySpot? {
        guard let id = lastSpotId ?? current?.id else { return nil }
        return (tour.nearby + tour.journeySpots).first {
            $0.spot.id == id && NarrationPreference.current.canNarrate($0.content)
        }
    }

    /// Skip: stopping the narration hands the decision back to the tour. In
    /// a demo, Next is the next stop at once.
    @discardableResult
    func skip() -> MPRemoteCommandHandlerStatus {
        if tour.demo != nil {
            tour.skipDemoToNextStop()
            return .success
        }
        guard tour.player.nowPlayingSpotId != nil else { return .noSuchContent }
        tour.player.stop(reason: "skip")
        return .success
    }

    /// Replay the last spot from the top, if it's still in reach of the list.
    @discardableResult
    func replayLast() -> MPRemoteCommandHandlerStatus {
        guard let spot = replaySpot else { return .noSuchContent }
        guard AudioSession.takeOver(userInitiated: true) else { return .commandFailed }
        tour.playManually(spot)
        return .success
    }

    // ─── Remote commands ─────────────────────────────────────────────────────

    private func registerCommands() {
        let c = MPRemoteCommandCenter.shared()
        let supported: [(MPRemoteCommand, String)] = [
            (c.playCommand, "play"), (c.pauseCommand, "pause"),
            (c.togglePlayPauseCommand, "toggle"), (c.stopCommand, "stop"),
            (c.nextTrackCommand, "next"), (c.previousTrackCommand, "previous"),
        ]
        for (command, name) in supported {
            command.isEnabled = true
            let target = command.addTarget { [weak self] _ in
                // MediaPlayer's callback has no main-actor guarantee.
                if Thread.isMainThread {
                    return MainActor.assumeIsolated { self?.handle(name) ?? .commandFailed }
                }
                return DispatchQueue.main.sync { self?.handle(name) ?? .commandFailed }
            }
            commandTargets.append((command, target))
        }
        // Only what we support shows up on the head unit.
        let unsupported: [MPRemoteCommand] = [
            c.skipForwardCommand, c.skipBackwardCommand, c.seekForwardCommand, c.seekBackwardCommand,
            c.changePlaybackPositionCommand, c.changePlaybackRateCommand, c.changeRepeatModeCommand,
            c.changeShuffleModeCommand, c.likeCommand, c.dislikeCommand, c.bookmarkCommand, c.ratingCommand,
        ]
        for cmd in unsupported { cmd.isEnabled = false }
    }

    func handle(_ command: String) -> MPRemoteCommandHandlerStatus {
        let narrating = tour.player.nowPlayingSpotId != nil
        TourDiagnostics.shared.log("remote_command", [
            "command": command, "narrating": narrating, "touring": tour.isTouring,
        ])
        switch command {
        case "play":
            guard AudioSession.takeOver(userInitiated: true) else { return .commandFailed }
            if narrating {
                if !tour.player.isPlaying { tour.player.toggle() }
            } else if !tour.isTouring {
                startTour()
            } else {
                // A call/Siri can interrupt the tour BETWEEN stories. The
                // head unit's Play button must be able to reclaim focus even
                // when there is no loaded narration to toggle.
                tour.decideNext()
            }
            return .success
        case "pause":
            if narrating {
                tour.player.pause()
            } else if tour.isTouring {
                stopTour()
            }
            return .success
        case "toggle":
            // A single play/pause button must also resume an interruption
            // between stories, when there is no player to toggle.
            return handle((narrating ? tour.player.isPlaying : tour.isTouring && AudioSession.canPlay)
                          ? "pause" : "play")
        case "stop":
            stopTour()
            if tour.player.nowPlayingSpotId != nil { tour.player.stop(reason: "remote_stop") }
            return .success
        case "next":
            return skip()
        case "previous":
            return replayLast()
        default:
            return .commandFailed
        }
    }

    // ─── Now Playing info ────────────────────────────────────────────────────

    private func itemChanged(_ id: String?) {
        // Replay can have the same title/rate as the preceding story. Its
        // elapsed time still needs to restart on the head unit.
        lastPublished = nil
        guard let id else {
            current = nil
            publish()
            return
        }
        current = resolve(id)
        if tour.fillInItem(id: id) == nil { lastSpotId = id }
        publish()
    }

    private func resolve(_ id: String) -> Item {
        let recordedPreferred = NarrationPreference.current.prefersServerAudio
        if let s = (tour.nearby + tour.journeySpots).first(where: { $0.spot.id == id }) {
            let recorded = recordedPreferred && s.content?.audioUrl != nil
            return Item(
                id: id,
                title: s.spot.title,
                subtitle: s.track.name,
                durationS: recorded ? s.content?.durationMs.map { $0 / 1000 } : nil
            )
        }
        if let f = tour.fillInItem(id: id) {
            let recorded = recordedPreferred && f.content?.audioUrl != nil
            return Item(
                id: id,
                title: f.payload.displayTitle,
                subtitle: tour.allTracks.first { $0.id == f.trackId }?.name ?? "Fill-in",
                durationS: recorded ? f.content?.durationMs.map { $0 / 1000 } : nil
            )
        }
        return Item(id: id, title: "GrandTour", subtitle: "", durationS: nil)
    }

    private func publish() {
        let center = MPNowPlayingInfoCenter.default()
        let c = MPRemoteCommandCenter.shared()
        c.nextTrackCommand.isEnabled = tour.player.nowPlayingSpotId != nil
        c.previousTrackCommand.isEnabled = canReplayLast
        var info: [String: Any] = [
            MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue,
            MPMediaItemPropertyAlbumTitle: "GrandTour",
        ]
        let state: MPNowPlayingPlaybackState
        if let item = current {
            let playing = tour.player.isPlaying
            info[MPMediaItemPropertyTitle] = item.title
            info[MPMediaItemPropertyArtist] = item.subtitle
            info[MPNowPlayingInfoPropertyPlaybackRate] = playing ? 1.0 : 0.0
            info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = tour.player.currentMs / 1000
            if let d = item.durationS { info[MPMediaItemPropertyPlaybackDuration] = d }
            state = playing ? .playing : .paused
        } else if tour.isTouring {
            // Between places the tour is live but silent: say so, and show
            // what's coming. Live-stream semantics give a "playing" state
            // with nothing to scrub.
            if !AudioSession.canPlay {
                info[MPMediaItemPropertyTitle] = "Tour paused"
                info[MPMediaItemPropertyArtist] = "Press play to resume"
            } else if let next = tour.upNext {
                info[MPMediaItemPropertyTitle] = "Up next: \(next.spot.title)"
                info[MPMediaItemPropertyArtist] = "\(next.track.name) · \(distanceFormatter.string(fromDistance: next.distanceM))"
            } else {
                info[MPMediaItemPropertyTitle] = "Listening for places…"
                info[MPMediaItemPropertyArtist] = "Tour on"
            }
            info[MPNowPlayingInfoPropertyIsLiveStream] = true
            info[MPNowPlayingInfoPropertyPlaybackRate] = AudioSession.canPlay ? 1.0 : 0.0
            state = AudioSession.canPlay ? .playing : .paused
        } else {
            // Stop ends narration, not our ownership of the media session.
            // Keep GrandTour's identity and Play command on the head unit
            // instead of clearing metadata and inviting a return to Music.
            info[MPMediaItemPropertyTitle] = "GrandTour"
            info[MPMediaItemPropertyArtist] = "Tour off · Press play to start"
            info[MPNowPlayingInfoPropertyIsLiveStream] = true
            info[MPNowPlayingInfoPropertyPlaybackRate] = 0.0
            state = .paused
        }
        // Elapsed time is deliberately outside the signature: it is only
        // re-published alongside a real state change.
        let signature = [
            current?.id ?? "",
            String(state.rawValue),
            info[MPMediaItemPropertyTitle] as? String ?? "",
            info[MPMediaItemPropertyArtist] as? String ?? "",
            String(describing: info[MPNowPlayingInfoPropertyPlaybackRate]),
            String(describing: info[MPMediaItemPropertyPlaybackDuration]),
        ].joined(separator: "|")
        guard signature != lastPublished else { return }
        lastPublished = signature
        center.nowPlayingInfo = info
        center.playbackState = state
    }
}
