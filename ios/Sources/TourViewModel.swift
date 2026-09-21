import Foundation
import CoreLocation
import Combine

/// Where the nearby results currently come from: the user's own GPS position,
/// or a coordinate they panned the map to while exploring elsewhere.
enum NearbyOrigin: Equatable {
    case here
    case exploring(CLLocationCoordinate2D)

    static func == (a: NearbyOrigin, b: NearbyOrigin) -> Bool {
        switch (a, b) {
        case (.here, .here): return true
        case let (.exploring(x), .exploring(y)):
            return x.latitude == y.latitude && x.longitude == y.longitude
        default: return false
        }
    }
}

/// Orchestrates the tour. In `.here` mode it follows GPS and auto-plays the
/// closest triggered spot; in `.exploring` mode it fetches around a map center
/// so stories can be browsed (and played on demand) from anywhere.
@MainActor
final class TourViewModel: ObservableObject {
    @Published var nearby: [NearbySpot] = []
    @Published var enabledTrackSlugs: Set<String> = []
    @Published var allTracks: [Track] = []
    /// Items of every fill-in track, fetched with the catalog; the gap
    /// planner draws from these (filtered to enabled tracks at pick time).
    @Published private(set) var fillInItems: [FillInItem] = []
    /// Per-track unit indexes (by slug), fetched with the catalog and cached.
    /// Sequence eligibility and completion both read these — /nearby can't
    /// serve either, because it only sees what's in range.
    @Published private(set) var manifests: [String: TrackManifest] = [:]
    /// The mode sent to the server — never "auto": the explicit preference,
    /// or the speed-inferred answer when the preference is auto. The server
    /// filters spots by it, so a change changes what's in range: refetch.
    @Published private(set) var mode: String = "walking" {
        didSet {
            guard mode != oldValue else { return }
            TourDiagnostics.shared.log("mode_changed", [
                "from": oldValue, "to": mode, "preference": modePreference,
            ])
            invalidateAndRefresh()
        }
    }
    /// What the user chose: `ActivityModePreference.auto` or an explicit
    /// mode. Persisted — an unpersisted "walking" default once hid every
    /// driving-only spot for a whole afternoon's drive.
    @Published var modePreference: String = ActivityModePreference.auto {
        didSet {
            guard modePreference != oldValue else { return }
            ActivityModePreference.save(modePreference, to: selectionDefaults)
            applyModePreference()
        }
    }
    private var modeDetector = ActivityModeDetector()
    /// Why the nearby list is empty, for the UI. An empty poll looks the same
    /// whether nothing is authored here or the mode/track filters hid it all;
    /// `explainEmptyNearby` probes without the filters to tell them apart.
    @Published private(set) var emptyNearbyHint: String?
    private var lastEmptyProbeAt: Date = .distantPast
    @Published var error: String?
    @Published private(set) var origin: NearbyOrigin = .here
    @Published private(set) var isLoading = false
    /// The master switch. ON = track continuously and auto-play as you travel.
    @Published private(set) var isTouring = false
    /// True while nearby is being served from the offline cache because the
    /// server couldn't be reached. Clears on the next successful fetch.
    @Published private(set) var isOffline = false
    /// The active journey's route, for the map overlay. Empty = no journey.
    @Published private(set) var journeyRoute: [CLLocationCoordinate2D] = []
    /// Spots along the active journey corridor, in travel order.
    @Published private(set) var journeySpots: [NearbySpot] = []
    // ─── Demo: a track's route as a simulated trip (DemoDrive) ──────────────
    /// The demo in progress, if any. Its fixes are the only ones the tour
    /// reads while it runs; real GPS waits underneath.
    @Published private(set) var demo: DemoDrive?
    /// The car's latest fix, for the map's traveler.
    @Published private(set) var demoFix: CLLocation?
    /// What the demo displaced, restored by `endDemo`.
    private var beforeDemo: (selection: Set<String>, history: PlayHistory, style: TourStyle)?
    /// The last real fix seen while a demo ran, so ending it resumes from there.
    private var lastRealLocation: CLLocation?
    /// When the demo's player went idle, for the story spacing before the next stop.
    private var demoIdleSince: Date?
    /// Runs the demo's driver every second, fixes or none (the car may be parked).
    private var demoTimer: Timer?
    /// The stops whose recordings were last sent to the cache ahead of their turn.
    private var demoPrefetchedIds: Set<String> = []

    private let api: GrandTourAPI
    private let cache: TourCache
    private let selectionDefaults: UserDefaults
    private var selectionLoaded = false
    private var selectionRevision = 0
    private var exploreRadiusM: Double = 2000
    private var selectionKey: String { "enabledTracks:" + ServerPreference.currentURL.absoluteString }
    private var history: PlayHistory
    private let now: () -> Date
    private var lastFetchAt: Date = .distantPast
    private var isFetching = false
    /// The wander-mode decision core: predicts where the traveler will be
    /// when the player is free and names the one spot to head for. Pure, so
    /// simulated journeys drive it in tests (SpotSchedulerTests).
    private let scheduler = SpotScheduler()
    /// The latest wander decision — `upNext` reads its target. Recomputed at
    /// every poll and every player-idle moment.
    @Published private(set) var wanderPlan: SpotScheduler.Plan?
    /// The latest guided decision (walking-tour style): next stop, directions.
    @Published private(set) var guidedPlan: GuidedTourPlanner.Plan?
    /// Wander (every enabled track, predict-and-play) or a guided walking
    /// tour of one track. Persisted; switching mid-tour re-plans from scratch.
    @Published var tourStyle: TourStyle = TourStyle.current {
        didSet {
            guard tourStyle != oldValue else { return }
            TourStyle.current = tourStyle
            resetGuidedSession()
            wanderPlan = nil
            guidedPlan = nil
            TourDiagnostics.shared.log("tour_style", ["style": Self.describe(tourStyle)])
            invalidateAndRefresh()
        }
    }
    // ─── Guided-tour session state ───────────────────────────────────────────
    /// Stops narrated this outing (auto or manual). Seeded at tour start
    /// with stops heard within the replay cooldown, so reopening the app
    /// mid-walk continues where it left off.
    private var guidedVisited: Set<String> = []
    private var guidedSeeded = false
    /// The last spoken direction cue: which stop, how far it was, and when —
    /// for "you're heading away" and periodic reminders.
    private var guidedCue: (stopId: String, distanceM: Double, at: Date)?
    private var guidedFinishedAnnounced = false
    // ─── Player occupancy, for the prediction horizon ────────────────────────
    /// When the current item started and how long it was expected to run;
    /// `playerBusyForS` derives the remaining time the scheduler predicts
    /// across.
    private var narrationStartedAt: Date?
    private var narrationDurationS: TimeInterval = 0
    /// Newest content timestamp we hold, echoed as `changedSince` so a poll
    /// with nothing new costs the server one cheap query.
    private var dataVersion: String?
    /// Heartbeat that keeps polling while the traveler is stationary, so
    /// newly published content arrives without waiting for them to move.
    private var pollTask: Task<Void, Never>?
    /// Last position we polled from, for the stationary heartbeat.
    private var lastKnownLocation: CLLocation?
    /// Where `dataVersion` was fetched from; it's only comparable near there.
    private var versionAnchor: CLLocation?
    /// Previous polled location, for deriving direction of travel when the
    /// GPS course is invalid (e.g. walking slowly).
    private var prevLocation: CLLocation?
    /// Freshest known direction of travel, for the play-time spot locator.
    private var lastCourseDeg: Double?
    private var eligibility = PlaybackEligibility()
    private var seriesUnitIds: Set<String> { eligibility.seriesUnitIds }

    /// Cancels an in-flight explore fetch when the map moves again.
    private var exploreTask: Task<Void, Never>?
    /// Snaps a touring traveler out of a forgotten explore pan. Armed on every
    /// explore gesture, cancelled by returnToHere.
    private var exploreExpiryTask: Task<Void, Never>?

    // ─── Fill-in gap planner (plans/014-fillin-content.md) ──────────────────
    /// When the last narration ended (or the tour turned on) — the
    /// clock the gap planner measures actual silence against. Fill-ins re-arm it too,
    /// so one gap gets one item, not a back-to-back stream.
    private var lastTourNarrationAt: Date = .distantPast
    private var narrationGap = NarrationGap()
    private var narrationGapTask: Task<Void, Never>?
    /// Session-only dedup; deliberately not persisted (no spaced repetition).
    /// When every enabled item has played once, it clears and starts over.
    private var playedFillInIds: Set<String> = []
    /// When each fill-in track last supplied an item, for the round-robin in
    /// `pickFillInItem`. Session-only, like the dedup above.
    private var fillInTrackLastPlayedAt: [String: Date] = [:]
    /// How long narration must be silent before a fill-in is inserted —
    /// the user's setting (default 30s; nil = off). `GRANDTOUR_FILLIN_GAP_S`
    /// (simulator launch env) overrides it for testing, so gap behavior can
    /// be exercised without real silent minutes.
    private var fillInGapThreshold: TimeInterval? {
        if let s = ProcessInfo.processInfo.environment["GRANDTOUR_FILLIN_GAP_S"],
           let v = TimeInterval(s), v > 0 {
            return v
        }
        return FillInGapPreference.current.seconds
    }

