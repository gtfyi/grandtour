import Foundation
import CoreLocation
import Combine
import HealthKit
import WatchKit

/// The watch's tour loop — a smaller analog of the phone's TourViewModel.
/// Same decision core (SpotScheduler, wander style), same play-history rules,
/// different economics: network polls are throttled hard (PollPolicy: 10s
/// moving / 60s stationary vs the phone's 1.5s), and every GPS fix instead
/// re-evaluates triggers locally over the held nearby list, so 35 m radii
/// are still caught at fix cadence without a fetch.
@MainActor
final class WatchTourEngine: ObservableObject {
    @Published var nearby: [NearbySpot] = []
    @Published var allTracks: [Track] = []
    @Published var enabledTrackSlugs: Set<String> = [] {
        didSet { UserDefaults.standard.set(Array(enabledTrackSlugs), forKey: Self.tracksKey) }
    }
    @Published var mode: String = "walking"
    @Published var error: String?
    @Published private(set) var isTouring = false
    /// Long-form activation failed at tour start: no Bluetooth headphones.
    @Published private(set) var needsHeadphones = false

    let player = WatchAudioPlayer()
    let workout = WorkoutKeeper()

    private static let tracksKey = "watchEnabledTracks"

    private let api = GrandTourAPI()
    private let scheduler = SpotScheduler()
    private var eligibility = PlaybackEligibility()
    private var lastFetchAt: Date = .distantPast
    private var isFetching = false
    private var dataVersion: String?
    private var versionAnchor: CLLocation?
    private var lastKnownLocation: CLLocation?
    private var prevLocation: CLLocation?
    private var lastCourseDeg: Double?
    private var pollTask: Task<Void, Never>?
    private var cancellables: Set<AnyCancellable> = []
    /// The latest decision: its target is the root screen's "up next".
    @Published private(set) var plan: SpotScheduler.Plan?
    /// When the current narration started and how long it should run — the
    /// scheduler predicts across the remainder.
    private var narrationStartedAt: Date?
    private var narrationDurationS: TimeInterval = 0
    private var narrationGap = NarrationGap()
    private var narrationGapTask: Task<Void, Never>?

