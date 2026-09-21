import CarPlay
import Combine
import MapKit
import UIKit

/// The CarPlay AUDIO-app experience (entitlement com.apple.developer.carplay-audio):
/// a tab bar of glanceable lists — the tour switch and controls, what's
/// nearby, the track toggles — plus the system Now Playing screen, which reads
/// the state `NowPlayingController` publishes. This is the realistic
/// entitlement for an audio tour app; the live map and turn-by-turn in
/// `CarPlayController` need the navigation entitlement and are kept behind
/// `GRANDTOUR_CARPLAY_MODE=navigation` (see project.yml).
///
/// Lists are updated in place (`CPListItem.setDetailText` etc.) when only
/// text changed and rebuilt only when the set or order of rows changed — the
/// tour polls every 1.5 s, and rebuilding on every poll flickers and resets
/// the scroll position on the car screen.
@MainActor
final class CarPlayAudioController: NSObject {
    private let interfaceController: CPInterfaceController
    private let services = AppServices.shared
    private var cancellables: Set<AnyCancellable> = []

    private let tourList = CPListTemplate(title: "Tour", sections: [])
    private let nearbyList = CPListTemplate(title: "Nearby", sections: [])
    private let tracksList = CPListTemplate(title: "Tracks", sections: [])
    private lazy var tabBar = CPTabBarTemplate(templates: [tourList, nearbyList, tracksList])

    /// Nearby rows keyed by spot id, so distance text updates in place.
    private var nearbyItems: [String: CPListItem] = [:]
    private var nearbyOrder: [String] = []
    private var tourSignature = ""
    private var tracksSignature = ""
    private let distanceFormatter = MKDistanceFormatter()

    init(interfaceController: CPInterfaceController) {
        self.interfaceController = interfaceController
        super.init()
    }

    func start() {
        tourList.tabTitle = "Tour"
        tourList.tabImage = UIImage(systemName: "waveform.circle")
        nearbyList.tabTitle = "Nearby"
        nearbyList.tabImage = UIImage(systemName: "mappin.and.ellipse")
        nearbyList.emptyViewTitleVariants = ["Nothing nearby yet"]
        nearbyList.emptyViewSubtitleVariants = ["Stories appear as you approach them"]
        tracksList.tabTitle = "Tracks"
        tracksList.tabImage = UIImage(systemName: "square.stack.3d.up")
        interfaceController.setRootTemplate(tabBar, animated: false) { success, error in
            TourDiagnostics.shared.log("carplay_root_template", [
                "mode": "audio", "success": success, "error": error?.localizedDescription ?? "",
            ])
        }
        configureNowPlaying()
        bind()
        renderTour()
        renderNearby()
        renderTracks()
    }

    func tearDown() {
        cancellables.removeAll()
        let np = CPNowPlayingTemplate.shared
        np.remove(self)
        np.updateNowPlayingButtons([])
        np.isUpNextButtonEnabled = false
    }