    let player = AudioPlayer()
    private var cancellables: Set<AnyCancellable> = []

    init(history: PlayHistory = .shared, now: @escaping () -> Date = Date.init,
         selectionDefaults: UserDefaults = .standard, cache: TourCache = .shared,
         api: GrandTourAPI = GrandTourAPI()) {
        self.api = api
        self.cache = cache
        self.selectionDefaults = selectionDefaults
        self.history = history
        self.now = now
        modePreference = ActivityModePreference.load(from: selectionDefaults)
        mode = modePreference == ActivityModePreference.auto ? modeDetector.current : modePreference
        scheduler.log = { TourDiagnostics.shared.log($0, $1) }
        // Switching servers invalidates everything fetched from the old one.
        NotificationCenter.default.publisher(for: ServerPreference.didChange)
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in
                Task { await self?.serverDidChange() }
            }
            .store(in: &cancellables)
        // When narration ends (finished, stopped, or interrupted away), decide
        // what's next: a spot entered while it was talking, a fill-in, or
        // silence. Nothing preempts and nothing plays over anything else —
        // this fires only when the player has gone idle.
        player.$nowPlayingSpotId
            .removeDuplicates()
            .sink { [weak self] id in
                guard let self else { return }
                if self.narrationGap.observe(id, at: self.now()) {
                    self.lastTourNarrationAt = self.now()
                }
                guard id == nil else { return }
                // @Published emits before the property changes.
                Task { @MainActor [weak self] in self?.decideNext() }
            }
            .store(in: &cancellables)
        AudioSession.playbackAvailability
            .removeDuplicates()
            .dropFirst()
            .receive(on: RunLoop.main)
            .sink { [weak self] allowed in
                if allowed { self?.decideNext() }
            }
            .store(in: &cancellables)
        // A few seconds before recorded narration ends, refresh position and
        // pre-warm the likely winner's audio so the end-of-narration decision
        // runs on fresh data and starts without a buffering gap.
        player.onApproachingEnd = { [weak self] in
            self?.prepareForDecision()
        }
    }

    var isExploring: Bool {
        if case .exploring = origin { return true }
        return false
    }

    func loadTracks() async {
        // A downloaded tour is ready before any request leaves the phone.
        // Waiting for catalog/fill-in/manifest timeouts on an offline launch
        // could otherwise leave the track picker empty for over a minute.
        refreshDownloadedContent()
        // Classify the server once: an authoring server has the live API; a
        // static one — grandtour.fyi, a repository — only the index and bundles.
        await api.probe()
        do {
            allTracks = try await api.tracks()
            self.cache.absorb(tracks: allTracks)
            allTracks = self.cache.tracksFallback()
        } catch {
            allTracks = self.cache.tracksFallback()
            if allTracks.isEmpty {
                self.error = "Could not load tracks: \(error.localizedDescription)"
            }
        }
        restoreTrackSelection()
        await ensureBundlesNearby(at: lastKnownLocation)
        await loadFillInItems()
        await loadManifests()
    }

    /// Server uploads need an authoring server. Local recording is always available.
    var supportsRecordingUploads: Bool { api.isLive }

    // ─── Static servers: bundles fetched for the cells around here ──────────
    private var bundleSyncCells: [String]?
    private var bundleSyncAt: Date = .distantPast

    /// Make sure the bundles for the enabled tracks around `loc` are on the
    /// device — a static server's whole protocol. Selection is by area cell
    /// (`AreaId.around`), so a Marin phone never pulls a Hawaii tour; with no
    /// position yet, every enabled track is fetched. Re-runs when the cells
    /// change, when the selection changes, and hourly otherwise.
    private func ensureBundlesNearby(at loc: CLLocation?) async {
        guard api.isStatic else { return }
        let entries = api.indexEntries()
        let cells = loc.map { AreaId.around(lat: $0.coordinate.latitude, lng: $0.coordinate.longitude) }
        if let cells, cells == bundleSyncCells, now().timeIntervalSince(bundleSyncAt) < 3600 { return }
        bundleSyncCells = cells
        bundleSyncAt = now()
        let wanted = allTracks.filter { enabledTrackSlugs.contains($0.slug) }.filter { track in
            guard let cells, let areas = entries[track.slug]?.areas else { return true }
            return areas.contains { cells.contains($0) }
        }
        var ok = true
        for track in wanted {
            ok = await cache.ensureBundle(for: track, api: api, hash: entries[track.slug]?.hash) && ok
        }
        if !ok { bundleSyncAt = .distantPast } // retry on the next fix
        applyManifests(cache.manifestsFallback())
        TourDiagnostics.shared.log("bundles_synced", ["wanted": wanted.map(\.slug), "ok": ok, "cells": cells ?? []])
    }

    private func restoreTrackSelection() {
        if !selectionLoaded && !allTracks.isEmpty {
            selectionLoaded = true
            enabledTrackSlugs = selectionDefaults.stringArray(forKey: selectionKey).map(Set.init)
                ?? Set(allTracks.map(\.slug)) // only the first visit defaults to all on
            // …except series tracks the user already finished: completing one
            // disabled it, and a fresh launch must not quietly re-enable it.
            for t in allTracks where TrackProgress.shared.completion(t.slug) != nil {
                enabledTrackSlugs.remove(t.slug)
            }
        }
    }

    /// Refresh the active tour immediately after a full-track download, and
    /// hydrate a cold offline launch before making network requests.
    func refreshDownloadedContent() {
        let stored = cache.tracksFallback()
        if allTracks.isEmpty { allTracks = stored }
        else {
            let ids = Set(allTracks.map(\.id))
            allTracks.append(contentsOf: stored.filter { !ids.contains($0.id) })
        }
        restoreTrackSelection()
        fillInItems = cache.fillInItemsFallback()
        applyManifests(cache.manifestsFallback())
        if let loc = lastKnownLocation { evaluateDownloadedContent(at: loc) }
    }

    /// The active server changed: stop the tour, drop the catalog, nearby
    /// list, and data version (all server-specific), and load fresh. Track
    /// slugs differ between servers, so the enabled set resets to the new
    /// catalog's default.
    func serverDidChange() async {
        GrandTourAPI.resetProbes()
        if demo != nil { endDemo() }
        bundleSyncCells = nil
        stopTour()
        nearby = []
        journeySpots = []
        journeyRoute = []
        allTracks = []
        fillInItems = []
        manifests = [:]
        enabledTrackSlugs = []
        selectionLoaded = false
        selectionRevision += 1
        error = nil
        isOffline = false
        await loadTracks()
        invalidateAndRefresh()
    }

    /// Fetch every track's manifest (not just enabled ones, so toggling needs
    /// no refetch), falling back to the cached copy offline.
    private func loadManifests() async {
        do {
            let list = try await api.trackManifests()
            self.cache.absorb(manifests: list)
            applyManifests(self.cache.manifestsFallback())
        } catch {
            let cached = self.cache.manifestsFallback()
            applyManifests(cached)
        }
    }

    /// Install one complete server/cache snapshot before making decisions.
    func applyManifests(_ list: [TrackManifest]) {
        manifests = Dictionary(list.map { ($0.slug, $0) }, uniquingKeysWith: { a, _ in a })
        eligibility = PlaybackEligibility(manifests: list)
        reconcileCompletions()
    }

    /// A stored completion goes stale when the track grows past the unit
    /// count it was completed at — new chapters reopen it (and it shows as
    /// "n new" in the Tracks sheet) but never silently re-enable it; opting
    /// back in stays the user's move. Edits to existing units (re-recorded
    /// audio) don't reopen a finished track.
    private func reconcileCompletions() {
        for (slug, m) in manifests {
            guard let c = TrackProgress.shared.completion(slug),
                  m.units.count > c.unitCount else { continue }
            TrackProgress.shared.clearCompletion(slug)
            TourDiagnostics.shared.log("track_reopened", [
                "slug": slug,
                "units": m.units.count,
                "completedUnits": c.unitCount,
            ])
        }
    }

    /// Fetch every fill-in track's items alongside the catalog. All fill-in
    /// tracks are fetched (not just enabled ones) so toggling one on later
    /// needs no refetch; enablement filters at pick time.
    private func loadFillInItems() async {
        let slugs = allTracks.filter(\.isFillIn).map(\.slug)
        guard !slugs.isEmpty else {
            fillInItems = []
            return
        }
        do {
            fillInItems = try await api.fillInItems(tracks: slugs)
            self.cache.absorb(fillInItems: fillInItems)
            // Live fill-in polling is a rotating sample. A downloaded track
            // retains its whole saved set even when that sample is smaller.
            fillInItems = self.cache.fillInItemsFallback()
        } catch {
            // Not worth surfacing: the tour works without fillers.
            fillInItems = self.cache.fillInItemsFallback()
        }
    }

    /// The thing the tour will play next — always one precise spot, never a
    /// queue. Wander: the scheduler's target (least-heard eligible spot ahead
    /// of where the traveler will be when the player frees up). Guided: the
    /// next stop to walk to. Nil when nothing qualifies.
    var upNext: NearbySpot? {
        if tourStyle.isGuided { return guidedPlan?.nextStop }
        if let target = wanderPlan?.target { return target }
        // A demo's next stop along the route — as the list knows it (distance, triggered) when it is in range.
        guard let stop = demoNextStop else { return nil }
        return nearby.first { $0.spot.id == stop.spot.id } ?? stop.spot
    }

    /// One line under "Up next": where it is relative to the traveler right
    /// now ("Coming up in 90 meters on your left"). In guided mode these are
    /// the directions to follow.
    var upNextDetail: String? {
        if tourStyle.isGuided { return guidedPlan?.directions }
        return upNext.flatMap { locatorIntro(for: $0) }
    }

    /// Seconds the player is expected to stay busy: the prediction horizon.
    /// Recorded audio reports its clock; on-device speech runs on the
    /// estimate it started with.
    private var playerBusyForS: TimeInterval {
        guard player.nowPlayingSpotId != nil, let started = narrationStartedAt else { return 0 }
        let elapsed = player.currentMs > 0 ? player.currentMs / 1000 : now().timeIntervalSince(started)
        return max(0, narrationDurationS - elapsed)
    }

    /// Snapshot of everything the scheduler's geometry depends on.
    private var schedulerContext: SpotScheduler.Context {
        SpotScheduler.Context(
            location: lastKnownLocation,
            courseDeg: lastCourseDeg,
            mode: mode,
            journeyRoute: journeyRoute,
            trackOrder: TrackPreference.current,
            trackIdToSlug: Dictionary(
                allTracks.map { ($0.id, $0.slug) },
                uniquingKeysWith: { a, _ in a }
            ),
            now: now(),
            lastPlayedAt: { [history] in history.lastPlayedAt($0) },
            playCount: { [history] in history.playCount($0) },
            isEligible: { [weak self] in self?.isSequenceEligible($0) ?? true },
            neverReplays: { [weak self] in self?.seriesUnitIds.contains($0) ?? false },
            busyForS: playerBusyForS,
            nowPlayingId: player.nowPlayingSpotId
        )
    }

    /// Tracks the tour fetches and plays: the guided track alone, or every
    /// enabled track.
    private var activeTrackSlugs: [String] {
        if let slug = tourStyle.guidedTrackSlug { return [slug] }
        return Array(enabledTrackSlugs)
    }

    private static func describe(_ style: TourStyle) -> String {
        switch style {
        case .wander: return "wander"
        case .guided(let slug): return "guided:\(slug)"
        }
    }

    /// The sequence gate: a story part is auto-playable only once every
    /// lower-index part of its group has been heard. Units outside any group
    /// — and units of tracks whose manifest hasn't arrived — pass (fail open:
    /// playing slightly out of order beats never playing).
    private func isSequenceEligible(_ unitId: String) -> Bool {
        eligibility.isSequenceEligible(unitId, playCount: history.playCount)
    }

    // ─── Track progress / completion ─────────────────────────────────────────

    /// (heard, total) narratable units — nil when no manifest (or an empty one).
    func trackProgress(_ track: Track) -> (played: Int, total: Int)? {
        guard let m = manifests[track.slug], !m.units.isEmpty else { return nil }
        let played = m.units.filter { history.playCount($0.id) > 0 }.count
        return (played, m.units.count)
    }

    func isCompleted(_ track: Track) -> Bool {
        TrackProgress.shared.completion(track.slug) != nil
    }

    /// Wipe a track's play history and completion so its stories count as
    /// never heard, and switch it back on.
    func startOver(_ track: Track) {
        if let m = manifests[track.slug] {
            history.removeAll(ids: m.units.map(\.id))
        }
        TrackProgress.shared.clearCompletion(track.slug)
        enabledTrackSlugs.insert(track.slug)
        TourDiagnostics.shared.log("track_start_over", ["slug": track.slug])
        invalidateAndRefresh()
    }

    /// After any play: if this unit finished off a series track, record the
    /// completion and switch the track off — the podcast is over. Never fires
    /// twice (the stored completion gates it), and never touches evergreen
    /// tracks.
    private func updateCompletion(forTrackId trackId: String) {
        guard demo == nil else { return } // a demo finishes nothing for real
        guard let track = allTracks.first(where: { $0.id == trackId }),
              let m = manifests[track.slug],
              m.isSeries,
              !m.units.isEmpty,
              TrackProgress.shared.completion(track.slug) == nil,
              m.units.allSatisfy({ history.playCount($0.id) > 0 })
        else { return }
        TrackProgress.shared.markCompleted(slug: track.slug, unitCount: m.units.count)
        TourDiagnostics.shared.log("track_completed", [
            "slug": track.slug,
            "units": m.units.count,
        ])
        if enabledTrackSlugs.contains(track.slug) {
            enabledTrackSlugs.remove(track.slug)
            invalidateAndRefresh()
        }
    }

    /// Resolve a now-playing id that belongs to a fill-in item (the player's
    /// `nowPlayingSpotId` carries either kind of id).
    func fillInItem(id: String) -> FillInItem? {
        fillInItems.first { $0.id == id }
    }

    // ─── Tour on/off ─────────────────────────────────────────────────────────

    /// Turn the tour ON: auto-play resumes and the stationary heartbeat starts.
    /// Returning to `.here` too, since touring while the map is parked
    /// somewhere else would silently never trigger anything.
    func startTour(at loc: CLLocation?) {
        guard !isTouring else { return }
        if !AudioSession.canPlay { AudioSession.takeOver(userInitiated: true) }
        isTouring = true
        // Arm the gap clock from tour start, so a spot-free first stretch
        // still gets a fill-in after one threshold, not never.
        lastTourNarrationAt = now()
        TourDiagnostics.shared.startSession()
        // Which output this session is on — the one fact that tells a car
        // drive apart from a walk when reading the log afterwards.
        TourDiagnostics.shared.log("audio_route", AudioSession.routeSummary())
        TourDiagnostics.shared.log("tour_config", [
            "mode": mode, "modePreference": modePreference,
            "tracks": activeTrackSlugs, "style": Self.describe(tourStyle),
        ])
        // Keep the car/Bluetooth stream warm for the whole tour; see
        // AudioKeepalive for why silence between plays was the dropout.
        AudioKeepalive.shared.setWanted(true)
        exploreTask?.cancel()
        exploreExpiryTask?.cancel()
        origin = .here
        // A version cached while browsing would make the tour's first poll
        // come back `unchanged` — with stale `triggered` flags, so a spot the
        // traveler is already standing in would never play. Start clean.
        dataVersion = nil
        versionAnchor = nil
        lastFetchAt = .distantPast
        if demo == nil { lastKnownLocation = loc ?? lastKnownLocation }
        resetGuidedSession()
        startHeartbeat()
        if let drive = demo {
            // Driving the route again is a new demo: nothing heard yet.
            if drive.atEnd { history = PlayHistory.inMemory() }
            drive.start() // sends its first fix at once
        } else if let loc {
            Task { await locationDidUpdate(loc) }
        }
    }

    /// Turn the tour OFF: stop polling, stop auto-play, silence any narration
    /// in flight. The list stays on screen so it can still be browsed by hand.
    func stopTour() {
        guard isTouring else { return }
        isTouring = false
        narrationGapTask?.cancel()
        narrationGapTask = nil
        pollTask?.cancel()
        pollTask = nil
        // Fill-in dedup and rotation are per tour session; the next tour
        // reshuffles.
        playedFillInIds.removeAll()
        fillInTrackLastPlayedAt.removeAll()
        wanderPlan = nil
        guidedPlan = nil
        resetGuidedSession()
        AudioKeepalive.shared.setWanted(false)
        player.stop()
        demo?.pause()
        TourDiagnostics.shared.endSession()
    }

    private func resetGuidedSession() {
        guidedVisited = []
        guidedSeeded = false
        guidedCue = nil
        guidedFinishedAnnounced = false
    }

    // ─── Journey ─────────────────────────────────────────────────────────────

    /// Prefetch everything along a planned route: corridor spots from the
    /// server, then all their audio onto disk. After this completes the whole
    /// journey plays with zero connectivity. Turns the tour on if it isn't.
    func startJourney(route: [CLLocationCoordinate2D], at loc: CLLocation?) async {
        guard !activeTrackSlugs.isEmpty else {
            error = "Choose a track before starting a journey."
            return
        }
        do {
            let spots = try await api.routeNearby(
                points: route.map { (lat: $0.latitude, lng: $0.longitude) },
                tracks: activeTrackSlugs,
                mode: mode,
                locale: LocalePreference.defaultLocale,
                trackLocales: LocalePreference.trackLocalesParam(
                    activeTracks: activeTrackSlugs, defaultLocale: LocalePreference.defaultLocale
                )
            )
            journeyRoute = route
            journeySpots = spots
            self.cache.absorb(spots)
            TourDiagnostics.shared.log("journey_start", [
                "routePoints": route.count,
                "spots": spots.count,
            ])
            if !isTouring { startTour(at: loc) }
            // Download every narration + locating clip along the corridor,
            // with progress published for the journey sheet.
            await self.cache.cacheAudio(for: spots, trackProgress: true)
        } catch {
            self.error = "Journey planning failed: \(error.localizedDescription)"
            TourDiagnostics.shared.log("journey_failed", ["error": error.localizedDescription])
        }
    }

    func endJourney() {
        journeyRoute = []
        journeySpots = []
        self.cache.clearAudioProgress()
        TourDiagnostics.shared.log("journey_end", [:])
    }

    // ─── Demo ────────────────────────────────────────────────────────────────

    /// Prepare a demo of `track`: fetch its bundle, plot a route through every
    /// spot, and stand the car at its start with that track alone on —
    /// history in memory, the selection unsaved, real GPS ignored. The tour
    /// itself waits for Start tour, which drives the route at a pace set by
    /// the activity mode or the track's size. `endDemo` restores what the
    /// real tour had. The web app's Demo button does the same.
    func startDemo(_ track: Track) async {
        guard !track.isFillIn else { return }
        error = nil
        let entry = api.indexEntries()[track.slug]
        guard await cache.ensureBundle(for: track, api: api, hash: entry?.hash),
              let bundle = cache.bundle(for: track) else {
            error = "Could not load \(track.name) for a demo."
            return
        }
        let route = await DemoRoute.plan(for: bundle)
        guard route.count >= 2 else {
            error = "\(track.name) has no route to demo."
            return
        }
        if let running = demo {
            running.pause()
            running.onFix = nil
        } else {
            beforeDemo = (enabledTrackSlugs, history, tourStyle)
            lastRealLocation = lastKnownLocation
        }
        stopTour()
        history = PlayHistory.inMemory()
        selectionRevision += 1
        enabledTrackSlugs = [track.slug]
        if case .guided(let slug) = tourStyle, slug != track.slug { tourStyle = .wander }
        nearby = []
        journeySpots = []
        journeyRoute = []
        emptyNearbyHint = nil
        wanderPlan = nil
        guidedPlan = nil
        bundleSyncCells = nil
        dataVersion = nil
        versionAnchor = nil
        prevLocation = nil
        let anchors = bundle.spots.map {
            CLLocationCoordinate2D(latitude: $0.spot.trigger.center.lat, longitude: $0.spot.trigger.center.lng)
        }
        let pace = DemoRoute.pace(spanKm: DemoRoute.spanKm(of: anchors), preference: modePreference)
        let drive = DemoDrive(track: track, route: route, spots: bundle.nearbySpots, mph: pace, now: now)
        drive.onFix = { [weak self] fix in
            guard let self else { return }
            self.demoFix = fix
            Task { await self.locationDidUpdate(fix, synthetic: true) }
        }
        demo = drive
        demoIdleSince = nil
        demoTimer?.invalidate()
        demoTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.demoDrive() }
        }
        let first = drive.fix()
        demoFix = first
        lastKnownLocation = first
        TourDiagnostics.shared.log("demo_start", [
            "slug": track.slug, "routePoints": route.count, "mph": pace,
            "authoredRoute": bundle.routePath != nil,
        ])
        // A demo declares its pace; there is nothing to infer. Setting it
        // refreshes what is near the car's start, so the map shows the stops.
        if modePreference == ActivityModePreference.auto { mode = DemoRoute.mode(forMph: pace) }
        else { invalidateAndRefresh() }
    }

    /// End the demo: the car stops, the tour turns off, and the tracks,
    /// history and style from before come back. The last real fix carries on.
    func endDemo() {
        guard let drive = demo else { return }
        drive.pause()
        drive.onFix = nil
        demoTimer?.invalidate()
        demoTimer = nil
        demoIdleSince = nil
        demoPrefetchedIds = []
        stopTour()
        demo = nil
        demoFix = nil
        if let before = beforeDemo {
            history = before.history
            selectionRevision += 1
            enabledTrackSlugs = before.selection
            if tourStyle != before.style { tourStyle = before.style }
            beforeDemo = nil
        }
        nearby = []
        wanderPlan = nil
        guidedPlan = nil
        bundleSyncCells = nil
        dataVersion = nil
        versionAnchor = nil
        prevLocation = nil
        lastKnownLocation = lastRealLocation
        lastRealLocation = nil
        if modePreference == ActivityModePreference.auto { mode = modeDetector.current }
        TourDiagnostics.shared.log("demo_end", ["slug": drive.track.slug])
        if let loc = lastKnownLocation { Task { await locationDidUpdate(loc) } }
    }

    private var demoNextStop: DemoStop? {
        guard let drive = demo else { return nil }
        return drive.nextStop(after: drive.distanceM) { [self] in isDemoStopAvailable($0) }
    }

    /// Next during a demo: the next stop, now — the car jumps there and its
    /// story starts (from the cache, if the driver got to it first).
    func skipDemoToNextStop() {
        guard let drive = demo, isTouring else { player.stop(reason: "skip"); return }
        player.stop(reason: "skip")
        guard let next = demoNextStop else { return }
        TourDiagnostics.shared.log("demo_skip", ["stop": next.spot.spot.title, "toM": next.distanceM.rounded()])
        drive.seek(to: next.distanceM)
        if !drive.isMoving { drive.start() }
        demoIdleSince = nil
        playSpot(next.spot, role: "demo")
    }

    /// Unheard in this demo, not what is playing, narratable, and released by its sequence.
    private func isDemoStopAvailable(_ s: NearbySpot) -> Bool {
        s.spot.id != player.nowPlayingSpotId && history.playCount(s.spot.id) == 0
            && NarrationPreference.current.canNarrate(s.content) && isSequenceEligible(s.spot.id)
    }

    /// The demo's driver, once a second and at every decision: story to story
    /// along the route (`DemoRoute.step`). The scheduler still starts stops
    /// the car approaches; this makes sure every stop is reached and heard.
    private func demoDrive() {
        guard let drive = demo, isTouring, !drive.stops.isEmpty else { return }
        // The next two stops' recordings on disk before they are due, so Next is instant.
        var ahead: [NearbySpot] = []
        for stop in drive.stops where stop.distanceM >= drive.distanceM && isDemoStopAvailable(stop.spot) {
            if !ahead.contains(where: { $0.spot.id == stop.spot.spot.id }) { ahead.append(stop.spot) }
            if ahead.count == 2 { break }
        }
        let aheadIds = Set(ahead.map(\.spot.id))
        if aheadIds != demoPrefetchedIds {
            demoPrefetchedIds = aheadIds
            Task { await self.cache.cacheAudio(for: ahead, trackProgress: false) }
        }
        let t = now()
        if player.nowPlayingSpotId != nil { demoIdleSince = nil } else if demoIdleSince == nil { demoIdleSince = t }
        let next = demoNextStop
        let step = DemoRoute.step(
            item: player.nowPlayingSpotId != nil, playing: player.isPlaying, moving: drive.isMoving,
            distanceM: drive.distanceM, totalM: drive.totalM, nextM: next?.distanceM,
            idleS: demoIdleSince.map { t.timeIntervalSince($0) }, gapS: NarrationGapPreference.current.seconds,
            leadM: DemoRoute.leadM(mph: drive.mph)
        )
        switch step {
        case .none: break
        case .park: drive.pause()
        case .resume: drive.start()
        case .seek(let m):
            TourDiagnostics.shared.log("demo_jump", ["toM": m.rounded(), "stop": next?.spot.spot.title ?? ""])
            drive.seek(to: m)
            if !drive.isMoving { drive.start() }
        case .finish: drive.seek(to: drive.totalM)
        case .play: if let next { playSpot(next.spot, role: "demo") }
        }
    }

    /// Poll every 30s regardless of movement, so content published while the
    /// traveler stands still (or sits in traffic) still reaches them. Movement
    /// updates interleave with this; both share the throttle and single-flight
    /// guard, so a walking user doesn't double-fetch.
    private func startHeartbeat() {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                guard !Task.isCancelled, let self else { return }
                guard self.isTouring, !self.isExploring else { continue }
                guard let loc = self.lastKnownLocation else { continue }
                await self.refresh(at: loc)
            }
        }
    }

    func toggleTrack(_ slug: String) {
        var selection = enabledTrackSlugs
        if selection.contains(slug) { selection.remove(slug) }
        else { selection.insert(slug) }
        setEnabledTracks(selection)
    }

    func setEnabledTracks(_ slugs: Set<String>) {
        var slugs = slugs
        // A demo's own track stays on, and a demo never saves the choice.
        if let drive = demo { slugs.insert(drive.track.slug) }
        selectionRevision += 1
        selectionLoaded = true
        enabledTrackSlugs = slugs
        if demo == nil { selectionDefaults.set(slugs.sorted(), forKey: selectionKey) }
        if api.isStatic {
            bundleSyncCells = nil
            Task { await self.ensureBundlesNearby(at: self.lastKnownLocation) }
        }
        // A guided track must not keep playing after its switch is turned off.
        if let guided = tourStyle.guidedTrackSlug, slugs != Set([guided]) {
            tourStyle = .wander
        }
        let playingTrack = nearby.first { $0.spot.id == player.nowPlayingSpotId }?.track.slug
            ?? allTracks.first { $0.id == fillInItem(id: player.nowPlayingSpotId ?? "")?.trackId }?.slug
        nearby.removeAll { !slugs.contains($0.track.slug) }
        journeySpots.removeAll { !slugs.contains($0.track.slug) }
        emptyNearbyHint = nil
        wanderPlan = nil
        guidedPlan = nil
        if slugs.isEmpty || playingTrack.map({ !slugs.contains($0) }) == true { player.stop() }
        invalidateAndRefresh()
    }

    /// Filters changed, so what's in range changed: drop the cached version
    /// (its timestamp describes a different set of spots) and refetch now
    /// rather than making the traveler wait for the next heartbeat.
    func invalidateAndRefresh() {
        dataVersion = nil
        versionAnchor = nil
        lastFetchAt = .distantPast
        if case .exploring(let center) = origin {
            exploreMapCenter(center, radiusM: exploreRadiusM)
            return
        }
        guard let loc = lastKnownLocation else { return }
        Task { await refresh(at: loc) }
    }

    /// Called on each location update. Ignored while exploring elsewhere, so
    /// panning the map isn't fought by GPS. Throttles fetches to ~once per 4s
    /// and keeps them single-flight so a slow response can't be overwritten by
    /// an older one arriving out of order.
    func locationDidUpdate(_ loc: CLLocation, synthetic: Bool = false) async {
        // A demo's car is the traveler; real fixes are kept for after it ends.
        if demo != nil, !synthetic { lastRealLocation = loc; return }
        if demo == nil, synthetic { return }
        lastKnownLocation = loc
        if demo == nil, modePreference == ActivityModePreference.auto,
           let inferred = modeDetector.observe(speedMps: loc.speed, at: loc.timestamp) {
            mode = inferred // didSet refetches with the new filter
        }
        guard !isExploring else { return }
        await refresh(at: loc)
    }

    /// One nearby fetch from `loc`, shared by movement updates and the
    /// stationary heartbeat. Single-flight, so a slow response can't be
    /// overwritten by an older one arriving late.
    ///
    /// The throttle is tighter while touring (1.5s vs 4s): trigger radii are
    /// as small as 35 m, and a 4-second gap at walking pace is ~6 m of travel
    /// — enough to cross a whole trigger between polls near its edge.
    private func refresh(at loc: CLLocation) async {
        guard !activeTrackSlugs.isEmpty else { nearby = []; return }
        // GPS decisions must not wait behind a slow or unavailable server.
        // In a car, a 15-second timeout can pass an entire small trigger.
        evaluateDownloadedContent(at: loc)
        if api.isStatic {
            // No nearby route to poll: the bundles fetched for the cells around
            // here are the world, and they are evaluated on the device.
            await ensureBundlesNearby(at: loc)
            isOffline = false
            error = nil
            evaluateDownloadedContent(at: loc)
            return
        }
        let revision = selectionRevision
        let minInterval: TimeInterval = isTouring ? 1.5 : 4
        let since = now().timeIntervalSince(lastFetchAt)
        guard !isFetching, since > minInterval else {
            TourDiagnostics.shared.log("fetch_skipped", [
                "reason": isFetching ? "in_flight" : "throttled",
                "sinceLastFetchS": round(since * 100) / 100,
            ])
            return
        }
        isFetching = true
        lastFetchAt = now()
        defer {
            isFetching = false
            if revision != selectionRevision { invalidateAndRefresh() }
        }
        do {
            let course = effectiveCourse(for: loc)
            lastCourseDeg = course
            prevLocation = loc
            let res = try await api.nearby(
                lat: loc.coordinate.latitude,
                lng: loc.coordinate.longitude,
                radiusM: 2000,
                tracks: activeTrackSlugs,
                mode: mode,
                locale: LocalePreference.defaultLocale,
                trackLocales: LocalePreference.trackLocalesParam(
                    activeTracks: activeTrackSlugs, defaultLocale: LocalePreference.defaultLocale
                ),
                courseDeg: course,
                // Only a version matching this exact query point is comparable;
                // once we've moved, ask for everything again.
                changedSince: canReuseVersion(at: loc) ? dataVersion : nil
            )
            guard revision == selectionRevision else { return }
            error = nil
            // `unchanged` means "nothing new", not "nothing here" — keep the
            // spots we already have rather than blanking the map.
            guard !res.unchanged else {
                TourDiagnostics.shared.log("fetch_unchanged", ["hAcc": loc.horizontalAccuracy])
                // `unchanged` means the *content* didn't change — we may still
                // have moved across a trigger boundary (radii go down to 35 m,
                // well inside the 100 m version window), so triggers must be
                // re-evaluated from the geometry we already hold.
                isOffline = false
                retriggerLocally(at: lastKnownLocation ?? loc)
                return
            }
            dataVersion = res.dataVersion
            versionAnchor = loc
            nearby = TriggerEvaluator.reevaluate(res.spots, at: lastKnownLocation ?? loc)
            isOffline = false
            if res.spots.isEmpty { explainEmptyNearby(at: loc) } else { emptyNearbyHint = nil }
            self.cache.absorb(res.spots)
            // Rolling prefetch: pull narration + locating audio for everything
            // in range while touring, so spots play from disk at trigger time.
            // Streaming at trigger is what made narration stutter and start
            // silent on field drives.
            if isTouring {
                Task { await self.cache.cacheAudio(for: res.spots, trackProgress: false) }
            }
            let trig = res.spots.filter(\.triggered)
            TourDiagnostics.shared.log("fetch_ok", [
                "spots": res.spots.count,
                "triggered": trig.count,
                "triggeredTitles": trig.map(\.spot.title),
                "hAcc": loc.horizontalAccuracy,
                // The filters this poll ran under: 0 spots with the wrong
                // mode or a lone corridor track is a config problem, not GPS.
                "mode": mode,
                "tracks": activeTrackSlugs,
                // The nearest spot regardless of trigger: if this is small but
                // `triggered` is 0, the radius or GPS error is the problem.
                "nearestM": res.spots.first.map { round($0.distanceM) } ?? -1,
                "nearestTitle": res.spots.first?.spot.title ?? "",
                "nearestRadiusM": res.spots.first?.spot.trigger.radiusM ?? -1,
                "nearestHasAudio": res.spots.first?.content?.audioUrl != nil,
                "nearestNarratable": res.spots.first?.isNarratable ?? false,
            ])
            decideNext()
        } catch {
            guard revision == selectionRevision else { return }
            TourDiagnostics.shared.log("fetch_failed", ["error": error.localizedDescription])
            // Server unreachable: fall back to the offline cache so the tour
            // keeps working. Triggers are evaluated on-device; locating clips
            // are omitted (no server to resolve the side).
            let cached = self.cache.offlineNearby(
                at: lastKnownLocation ?? loc,
                radiusM: 2000,
                trackSlugs: Set(activeTrackSlugs),
                mode: mode
            )
            // A fix that lands before the catalog load has classified the
            // server can hit a static host's missing API: the server answered
            // 404, which is not an outage — classify it and let the next poll
            // take the static path. Anything else (timeouts, refused, 5xx) is.
            var outage = true
            if api.kind == nil, case GrandTourAPIError.noSuchRoute? = error as? GrandTourAPIError {
                outage = false
                Task { await self.api.probe() }
            }
            if cached.isEmpty {
                nearby = []
                if outage { isOffline = true }
                self.error = "Nearby fetch failed: \(error.localizedDescription)"
                // Still give the decision its turn: a long dead stretch with
                // no server and no cache (a freeway in the middle of nowhere)
                // is exactly when a fill-in is most welcome — the items
                // themselves were cached at tour start.
                decideNext()
                return
            }
            if outage { isOffline = true }
            self.error = nil
            // The cached version describes the server's world, not ours.
            dataVersion = nil
            versionAnchor = nil
            nearby = cached
            TourDiagnostics.shared.log("offline_fallback", [
                "spots": cached.count,
                "triggered": cached.filter(\.triggered).count,
            ])
            decideNext()
        }
    }

    private func evaluateDownloadedContent(at loc: CLLocation) {
        guard !isExploring else { return }
        lastCourseDeg = effectiveCourse(for: loc)
        guard isOffline || cache.hasDownloadedTracks(trackSlugs: Set(activeTrackSlugs)) else {
            // Even without a pinned offline tour, the current server snapshot
            // can be evaluated on every GPS fix. A slow in-flight request must
            // not hold a locally known arrival behind the network throttle.
            nearby = TriggerEvaluator.reevaluate(nearby, at: loc)
            decideNext()
            return
        }
        nearby = cache.offlineNearby(
            at: loc, radiusM: 2000, trackSlugs: Set(activeTrackSlugs), mode: mode
        )
        // A local reconstruction is not the server response identified by
        // dataVersion. Ask for a full refresh when connectivity returns.
        dataVersion = nil
        versionAnchor = nil
        decideNext()
    }

    /// Recompute `triggered` and distance for the kept nearby list from the
    /// current location — the same on-device evaluation the offline path uses.
    /// Locating is kept as last resolved; a course-specific side can go stale,
    /// but that beats dropping "where to look" for everyone standing still.
    private func retriggerLocally(at loc: CLLocation) {
        guard isTouring else {
            // Browsing: nothing auto-plays, but the decision still gets its
            // turn (a no-op beyond logging while the tour is off).
            decideNext()
            return
        }
        nearby = TriggerEvaluator.reevaluate(nearby, at: loc)
        decideNext()
    }

    /// A cached `dataVersion` is only valid for the point it was fetched from.
    /// Moving more than 100m can bring different spots into range whose
    /// timestamps are older, so the version check would wrongly say "unchanged".
    private func canReuseVersion(at loc: CLLocation) -> Bool {
        guard let anchor = versionAnchor, dataVersion != nil else { return false }
        return loc.distance(from: anchor) < 100
    }

    private func applyModePreference() {
        mode = modePreference == ActivityModePreference.auto ? modeDetector.current : modePreference
    }

    /// After an empty poll: one probe of the same point with the mode filter
    /// off (same tracks), and if that's empty too, one with the track filter
    /// off. Rate-limited to every 20s while the list stays empty. The result
    /// only feeds `emptyNearbyHint`; nothing here plays or schedules.
    private func explainEmptyNearby(at loc: CLLocation) {
        guard now().timeIntervalSince(lastEmptyProbeAt) > 20 else { return }
        lastEmptyProbeAt = now()
        let revision = selectionRevision
        let active = activeTrackSlugs
        let modeNow = mode
        Task { [weak self] in
            guard let self else { return }
            do {
                let sameTracks: [NearbySpot]
                var anyTrack: [NearbySpot] = []
                if self.api.isStatic {
                    // The same two probes, over the fetched bundles.
                    sameTracks = self.cache.offlineNearby(at: loc, radiusM: 2000, trackSlugs: Set(active), mode: nil)
                    if sameTracks.isEmpty {
                        anyTrack = self.cache.offlineNearby(at: loc, radiusM: 2000, trackSlugs: [], mode: nil)
                    }
                } else {
                    sameTracks = try await self.api.nearby(
                        lat: loc.coordinate.latitude, lng: loc.coordinate.longitude,
                        radiusM: 2000, tracks: active, mode: nil, courseDeg: nil
                    ).spots
                    if sameTracks.isEmpty {
                        anyTrack = try await self.api.nearby(
                            lat: loc.coordinate.latitude, lng: loc.coordinate.longitude,
                            radiusM: 2000, tracks: [], mode: nil, courseDeg: nil
                        ).spots
                    }
                }
                guard revision == self.selectionRevision, self.nearby.isEmpty else { return }
                let hint = Self.emptyHint(
                    sameTracks: sameTracks, anyTrack: anyTrack, activeTracks: active,
                    mode: modeNow, allTracks: self.allTracks
                )
                self.emptyNearbyHint = hint
                TourDiagnostics.shared.log("empty_nearby_probe", [
                    "hiddenByMode": sameTracks.count, "onOtherTracks": anyTrack.count,
                    "mode": modeNow, "tracks": active, "hint": hint,
                ])
            } catch {
                // The main poll's own error is already on screen.
            }
        }
    }

    /// The sentence shown under an empty list. `sameTracks` is what the
    /// active tracks hold here with the mode filter off; `anyTrack` is what
    /// every track holds here (only fetched when `sameTracks` is empty).
    static func emptyHint(
        sameTracks: [NearbySpot], anyTrack: [NearbySpot], activeTracks: [String],
        mode: String, allTracks: [Track]
    ) -> String {
        func name(_ slug: String) -> String { allTracks.first { $0.slug == slug }?.name ?? slug }
        let modeLabel = mode.capitalized
        if !sameTracks.isEmpty {
            // Which mode would show the most of them — the one to suggest.
            var tally: [String: Int] = [:]
            for s in sameTracks { for m in s.spot.modes { tally[m, default: 0] += 1 } }
            let best = tally.max { $0.value < $1.value }?.key.capitalized ?? "Auto"
            let n = sameTracks.count
            return "\(n) \(n == 1 ? "story" : "stories") within 2 km \(n == 1 ? "is" : "are") hidden by \(modeLabel) mode. Switch the activity mode to \(best) or Auto."
        }
        let mine = activeTracks.map(name).sorted().joined(separator: ", ")
        if !anyTrack.isEmpty {
            var counts: [String: Int] = [:]
            for s in anyTrack { counts[s.track.slug, default: 0] += 1 }
            let top = counts.sorted { $0.value > $1.value }.prefix(3).map { name($0.key) }
            return "No \(mine) stories within 2 km. \(anyTrack.count) on other tracks — turn on \(top.joined(separator: ", ")) in Tracks."
        }
        return "No stories within 2 km on any track (\(mine) enabled, \(modeLabel) mode)."
    }

    /// Browse stories around an arbitrary map center. No course is sent (the
    /// traveler isn't there, so a guessed left/right would be wrong) and
    /// nothing auto-plays — remote spots are listened to on demand.
    /// `radiusM` should cover the visible map span; it's clamped to the
    /// server's 50 km cap.
    func exploreMapCenter(_ center: CLLocationCoordinate2D, radiusM: Double) {
        origin = .exploring(center)
        exploreRadiusM = radiusM
        exploreTask?.cancel()
        exploreTask = Task { [weak self] in
            // Coalesce rapid pans into one request.
            try? await Task.sleep(for: .milliseconds(350))
            guard !Task.isCancelled, let self else { return }
            await self.fetchExplore(center: center, radiusM: radiusM)
        }
        armExploreExpiry()
    }

    /// Explore mode must not outlive the traveler's attention. Exiting used to
    /// require a later map gesture landing near the user — pan ahead on a ride,
    /// pocket the phone, and the tour silently never polls again (that froze a
    /// whole San Anselmo ride). While touring, each explore gesture buys 30
    /// seconds; when they lapse with nothing playing, snap back to `.here`.
    /// A tour that's switched off keeps explore mode as long as it likes.
    private func armExploreExpiry() {
        exploreExpiryTask?.cancel()
        exploreExpiryTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(30))
            guard !Task.isCancelled, let self else { return }
            guard self.isTouring, self.isExploring else { return }
            // Listening to a browsed spot counts as activity — wait out the
            // narration rather than yanking the map from under it.
            guard self.player.nowPlayingSpotId == nil else {
                self.armExploreExpiry()
                return
            }
            TourDiagnostics.shared.log("explore_expired")
            self.returnToHere(self.lastKnownLocation)
        }
    }

    private func fetchExplore(center: CLLocationCoordinate2D, radiusM: Double) async {
        guard !enabledTrackSlugs.isEmpty else { nearby = []; return }
        let revision = selectionRevision
        isLoading = true
        defer { isLoading = false }
        if api.isStatic {
            // Browsing a static server: the fetched bundles, every mode.
            nearby = cache.offlineNearby(
                at: CLLocation(latitude: center.latitude, longitude: center.longitude),
                radiusM: min(max(radiusM, 500), 50_000), trackSlugs: enabledTrackSlugs, mode: nil
            )
            error = nil
            return
        }
        do {
            // No `changedSince`: this is a different query point than the tour
            // polls, so a cached version wouldn't describe it.
            let res = try await api.nearby(
                lat: center.latitude,
                lng: center.longitude,
                radiusM: min(max(radiusM, 500), 50_000),
                tracks: Array(enabledTrackSlugs),
                mode: nil, // browsing shows every spot, not just this-mode ones
                locale: LocalePreference.defaultLocale,
                trackLocales: LocalePreference.trackLocalesParam(
                    activeTracks: Array(enabledTrackSlugs), defaultLocale: LocalePreference.defaultLocale
                ),
                courseDeg: nil
            )
            guard !Task.isCancelled, revision == selectionRevision else { return }
            nearby = res.spots
            error = nil
        } catch {
            guard !Task.isCancelled else { return }
            self.error = "Nearby fetch failed: \(error.localizedDescription)"
        }
    }

    /// Return to following the user's own position; the next location update
    /// refreshes the list.
    func returnToHere(_ loc: CLLocation?) {
        exploreTask?.cancel()
        exploreExpiryTask?.cancel()
        origin = .here
        lastFetchAt = .distantPast
        // The explore fetch overwrote `nearby` from a different point, so the
        // cached version no longer describes what we hold.
        dataVersion = nil
        versionAnchor = nil
        guard let loc else { return }
        Task { await locationDidUpdate(loc) }
    }

    /// Direction of travel: GPS course when valid, else derived from movement
    /// history (bearing from the previous poll's position, if we've moved).
    private func effectiveCourse(for loc: CLLocation) -> Double? {
        if loc.course >= 0 { return loc.course }
        guard let prev = prevLocation, loc.distance(from: prev) > 15 else { return nil }
        let lat1 = prev.coordinate.latitude * .pi / 180
        let lat2 = loc.coordinate.latitude * .pi / 180
        let dLon = (loc.coordinate.longitude - prev.coordinate.longitude) * .pi / 180
        let y = sin(dLon) * cos(lat2)
        let x = cos(lat1) * sin(lat2) - sin(lat1) * cos(lat2) * cos(dLon)
        let deg = atan2(y, x) * 180 / .pi
        return (deg + 360).truncatingRemainder(dividingBy: 360)
    }

    // ─── The decision point ──────────────────────────────────────────────────

    /// Decide what the tour is heading for and, if the player is idle, what
    /// to start. Runs on every poll and whenever narration ends. Nothing is
    /// truncated, nothing overlaps: a start only ever happens against an
    /// idle player; while something plays, the decision merely re-aims
    /// "up next" at where the traveler will be when it ends.
    func decideNext() {
        guard isTouring, !isExploring, AudioSession.canPlay else { return }
        if let drive = demo, drive.atEnd, player.nowPlayingSpotId == nil {
            // The route is driven and the last story has ended: the demo's
            // tour stops itself, and Start tour drives it again.
            TourDiagnostics.shared.log("demo_finished", ["slug": drive.track.slug])
            stopTour()
            return
        }
        if demo != nil { demoDrive() }
        switch tourStyle {
        case .wander: decideWander()
        case .guided(let slug): decideGuided(trackSlug: slug)
        }
    }

    /// Reconsider current location when the pause expires; never reserve a
    /// story that may be out of range by then. GPS updates use this same gate.
    private func automaticNarrationMayStart() -> Bool {
        let remaining = narrationGap.remaining(at: now(), seconds: NarrationGapPreference.current.seconds)
        narrationGapTask?.cancel()
        narrationGapTask = nil
        guard remaining > 0 else { return true }
        narrationGapTask = Task { @MainActor [weak self] in
            do { try await Task.sleep(for: .seconds(remaining)) } catch { return }
            self?.decideNext()
        }
        return false
    }

    /// Wander: the scheduler names the target (up next) and, when idle, the
    /// spot to start now — the target once its window opens, else a filler
    /// that fits before it. Otherwise the gap planner gets whatever time is
    /// left before the target, and no more.
    private func decideWander() {
        let plan = scheduler.plan(nearby: nearby.filter { NarrationPreference.current.canNarrate($0.content) }, ctx: schedulerContext)
        wanderPlan = plan
        guard player.nowPlayingSpotId == nil, automaticNarrationMayStart() else { return }
        if let s = plan.playNow {
            playSpot(s, role: s.spot.id == plan.target?.spot.id ? "target" : "filler")
            return
        }
        maybePlayGapContent(budgetS: plan.gapBudgetS, allowFillIns: true)
    }

    /// Guided walking tour: pick the next stop, narrate it on arrival, and
    /// between stops speak directions — once when a stop becomes next, again
    /// if the traveler walks away from it, and a periodic reminder.
    private func decideGuided(trackSlug: String) {
        seedGuidedVisitedIfNeeded(trackSlug: trackSlug)
        let stops = nearby.filter { $0.track.slug == trackSlug && NarrationPreference.current.canNarrate($0.content) }
        let plan = GuidedTourPlanner.plan(
            stops: stops,
            visited: guidedVisited,
            location: lastKnownLocation,
            courseDeg: lastCourseDeg,
            isEligible: { [weak self] in self?.isSequenceEligible($0) ?? true },
            metric: Locale.current.measurementSystem == .metric
        )
        guidedPlan = plan
        guard player.nowPlayingSpotId == nil, automaticNarrationMayStart() else { return }
        guard let stop = plan.nextStop else {
            let finished = isGuidedTourFinished(trackSlug: trackSlug, inRange: stops)
            if finished, !guidedFinishedAnnounced {
                guidedFinishedAnnounced = true
                TourDiagnostics.shared.log("guided_finished", ["track": trackSlug])
                speakCue("That's the end of the tour.", id: "cue:finished")
            } else if !finished {
                // An area chapter may be the prerequisite for all remaining
                // point stops, or the final unheard unit of the tour.
                maybePlayGapContent(budgetS: nil, allowFillIns: false)
            }
            return
        }
        if plan.arrived {
            guidedCue = nil
            playSpot(stop, role: "stop")
            return
        }
        if let dist = plan.distanceM, shouldCue(stop: stop, distanceM: dist) {
            guidedCue = (stop.spot.id, dist, now())
            TourDiagnostics.shared.log("guided_cue", [
                "title": stop.spot.title,
                "distanceM": dist.rounded(),
                "directions": plan.directions ?? "",
            ])
            speakCue(GuidedTourPlanner.cue(for: stop, directions: plan.directions), id: "cue:\(stop.spot.id)")
            return
        }
        // Between stops the track's own ambient (area) stories may play; a
        // walking tour never gets generic fill-ins.
        maybePlayGapContent(budgetS: nil, allowFillIns: false)
    }

    /// Stops heard within the cooldown count as visited when the guided
    /// session begins — reopening the app halfway through a walk shouldn't
    /// send the traveler back to stop one.
    private func seedGuidedVisitedIfNeeded(trackSlug: String) {
        guard !guidedSeeded, !nearby.isEmpty else { return }
        guidedSeeded = true
        let ids = (manifests[trackSlug]?.units.map(\.id)) ?? nearby.filter { $0.track.slug == trackSlug }.map(\.spot.id)
        for id in ids where history.playedWithin(SpotScheduler.replayCooldownS, spotId: id, now: now()) {
            guidedVisited.insert(id)
        }
    }

    /// Every stop of the track is visited — by the manifest when we have it
    /// (stops beyond the 2 km window count too), else by what's in range.
    private func isGuidedTourFinished(trackSlug: String, inRange: [NearbySpot]) -> Bool {
        if let m = manifests[trackSlug], !m.units.isEmpty {
            return m.units.allSatisfy { guidedVisited.contains($0.id) }
        }
        let pointStops = inRange.filter { !$0.spot.trigger.isArea && $0.isNarratable }
        return !pointStops.isEmpty && pointStops.allSatisfy { guidedVisited.contains($0.spot.id) }
    }

    /// Speak directions now? First time this stop is next; when the
    /// traveler has drifted away from it since the last cue; or as a
    /// reminder every couple of minutes while it's still a walk away.
    private func shouldCue(stop: NearbySpot, distanceM: Double) -> Bool {
        guard let cue = guidedCue, cue.stopId == stop.spot.id else { return true }
        if GuidedTourPlanner.isHeadingAway(distanceM: distanceM, sinceCueM: cue.distanceM) { return true }
        return distanceM > GuidedTourPlanner.noReminderWithinM
            && now().timeIntervalSince(cue.at) >= GuidedTourPlanner.reminderIntervalS
    }

    /// One short on-device line ("Next stop: …"). Occupies the player like
    /// narration — nothing overlaps — but only for a few seconds.
    private func speakCue(_ text: String, id: String) {
        narrationStartedAt = now()
        narrationDurationS = NarrationDuration.seconds(forText: text)
        player.speakCue(text, id: id)
    }

    /// No spot is startable right now, so the gap planner takes over —
    /// within `budgetS`, the time before the target's start window opens
    /// (nil = unbounded). Priority inside a gap: an ambient area spot
    /// covering the current position (place-relevant beats generic — that
    /// ordering is the point of area triggers), then a fill-in item, then
    /// silence. One piece per gap window; playing re-arms the clock.
    private func maybePlayGapContent(budgetS: TimeInterval?, allowFillIns: Bool) {
        let quietS = now().timeIntervalSince(lastTourNarrationAt)
        // The common completion-gap gate already ran. Initial idle needs no
        // extra delay, and a long first candidate must not hide a shorter fit.
        if let ambient = pickAmbientSpot(budgetS: budgetS) {
            TourDiagnostics.shared.log("ambient_play", [
                "title": ambient.spot.title,
                "track": ambient.track.slug,
                "quietS": quietS.rounded(),
            ])
            playSpot(ambient, role: "ambient")
            return
        }
        guard allowFillIns else { return }
        maybePlayFillIn(quietS: quietS, budgetS: budgetS)
    }

    /// Vocab/quiz modules add think-time pauses beyond their text.
    static let fillInBeatsPaddingS: TimeInterval = 6

    /// The ambient candidate for this gap: area spots whose fence contains
    /// the traveler right now, narratable, sequence-eligible, and not
    /// replay-blocked (series: ever heard; evergreen: the same cooldown point
    /// spots use). Unheard first, then longest-forgotten, then the most
    /// specific fence — a neighborhood collection beats a county-wide one.
    func pickAmbientSpot(budgetS: TimeInterval?) -> NearbySpot? {
        let candidates = nearby.filter { s in
            s.spot.trigger.isArea && s.triggered && NarrationPreference.current.canNarrate(s.content)
                && isSequenceEligible(s.spot.id)
                && !(seriesUnitIds.contains(s.spot.id) && history.playCount(s.spot.id) > 0)
                && !history.playedWithin(SpotScheduler.replayCooldownS, spotId: s.spot.id, now: now())
                && scheduler.fits(duration: NarrationDuration.seconds(for: s), budget: budgetS)
        }
        return candidates.min { a, b in
            let pa = history.playCount(a.spot.id) == 0 ? 0 : 1
            let pb = history.playCount(b.spot.id) == 0 ? 0 : 1
            if pa != pb { return pa < pb }
            let la = history.lastPlayedAt(a.spot.id) ?? .distantPast
            let lb = history.lastPlayedAt(b.spot.id) ?? .distantPast
            if la != lb { return la < lb }
            return TriggerEvaluator.approxAreaM2(ring: a.spot.trigger.region)
                < TriggerEvaluator.approxAreaM2(ring: b.spot.trigger.region)
        }
    }

    /// Round-robin across enabled fill-in tracks — the least-recently-played
    /// track supplies the next item, so vocab and a quiz track alternate
    /// instead of coin-flipping (plans/014, decision 6 as amended
    /// 2026-08-30). Within the chosen track the item is a random unplayed
    /// one; when everything enabled has played once this session, the dedup
    /// clears and the rotation starts over.
    private func pickFillInItem() -> FillInItem? {
        let enabledTrackIds = Set(
            allTracks.filter { $0.isFillIn && enabledTrackSlugs.contains($0.slug) }.map(\.id)
        )
        let candidates = fillInItems.filter {
            $0.isNarratable && NarrationPreference.current.canNarrate($0.content) && enabledTrackIds.contains($0.trackId)
                // Series items are heard-once, across sessions — they drop out
                // of the rotation for good (until a "start over").
                && !(seriesUnitIds.contains($0.id) && history.playCount($0.id) > 0)
        }
        guard !candidates.isEmpty else { return nil }
        var unplayed = candidates.filter { !playedFillInIds.contains($0.id) }
        if unplayed.isEmpty {
            playedFillInIds.removeAll()
            unplayed = candidates
        }
        let byTrack = Dictionary(grouping: unplayed, by: \.trackId)
        // Never-played tracks go first (.distantPast); the id tie-break only
        // matters for those, and keeps the choice stable within a session.
        let trackId = byTrack.keys.min { a, b in
            let ta = fillInTrackLastPlayedAt[a] ?? .distantPast
            let tb = fillInTrackLastPlayedAt[b] ?? .distantPast
            return ta == tb ? a < b : ta < tb
        }
        guard let trackId, let item = byTrack[trackId]?.randomElement() else { return nil }
        fillInTrackLastPlayedAt[trackId] = now()
        return item
    }

    /// Start one chosen spot. `role` says why it won, for the field log:
    /// the wander target, a filler that fit before it, a guided stop, or an
    /// ambient area story. The honesty checks (ahead, eligible) already ran
    /// in the planner.
    private func playSpot(_ s: NearbySpot, role: String) {
        guard let content = s.content, NarrationPreference.current.canNarrate(content) else { return }
        // No "where to look" for an area spot — the traveler is inside it.
        let intro = s.spot.trigger.isArea || !NarrationPreference.current.allowsDeviceSpeech
            ? nil : locatorIntro(for: s)
        lastTourNarrationAt = now() // real narration re-arms the gap clock
        narrationStartedAt = now()
        narrationDurationS = NarrationDuration.seconds(for: s)
        history.recordPlay(spotId: s.spot.id, at: now())
        if tourStyle.isGuided { guidedVisited.insert(s.spot.id) }
        updateCompletion(forTrackId: s.spot.trackId)
        let ctx = schedulerContext
        let rank = scheduler.trackRank(s, ctx: ctx)
        TourDiagnostics.shared.log("play_start", [
            "title": s.spot.title,
            "role": role,
            "distanceM": round(scheduler.distanceM(s, from: lastKnownLocation?.coordinate)),
            "alongM": scheduler.alongCourseM(s, ctx: ctx).map { $0.rounded() } ?? -1,
            "stillInside": s.triggered,
            "expectedS": narrationDurationS.rounded(),
            "trackRank": rank == Int.max ? -1 : rank,
            "playCount": history.playCount(s.spot.id),
            "locator": intro ?? "(none)",
        ])
        player.play(
            content: content,
            spotId: s.spot.id,
            // Fresh spoken locator beats the canned clip; the clip is the
            // fallback when we have no fix to compute from. Area spots get
            // neither (the server already resolves their locating to nil).
            locating: intro == nil && s.triggered && !s.spot.trigger.isArea ? s.locating : nil,
            intro: intro
        )
    }

    /// The fill-in half of the gap decision: narration has been silent past
    /// the user's threshold, play one item — else choose silence. Only ever
    /// reached from `maybePlayGapContent` (player idle, candidate pool empty,
    /// no triggered point spot, no ambient winner). No preemption in either
    /// direction (plans/014, decision 5): a real spot entered mid-item waits
    /// for the next decision point.
    private func maybePlayFillIn(quietS: TimeInterval, budgetS: TimeInterval?) {
        guard let threshold = fillInGapThreshold else { return } // setting: off
        guard quietS >= threshold else { return }
        guard let item = pickFillInItem(), let content = item.content else { return }
        // An item that would still be talking when the next spot's window
        // opens costs an unheard story; fill-ins never do that.
        let expectedS = NarrationDuration.seconds(for: content) + Self.fillInBeatsPaddingS
        guard scheduler.fits(duration: expectedS, budget: budgetS) else {
            TourDiagnostics.shared.log("fillin_skipped", [
                "reason": "no_room", "expectedS": expectedS.rounded(),
                "budgetS": budgetS.map { $0.rounded() } ?? -1,
            ])
            return
        }
        // Re-arm before playing: one item per gap window, not a stream.
        lastTourNarrationAt = now()
        narrationStartedAt = now()
        narrationDurationS = expectedS
        playedFillInIds.insert(item.id)
        // Cross-session memory too: series fill-in packs exhaust ("they go
        // away"), and completing one auto-disables its track.
        history.recordPlay(spotId: item.id, at: now())
        updateCompletion(forTrackId: item.trackId)
        TourDiagnostics.shared.log("fillin_play", [
            "title": item.payload.displayTitle,
            "itemId": item.id,
            "hasAudio": content.audioUrl != nil,
        ])
        // Structured modules speak from the payload when they go on-device —
        // real pauses between beats, not one breathless utterance. Unknown
        // payloads fall back to the content document's flat text.
        let segments: [SpokenSegment]?
        switch item.payload {
        case .vocab(let p): segments = VocabSpeech.beats(for: p)
        case .quiz(let p): segments = QuizSpeech.beats(for: p)
        case .unknown: segments = nil
        }
        player.play(content: content, spotId: item.id, locating: nil, intro: nil, deviceSegments: segments)
    }

    /// Fired ~8s before recorded narration ends: refresh the nearby snapshot
    /// (bypassing the poll throttle) so the decision runs on a fresh fix, and
    /// pre-warm the likely winner's audio so it starts gaplessly. Purely an
    /// optimization — the end-of-narration decision works without it, and
    /// on-device speech (which has no duration) never fires it.
    private func prepareForDecision() {
        guard isTouring, !isExploring else { return }
        lastFetchAt = .distantPast
        if let loc = lastKnownLocation {
            Task { await self.refresh(at: loc) }
        }
        if let likely = upNext {
            Task { await self.cache.cacheAudio(for: [likely], trackProgress: false) }
        }
    }

    /// The play-time locator sentence: computed from the freshest fix and
    /// course at the moment narration starts, so it's honest even when the
    /// story waited in the queue. Nil without a fix (locator would be a guess).
    private func locatorIntro(for s: NearbySpot) -> String? {
        guard let loc = lastKnownLocation else { return nil }
        return SpotLocator.describe(
            spotLat: s.spot.trigger.center.lat,
            spotLng: s.spot.trigger.center.lng,
            userLat: loc.coordinate.latitude,
            userLng: loc.coordinate.longitude,
            courseDeg: lastCourseDeg,
            anchor: s.spot.locating?.anchor,
            metric: Locale.current.measurementSystem == .metric
        )
    }

    func playManually(_ s: NearbySpot) {
        guard let content = s.content, NarrationPreference.current.canNarrate(content) else { return }
        guard AudioSession.takeOver(userInitiated: true) else { return }
        // Manual listening is still listening — the gap clock resets, and
        // the play counts toward history (so auto-play won't repeat it soon).
        // The cooldown never blocks a manual tap, only auto-play.
        lastTourNarrationAt = now()
        narrationStartedAt = now()
        narrationDurationS = NarrationDuration.seconds(for: s)
        history.recordPlay(spotId: s.spot.id, at: now())
        if tourStyle.isGuided { guidedVisited.insert(s.spot.id) }
        // Asking for the last unheard story by hand still finishes the series.
        updateCompletion(forTrackId: s.spot.trackId)
        // Exploring from afar: any locator ("back 500 feet…") would describe
        // a place the user isn't near, so play the narration alone. Area
        // spots have no locator either way.
        let intro = isExploring || s.spot.trigger.isArea || !NarrationPreference.current.allowsDeviceSpeech
            ? nil : locatorIntro(for: s)
        player.play(
            content: content,
            spotId: s.spot.id,
            locating: intro == nil && !isExploring && !s.spot.trigger.isArea ? s.locating : nil,
            intro: intro
        )
    }
}