    init() {
        enabledTrackSlugs = Set(UserDefaults.standard.stringArray(forKey: Self.tracksKey) ?? [])
        NotificationCenter.default.publisher(for: ServerPreference.didChange)
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in
                Task { await self?.serverDidChange() }
            }
            .store(in: &cancellables)
        // When narration ends, decide what's next — only ever against an
        // idle player; nothing preempts, nothing overlaps.
        player.$nowPlayingSpotId
            .removeDuplicates()
            .sink { [weak self] id in
                guard let self else { return }
                _ = self.narrationGap.observe(id, at: Date())
                guard id == nil else { return }
                Task { @MainActor [weak self] in self?.decideNext() }
            }
            .store(in: &cancellables)
        player.onApproachingEnd = { [weak self] in
            self?.prepareForDecision()
        }
        // Headphones dropped mid-tour: surface it instead of silently
        // burning through candidates.
        player.$routeUnavailable
            .removeDuplicates()
            .sink { [weak self] unavailable in
                if unavailable { self?.needsHeadphones = true }
            }
            .store(in: &cancellables)
    }

    func loadTracks() async {
        do {
            allTracks = try await api.tracks()
            error = nil
        } catch {
            self.error = "Could not load tracks: \(error.localizedDescription)"
        }
        await loadManifests()
        if enabledTrackSlugs.isEmpty {
            // Fill-in tracks stay off: the watch has no gap planner (yet).
            enabledTrackSlugs = Set(allTracks.filter { !$0.isFillIn }.map(\.slug))
        }
    }

    /// Cache the small whole-track indexes by server so offline restarts
    /// retain the same chapter gates and heard-once rules as online playback.
    private func loadManifests() async {
        let key = "watchTrackManifests:\(api.baseURL.absoluteString)"
        let manifests: [TrackManifest]
        do {
            manifests = try await api.trackManifests()
            if let data = try? JSONEncoder().encode(manifests) {
                UserDefaults.standard.set(data, forKey: key)
            }
        } catch {
            manifests = UserDefaults.standard.data(forKey: key).flatMap {
                try? JSONDecoder().decode([TrackManifest].self, from: $0)
            } ?? []
        }
        eligibility = PlaybackEligibility(manifests: manifests)
    }

    /// The active server changed: everything fetched from the old one is
    /// stale, including the persisted enabled-track set (slugs differ).
    func serverDidChange() async {
        stopTour()
        nearby = []
        allTracks = []
        eligibility = PlaybackEligibility()
        enabledTrackSlugs = []
        dataVersion = nil
        versionAnchor = nil
        lastFetchAt = .distantPast
        error = nil
        await loadTracks()
    }

    // ─── Tour on/off ─────────────────────────────────────────────────────────

    /// Turn the tour ON. Async and fallible on the watch: long-form audio
    /// activation happens here — while the traveler is looking at the screen
    /// and can answer the route picker — not at first trigger with the wrist
    /// down. Returns false (and doesn't start) when no headphone route was
    /// established.
    func startTour(at loc: CLLocation?, skipWorkout: Bool = false) async -> Bool {
        guard !isTouring else { return true }
        let ok = await WatchAudioSession.takeOver()
        needsHeadphones = !ok
        guard ok else { return false }

        // Workout session = background runtime + GPS with the wrist down.
        // Attached concurrently: the tour must not hang on the HealthKit
        // prompt, and a declined prompt degrades to foreground-only rather
        // than blocking the tour outright.
        if !skipWorkout {
            Task { [weak self] in
                guard let self else { return }
                if await self.workout.requestAuthorization() {
                    // The prompt may outlive the tour; don't start a
                    // workout for one that's already off.
                    guard self.isTouring else { return }
                    self.workout.start(activity: Self.workoutActivity(for: self.mode))
                }
            }
        }

        isTouring = true
        // Start clean: a version cached while browsing would make the first
        // poll come back `unchanged` with stale triggered flags.
        dataVersion = nil
        versionAnchor = nil
        lastFetchAt = .distantPast
        lastKnownLocation = loc ?? lastKnownLocation
        startHeartbeat()
        if let loc { await locationDidUpdate(loc) }
        return true
    }

    func stopTour() {
        guard isTouring else { return }
        isTouring = false
        narrationGapTask?.cancel()
        narrationGapTask = nil
        pollTask?.cancel()
        pollTask = nil
        plan = nil
        player.stop()
        workout.stop()
    }

    static func workoutActivity(for mode: String) -> HKWorkoutActivityType {
        switch mode {
        case "cycling": .cycling
        case "hiking": .hiking
        default: .walking
        }
    }

    // ─── The loop ────────────────────────────────────────────────────────────

    /// Heartbeat: a slow tick whose fetches PollPolicy gates. Keeps content
    /// flowing to a stationary traveler (60s) without waking the radio at
    /// the phone's cadence.
    private func startHeartbeat() {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(10))
                guard !Task.isCancelled, let self else { return }
                guard self.isTouring, let loc = self.lastKnownLocation else { continue }
                await self.refreshIfDue(at: loc)
            }
        }
    }

    /// Called on each GPS fix. Local trigger math runs every time while
    /// touring; the network is asked only when PollPolicy says it's due —
    /// touring or not, so the idle screen's "nearest story" line has
    /// something to show.
    func locationDidUpdate(_ loc: CLLocation) async {
        lastKnownLocation = loc
        if isTouring, !nearby.isEmpty {
            nearby = TriggerEvaluator.reevaluate(nearby, at: loc)
            decideNext()
        }
        await refreshIfDue(at: loc)
    }

    private func refreshIfDue(at loc: CLLocation) async {
        let isMoving = loc.speed > 0.5
        guard PollPolicy.shouldFetch(
            now: Date(), lastFetchAt: lastFetchAt, isMoving: isMoving, isFetching: isFetching
        ) else { return }
        await refresh(at: loc)
    }

    /// One nearby fetch. Single-flight; on failure the held list keeps
    /// triggering locally (there's no offline spot store on the watch — the
    /// in-memory list rides out signal gaps).
    private func refresh(at loc: CLLocation) async {
        guard !isFetching else { return }
        isFetching = true
        lastFetchAt = Date()
        defer { isFetching = false }
        do {
            let course = effectiveCourse(for: loc)
            lastCourseDeg = course
            prevLocation = loc
            let res = try await api.nearby(
                lat: loc.coordinate.latitude,
                lng: loc.coordinate.longitude,
                radiusM: 2000,
                tracks: Array(enabledTrackSlugs),
                mode: mode,
                locale: LocalePreference.defaultLocale,
                trackLocales: LocalePreference.trackLocalesParam(
                    activeTracks: Array(enabledTrackSlugs), defaultLocale: LocalePreference.defaultLocale
                ),
                courseDeg: course,
                changedSince: canReuseVersion(at: loc) ? dataVersion : nil
            )
            error = nil
            guard !res.unchanged else {
                // Content unchanged; geometry already re-evaluated per fix.
                return
            }
            dataVersion = res.dataVersion
            versionAnchor = loc
            nearby = res.spots
            // Rolling prefetch, so spots play from disk at trigger time.
            Task { await WatchAudioCache.shared.cacheAudio(for: res.spots) }
            // Browsing fetches only inform the status line; nothing plays
            // until the tour is on.
            if isTouring { decideNext() }
        } catch {
            // Keep the held list; local triggering continues through gaps.
            self.error = "Nearby fetch failed: \(error.localizedDescription)"
        }
    }

    private func canReuseVersion(at loc: CLLocation) -> Bool {
        guard let anchor = versionAnchor, dataVersion != nil else { return false }
        return loc.distance(from: anchor) < 100
    }

    /// Direction of travel: GPS course when valid, else derived from
    /// movement history — same rule as the phone.
    private func effectiveCourse(for loc: CLLocation) -> Double? {
        if loc.course >= 0 { return loc.course }
        guard let prev = prevLocation, loc.distance(from: prev) > 15 else { return nil }
        return SpotScheduler.bearingDeg(from: prev.coordinate, to: loc.coordinate)
    }

    // ─── The decision point ──────────────────────────────────────────────────

    private var playerBusyForS: TimeInterval {
        guard player.nowPlayingSpotId != nil, let started = narrationStartedAt else { return 0 }
        return max(0, narrationDurationS - Date().timeIntervalSince(started))
    }

    private var schedulerContext: SpotScheduler.Context {
        SpotScheduler.Context(
            location: lastKnownLocation,
            courseDeg: lastCourseDeg,
            mode: mode,
            journeyRoute: [],
            trackOrder: TrackPreference.current,
            trackIdToSlug: Dictionary(
                allTracks.map { ($0.id, $0.slug) },
                uniquingKeysWith: { a, _ in a }
            ),
            lastPlayedAt: { PlayHistory.shared.lastPlayedAt($0) },
            playCount: { PlayHistory.shared.playCount($0) },
            isEligible: { [eligibility] in
                eligibility.isSequenceEligible($0, playCount: PlayHistory.shared.playCount)
            },
            neverReplays: { [eligibility] in eligibility.seriesUnitIds.contains($0) },
            busyForS: playerBusyForS,
            nowPlayingId: player.nowPlayingSpotId
        )
    }

    /// Re-aim "up next" on every fix and poll; start something only against
    /// an idle player. Same rules as the phone's wander style.
    private func decideNext() {
        guard isTouring else { return }
        let p = scheduler.plan(nearby: nearby.filter { NarrationPreference.current.canNarrate($0.content) }, ctx: schedulerContext)
        plan = p
        guard player.nowPlayingSpotId == nil else { return }
        let remaining = narrationGap.remaining(at: Date(), seconds: NarrationGapPreference.current.seconds)
        narrationGapTask?.cancel()
        narrationGapTask = nil
        if remaining > 0 {
            narrationGapTask = Task { @MainActor [weak self] in
                do { try await Task.sleep(for: .seconds(remaining)) } catch { return }
                self?.decideNext()
            }
            return
        }
        guard let s = p.playNow else { return }
        playSpot(s)
        // else: silence. (Fill-in planner slots here when the watch grows
        // one — VocabSpeech/QuizSpeech are already shareable.)
    }

    private func playSpot(_ s: NearbySpot) {
        guard let content = s.content, NarrationPreference.current.canNarrate(content) else { return }
        let intro = NarrationPreference.current.allowsDeviceSpeech ? locatorIntro(for: s) : nil
        PlayHistory.shared.recordPlay(spotId: s.spot.id)
        narrationStartedAt = Date()
        narrationDurationS = NarrationDuration.seconds(for: s)
        // A tap on the wrist as each story starts — the audible cue may be a
        // few seconds behind (locating clip, download), and the tap tells
        // the traveler to expect it.
        WKInterfaceDevice.current().play(.notification)
        player.play(
            content: content,
            spotId: s.spot.id,
            // Fresh spoken locator beats the canned clip; the clip is the
            // fallback when we have no fix to compute from.
            locating: intro == nil && s.triggered ? s.locating : nil,
            intro: intro
        )
    }

    /// ~8s before recorded narration ends: refresh position (bypassing the
    /// poll throttle) and pre-warm the likely winner's audio.
    private func prepareForDecision() {
        guard isTouring else { return }
        lastFetchAt = .distantPast
        if let loc = lastKnownLocation {
            Task { await self.refresh(at: loc) }
        }
        if let likely = plan?.target {
            Task { await WatchAudioCache.shared.cacheAudio(for: [likely]) }
        }
    }

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

    // ─── Prefetch ────────────────────────────────────────────────────────────

    /// "Download nearby audio" — the before-you-go button for cell-less
    /// watches: one wide fetch, then every narration + locating clip within
    /// it onto disk, with progress published by WatchAudioCache.
    func prefetchNearbyAudio() async {
        guard let loc = lastKnownLocation else {
            error = "No location fix yet."
            return
        }
        do {
            let res = try await api.nearby(
                lat: loc.coordinate.latitude,
                lng: loc.coordinate.longitude,
                radiusM: 5000,
                tracks: Array(enabledTrackSlugs),
                mode: mode,
                locale: LocalePreference.defaultLocale,
                trackLocales: LocalePreference.trackLocalesParam(
                    activeTracks: Array(enabledTrackSlugs), defaultLocale: LocalePreference.defaultLocale
                )
            )
            await WatchAudioCache.shared.cacheAudio(for: res.spots, trackProgress: true)
        } catch {
            self.error = "Prefetch failed: \(error.localizedDescription)"
        }
    }

    /// What the tour is heading for, for the root screen's status line: the
    /// scheduler's target while touring, else the nearest playable spot.
    /// Area spots are excluded: the watch has no gap planner, so they never
    /// auto-play here — promising one would lie.
    var nearestUpcoming: NearbySpot? {
        if isTouring, let t = plan?.target { return t }
        return nearby.first { NarrationPreference.current.canNarrate($0.content) && !$0.spot.trigger.isArea }
    }
}