    private func bind() {
        let tour = services.tour
        tour.$isTouring
            .removeDuplicates()
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.renderTour() }
            .store(in: &cancellables)
        tour.player.$nowPlayingSpotId
            .removeDuplicates()
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in
                self?.renderTour()
                self?.renderNearby()
                self?.renderTracks() // play counts moved
            }
            .store(in: &cancellables)
        tour.player.$isPlaying
            .removeDuplicates()
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.renderTour() }
            .store(in: &cancellables)
        tour.$nearby
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in
                self?.renderNearby()
                self?.renderTour()
            }
            .store(in: &cancellables)
        services.location.$authorized
            .combineLatest(services.location.$denied)
            .receive(on: RunLoop.main)
            .sink { [weak self] _, _ in self?.renderTour() }
            .store(in: &cancellables)
        AudioSession.playbackAvailability
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.renderTour() }
            .store(in: &cancellables)
        tour.$error
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.renderTour() }
            .store(in: &cancellables)
        tour.$allTracks
            .combineLatest(tour.$enabledTrackSlugs)
            .receive(on: RunLoop.main)
            .sink { [weak self] _, _ in self?.renderTracks() }
            .store(in: &cancellables)
    }

    // ─── Tour tab ────────────────────────────────────────────────────────────

    private func renderTour() {
        let tour = services.tour
        let touring = tour.isTouring
        let narrating = tour.player.nowPlayingSpotId != nil
        let gap = FillInGapPreference.current
        let canReplay = services.nowPlaying.canReplayLast
        let authorized = services.location.authorized
        let canPlay = AudioSession.canPlay
        let signature = "\(touring)|\(narrating)|\(gap.rawValue)|\(canReplay)|\(authorized)|\(canPlay)|\(tour.error ?? "")"
        guard signature != tourSignature else { return }
        tourSignature = signature

        let toggle = CPListItem(
            text: touring ? "Stop tour" : "Start tour",
            detailText: touring ? "Playing as you travel" : "Track me and play automatically",
            image: UIImage(systemName: touring ? "stop.circle.fill" : "play.circle.fill")
        )
        toggle.handler = { [weak self] _, done in
            guard let self else { done(); return }
            if self.services.tour.isTouring {
                self.services.nowPlaying.stopTour()
            } else {
                self.services.nowPlaying.startTour()
            }
            done()
        }
        toggle.isEnabled = touring || authorized

        let skip = CPListItem(
            text: "Skip to next place",
            detailText: narrating ? "Stop this story; the tour picks what's next" : "Nothing is playing",
            image: UIImage(systemName: "forward.end.fill")
        )
        skip.isEnabled = narrating
        skip.handler = { [weak self] _, done in
            self?.services.nowPlaying.skip()
            done()
        }

        let replay = CPListItem(
            text: "Replay last story",
            detailText: canReplay ? "From the top" : "Nothing has played yet",
            image: UIImage(systemName: "arrow.counterclockwise.circle.fill")
        )
        replay.isEnabled = canReplay
        replay.handler = { [weak self] _, done in
            guard let self else { done(); return }
            if self.services.nowPlaying.replayLast() == .success {
                self.interfaceController.pushTemplate(CPNowPlayingTemplate.shared, animated: true, completion: nil)
            }
            done()
        }

        // Tapping cycles the setting: Off → 30 s → 1 min → 2 min → 5 min → Off.
        // A picker would need a pushed list for one value; one tap per step
        // is less to look at while driving.
        let fill = CPListItem(
            text: "Fill quiet gaps",
            detailText: gap.label,
            image: UIImage(systemName: "text.book.closed")
        )
        fill.handler = { [weak self] _, done in
            let all = FillInGapPreference.allCases
            let i = all.firstIndex(of: FillInGapPreference.current) ?? 0
            FillInGapPreference.current = all[(i + 1) % all.count]
            self?.renderTour()
            done()
        }

        var controls = [toggle]
        if !authorized {
            let permission = CPListItem(text: "Location permission needed",
                detailText: "When parked, open GrandTour on iPhone and allow location in Settings.")
            permission.isEnabled = false
            controls.append(permission)
        }
        if touring && !canPlay {
            let resume = CPListItem(text: "Resume audio", detailText: "Tour audio was interrupted",
                image: UIImage(systemName: "play.circle"))
            resume.handler = { [weak self] _, done in
                _ = self?.services.nowPlaying.handle("play")
                done()
            }
            controls.append(resume)
        }
        let nowPlaying = CPListItem(text: "Now Playing", detailText: "Playback controls and current story",
            image: UIImage(systemName: "play.rectangle"))
        nowPlaying.isEnabled = touring || narrating
        nowPlaying.handler = { [weak self] _, done in
            self?.interfaceController.pushTemplate(CPNowPlayingTemplate.shared, animated: true, completion: nil)
            done()
        }
        controls += [nowPlaying, skip, replay]
        if let error = tour.error {
            let status = CPListItem(text: "Tour status", detailText: error)
            status.isEnabled = false
            controls.append(status)
        }
        tourList.updateSections([
            CPListSection(items: controls),
            CPListSection(items: [fill], header: "Between stories", sectionIndexTitle: nil),
        ])
    }

    // ─── Nearby tab ──────────────────────────────────────────────────────────

    private func renderNearby() {
        let tour = services.tour
        let spots = Array(tour.nearby.filter { NarrationPreference.current.canNarrate($0.content) }
            .prefix(CPListTemplate.maximumItemCount))
        let ids = spots.map(\.spot.id)
        let playingId = tour.player.nowPlayingSpotId
        var items: [CPListItem] = []
        for s in spots {
            var detail = "\(s.track.name) · \(distanceFormatter.string(fromDistance: s.distanceM))"
            if s.triggered { detail += " · here" }
            if let item = nearbyItems[s.spot.id] {
                if item.detailText != detail { item.setDetailText(detail) }
                if item.text != s.spot.title { item.setText(s.spot.title) }
                item.isPlaying = playingId == s.spot.id
                items.append(item)
                continue
            }
            let item = CPListItem(
                text: s.spot.title,
                detailText: detail,
                image: Self.marker(UIColor(hexColor: s.track.color) ?? .systemTeal)
            )
            item.playingIndicatorLocation = .trailing
            item.isPlaying = playingId == s.spot.id
            let spotId = s.spot.id
            item.handler = { [weak self] _, done in
                guard let self else { done(); return }
                // Re-resolve: the row may be older than the latest poll.
                let all = self.services.tour.nearby + self.services.tour.journeySpots
                if let live = all.first(where: { $0.spot.id == spotId }) {
                    self.services.tour.playManually(live)
                    self.interfaceController.pushTemplate(CPNowPlayingTemplate.shared, animated: true, completion: nil)
                }
                done()
            }
            nearbyItems[spotId] = item
            items.append(item)
        }
        nearbyItems = nearbyItems.filter { ids.contains($0.key) }
        if ids != nearbyOrder {
            nearbyOrder = ids
            nearbyList.updateSections([CPListSection(items: items)])
        }
    }

    // ─── Tracks tab ──────────────────────────────────────────────────────────

    private func renderTracks() {
        let tour = services.tour
        var signature: [String] = []
        func row(_ t: Track) -> CPListItem {
            let on = tour.enabledTrackSlugs.contains(t.slug)
            let completed = tour.isCompleted(t)
            var detail = t.description
            if completed {
                detail = "Complete · tap to start over"
            } else if let p = tour.trackProgress(t), p.played > 0 {
                detail = "\(p.played) of \(p.total) heard"
            }
            detail = detail.isEmpty ? t.countLabel : "\(t.countLabel) · \(detail)"
            signature.append("\(t.slug)|\(on)|\(detail)")
            let item = CPListItem(
                text: t.name,
                detailText: detail,
                image: UIImage(systemName: on ? "checkmark.circle.fill" : "circle")
            )
            item.handler = { [weak self] _, done in
                guard let self else { done(); return }
                if completed {
                    self.services.tour.startOver(t) // also switches it back on
                } else {
                    self.services.tour.toggleTrack(t.slug)
                }
                done()
            }
            return item
        }
        let tracks = Array(tour.allTracks.prefix(CPListTemplate.maximumItemCount))
        let tours = tracks.filter { !$0.isFillIn }.map(row)
        let fillers = tracks.filter(\.isFillIn).map(row)
        let sig = signature.joined(separator: ";")
        guard sig != tracksSignature else { return }
        tracksSignature = sig
        var sections = [CPListSection(items: tours)]
        if !fillers.isEmpty {
            sections.append(CPListSection(items: fillers, header: "Between stories", sectionIndexTitle: nil))
        }
        tracksList.updateSections(sections)
    }

    // ─── Now Playing screen ──────────────────────────────────────────────────

    /// The system template shows title/artist/progress from
    /// `MPNowPlayingInfoCenter`; we add the two tour-specific actions and
    /// point its "up next" button at the Nearby tab.
    private func configureNowPlaying() {
        let np = CPNowPlayingTemplate.shared
        let replay = CPNowPlayingImageButton(
            image: UIImage(systemName: "arrow.counterclockwise") ?? UIImage()
        ) { [weak self] _ in
            self?.services.nowPlaying.replayLast()
        }
        let skip = CPNowPlayingImageButton(
            image: UIImage(systemName: "forward.end.fill") ?? UIImage()
        ) { [weak self] _ in
            self?.services.nowPlaying.skip()
        }
        np.updateNowPlayingButtons([replay, skip])
        np.isUpNextButtonEnabled = true
        np.upNextTitle = "Nearby"
        np.isAlbumArtistButtonEnabled = false
        np.add(self)
    }

    private static func marker(_ color: UIColor) -> UIImage? {
        UIImage(systemName: "circle.fill")?
            .withTintColor(color, renderingMode: .alwaysOriginal)
    }
}

extension CarPlayAudioController: CPNowPlayingTemplateObserver {
    func nowPlayingTemplateUpNextButtonTapped(_ nowPlayingTemplate: CPNowPlayingTemplate) {
        interfaceController.popToRootTemplate(animated: true, completion: nil)
        tabBar.select(nearbyList)
    }
}
