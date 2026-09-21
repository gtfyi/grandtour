import SwiftUI
import CoreLocation
import MapKit

struct ContentView: View {
    // Shared with the CarPlay scene — both drive the same tour, so these are
    // process singletons (AppServices), not per-view state.
    @ObservedObject private var location = AppServices.shared.location
    @ObservedObject private var tour = AppServices.shared.tour
    @ObservedObject private var journey = AppServices.shared.journey
    @State private var showTracks = false
    @State private var showJourney = false
    @State private var showRecord = false

    @State private var selectedSpotId: String?

    var body: some View {
        NavigationStack {
            ZStack(alignment: .bottom) {
                // The map must not extend under the bottom inset: it's a UIKit
                // view and swallows touches meant for the strip's controls.
                TourMapView(
                    tour: tour,
                    userLocation: location.location,
                    selectedSpotId: $selectedSpotId
                )

                if let np = nowPlaying {
                    NowPlayingCard(spot: np, player: tour.player)
                        .padding()
                        .transition(.move(edge: .bottom))
                } else if let item = nowPlayingFillIn {
                    FillInNowPlayingCard(
                        item: item,
                        trackName: tour.allTracks.first { $0.id == item.trackId }?.name ?? "",
                        player: tour.player
                    )
                    .padding()
                    .transition(.move(edge: .bottom))
                }
            }
            .navigationTitle("GrandTour")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { showJourney = true } label: {
                        Image(systemName: tour.journeyRoute.isEmpty ? "signpost.right" : "signpost.right.fill")
                    }
                }
                ToolbarItem(placement: .topBarLeading) {
                    // Walk and record: a separate mode — entering it ends the
                    // tour (mic and narration can't share the ears).
                    Button {
                        if tour.isTouring {
                            tour.stopTour()
                            location.stopTour()
                        }
                        showRecord = true
                    } label: {
                        Image(systemName: "mic")
                    }
                    .accessibilityLabel("Record a tour")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showTracks = true } label: {
                        Label("Tracks", systemImage: "square.stack.3d.up")
                            .labelStyle(.titleAndIcon)
                    }
                }
            }
            .sheet(isPresented: $showTracks) {
                TrackSheet(tour: tour)
            }
            .sheet(isPresented: $showJourney) {
                JourneySheet(tour: tour, journey: journey, userLocation: location.location)
            }
            .fullScreenCover(isPresented: $showRecord) {
                RecordModeView()
            }
            .sheet(item: selectedSpot) { item in
                SpotDetailSheet(item: item, isRemote: tour.isExploring) {
                    tour.playManually(item)
                    selectedSpotId = nil
                }
                .presentationDetents([.medium, .large])
            }
            .safeAreaInset(edge: .bottom) { spotStrip }
            .safeAreaInset(edge: .top) {
                if let demo = tour.demo { demoBanner(demo) }
            }
        }
        .task {
            // Idempotent: the CarPlay scene may already have bootstrapped.
            // Location → tour forwarding lives in AppServices too, so the
            // tour keeps running even when this view never appears.
            AppServices.shared.bootstrap()
        }
    }

    /// The master switch: ON tracks continuously and narrates as you travel.
    /// Lives in the bottom strip rather than the toolbar: it's the primary
    /// control of the app and needs room for a real label.
    @ViewBuilder
    private var tourToggle: some View {
        Button {
            // A demo drives its own fixes; real GPS stays as it was.
            if tour.isTouring {
                tour.stopTour()
                if tour.demo == nil { location.stopTour() }
            } else {
                if tour.demo == nil { location.startTour() }
                tour.startTour(at: location.location)
            }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: tour.isTouring ? "waveform.circle.fill" : "play.circle.fill")
                    .font(.title3)
                VStack(alignment: .leading, spacing: 1) {
                    Text(tour.isTouring ? "Tour on" : "Start tour")
                        .font(.subheadline.bold())
                    Text(tour.isTouring
                         ? "Playing as you travel"
                         : "Track me and play automatically")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(tour.isTouring ? Color.green : Color.accentColor)
        .background(
            (tour.isTouring ? Color.green : Color.accentColor).opacity(0.12),
            in: RoundedRectangle(cornerRadius: 12)
        )
        .padding(.horizontal)
        .accessibilityLabel(tour.isTouring ? "Tour on, tap to stop" : "Tour off, tap to start")
    }

    /// A demo in progress: which track, and the way out.
    private func demoBanner(_ demo: DemoDrive) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "play.rectangle")
            Text("Demo · \(demo.track.name)")
                .font(.footnote.bold())
                .lineLimit(1)
            Spacer()
            Button("End demo") { tour.endDemo() }
                .font(.footnote.bold())
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(.ultraThinMaterial)
    }

    /// The map selection resolved back to a spot, for the detail sheet.
    private var selectedSpot: Binding<NearbySpot?> {
        Binding(
            get: { tour.nearby.first { $0.spot.id == selectedSpotId } },
            set: { if $0 == nil { selectedSpotId = nil } }
        )
    }

    private var nowPlaying: NearbySpot? {
        guard let id = tour.player.nowPlayingSpotId else { return nil }
        return tour.nearby.first { $0.spot.id == id }
    }

    /// The playing id resolved as a fill-in item (it isn't a spot's).
    private var nowPlayingFillIn: FillInItem? {
        guard let id = tour.player.nowPlayingSpotId else { return nil }
        return tour.fillInItem(id: id)
    }

    /// A horizontal rail of what's on the map right now — tap to open, so
    /// stories are reachable without hunting for pins.
    @ViewBuilder
    private var spotStrip: some View {
        if nowPlaying == nil && nowPlayingFillIn == nil {
            VStack(alignment: .leading, spacing: 6) {
                tourToggle
                if tour.isOffline {
                    Label("Offline — playing from cached stories.", systemImage: "icloud.slash")
                        .font(.footnote)
                        .foregroundStyle(.orange)
                        .padding(.horizontal)
                }
                if tour.demo != nil {
                    Label(tour.isTouring ? "Demo on — driving the route for you." : "Demo ready — Start tour drives the route for you.",
                          systemImage: "play.rectangle")
                        .font(.footnote)
                        .foregroundStyle(tour.isTouring ? Color.green : Color.secondary)
                        .padding(.horizontal)
                } else if location.denied {
                    Text("Location is off for GrandTour. Enable it in Settings to hear stories around you.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal)
                } else if !location.authorized {
                    Text("Enable location to hear stories around you.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal)
                } else if tour.isTouring {
                    Label("Tour on — tracking and narrating, including with your phone locked.", systemImage: "dot.radiowaves.left.and.right")
                        .font(.footnote)
                        .foregroundStyle(.green)
                        .padding(.horizontal)
                }
                if tour.isTouring, let next = tour.upNext {
                    Label {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\(tour.tourStyle.isGuided ? "Next stop" : "Up next"): **\(next.spot.title)** · \(formatDistance(next.distanceM))")
                            if let detail = tour.upNextDetail {
                                Text(detail).foregroundStyle(.tertiary)
                            }
                        }
                    } icon: {
                        Image(systemName: tour.tourStyle.isGuided ? "figure.walk" : "arrow.forward.circle")
                    }
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal)
                }
                if let err = tour.error {
                    Text(err).font(.footnote).foregroundStyle(.red).padding(.horizontal)
                }
                if tour.nearby.isEmpty {
                    Text(tour.enabledTrackSlugs.isEmpty && !tour.tourStyle.isGuided
                         ? "All tracks are off. Tap Tracks to choose what to hear."
                         : tour.isExploring ? "No stories in view — pan or zoom out to find some."
                         : tour.emptyNearbyHint ?? "Looking for stories nearby…")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal)
                } else {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 12) {
                            ForEach(tour.nearby) { item in
                                SpotCard(item: item) { selectedSpotId = item.spot.id }
                            }
                        }
                        .padding(.horizontal)
                    }
                }
            }
            .padding(.vertical, 10)
            .background(.ultraThinMaterial)
        }
    }
}

/// One card in the bottom rail.
struct SpotCard: View {
    let item: NearbySpot
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Circle()
                        .fill(Color(hex: item.track.color) ?? .accentColor)
                        .frame(width: 8, height: 8)
                    Text(item.track.name).font(.caption2).foregroundStyle(.secondary)
                }
                Text(item.spot.title).font(.subheadline.bold()).lineLimit(1)
                HStack(spacing: 6) {
                    Text(formatDistance(item.distanceM))
                        .font(.caption).foregroundStyle(.secondary)
                    if NarrationPreference.current.canNarrate(item.content) {
                        Image(systemName: "waveform").font(.caption)
                    }
                    if item.triggered {
                        Text("• here").font(.caption.bold()).foregroundStyle(.green)
                    }
                }
            }
            .frame(width: 190, alignment: .leading)
            .padding(10)
            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain)
    }
}

/// Tapping a pin or card opens this: the full story, playable from anywhere.
struct SpotDetailSheet: View {
    let item: NearbySpot
    /// True when the user is browsing a place they aren't standing in.
    let isRemote: Bool
    let onPlay: () -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    HStack(spacing: 8) {
                        Circle()
                            .fill(Color(hex: item.track.color) ?? .accentColor)
                            .frame(width: 10, height: 10)
                        Text(item.track.name).font(.subheadline).foregroundStyle(.secondary)
                        Spacer()
                        Text(formatDistance(item.distanceM))
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                    Text(item.spot.subtitle).font(.body)

                    if NarrationPreference.current.canNarrate(item.content) {
                        Button(action: onPlay) {
                            Label(isRemote ? "Listen from here" : "Play", systemImage: "play.fill")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                    } else {
                        Text(NarrationPreference.current == .serverOnly
                             ? "No server recording for this spot yet."
                             : "No narration published for this spot yet.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }

                    if let doc = item.content?.document {
                        Text(doc.text).font(.body).lineSpacing(4)
                    }

                    if let guide = item.guide { GuideLink(guide: guide) }

                    if let origin = item.content?.provenance?.origin {
                        SourceLicenseCard(source: origin)
                    }

                    if let sources = item.content?.provenance?.sources, !sources.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Sources").font(.caption.bold()).foregroundStyle(.secondary)
                            ForEach(Array(sources.enumerated()), id: \.offset) { _, s in
                                if let urlString = s.url, let url = URL(string: urlString) {
                                    Link(s.displayName, destination: url).font(.caption)
                                } else {
                                    Text(s.displayName).font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
                .padding()
            }
            .navigationTitle(item.spot.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}

/// Meters under a kilometer, otherwise one decimal of km.
func formatDistance(_ m: Double) -> String {
    m < 1_000 ? "\(Int(m)) m" : String(format: "%.1f km", m / 1_000)
}

struct NowPlayingCard: View {
    let spot: NearbySpot
    @ObservedObject var player: AudioPlayer

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                VStack(alignment: .leading) {
                    Text(spot.spot.title).font(.headline)
                    Text(spot.track.name).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button { player.toggle() } label: {
                    Image(systemName: player.isPlaying ? "pause.circle.fill" : "play.circle.fill")
                        .font(.largeTitle)
                }
                Button { player.stop() } label: {
                    Image(systemName: "xmark.circle.fill").font(.title2).foregroundStyle(.secondary)
                }
            }

            // Prefer the play-time locator ("Back 500 feet on your left…");
            // the server's canned clip text is the fallback.
            if let where_ = player.introText ?? spot.locating?.text {
                Text(where_)
                    .font(.subheadline.italic())
                    .foregroundStyle(.secondary)
            }

            if let doc = spot.content?.document, !doc.audioSegments.isEmpty {
                ScrollView {
                    TranscriptView(document: doc, currentMs: player.currentMs)
                }
                .frame(maxHeight: 120)
            }

            if let guide = spot.guide {
                GuideLink(guide: guide)
            }
        }
        .padding()
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16))
        .shadow(radius: 8)
    }
}

/// Now-playing card for a fill-in item: no place, no pin, no distance — a
/// practice header and the word instead.
struct FillInNowPlayingCard: View {
    let item: FillInItem
    let trackName: String
    @ObservedObject var player: AudioPlayer

    private var header: String {
        switch item.payload {
        case .vocab: return "Vocabulary practice"
        case .quiz(let p): return "\(p.category) quiz"
        case .unknown: return "Fill-in"
        }
    }

    private var headerIcon: String {
        switch item.payload {
        case .quiz: return "questionmark.circle"
        case .vocab, .unknown: return "text.book.closed"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                VStack(alignment: .leading) {
                    Label(header, systemImage: headerIcon)
                        .font(.caption.bold())
                        .foregroundStyle(.secondary)
                    Text(item.payload.displayTitle).font(.headline)
                    if !trackName.isEmpty {
                        Text(trackName).font(.caption).foregroundStyle(.secondary)
                    }
                }
                Spacer()
                Button { player.toggle() } label: {
                    Image(systemName: player.isPlaying ? "pause.circle.fill" : "play.circle.fill")
                        .font(.largeTitle)
                }
                Button { player.stop() } label: {
                    Image(systemName: "xmark.circle.fill").font(.title2).foregroundStyle(.secondary)
                }
            }

            // Plain text, no karaoke highlight: vocab audio has no alignment
            // tier (the pause is baked in, so byte↔ms sync doesn't exist).
            // No ScrollView: its content refused to paint in this card on
            // iOS 26 (identical Text outside it rendered fine), and vocab
            // scripts are short by construction — a line cap is enough.
            if let text = item.content?.document?.text, !text.isEmpty {
                Text(text)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(6)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding()
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16))
        .shadow(radius: 8)
    }
}

/// Licence/attribution for content we imported rather than wrote — an NPS
/// tour, a newspaper archive. Shows publisher, licence, required
/// attribution text, and (when checked) whether reuse was actually
/// verified per asset, not just inferred from where it was hosted.
struct SourceLicenseCard: View {
    let source: GenerationSource

    private var worstStatus: String? {
        guard let clearance = source.clearance, !clearance.isEmpty else { return nil }
        let order = ["not-cleared": 0, "unclear": 1, "probable": 2, "confirmed": 3]
        return clearance.min { (order[$0.status] ?? 1) < (order[$1.status] ?? 1) }?.status
    }

    private var statusLabel: String? {
        switch worstStatus {
        case "confirmed": "License confirmed"
        case "probable": "License probable"
        case "unclear": "License unclear"
        case "not-cleared": "Not cleared for reuse"
        default: nil
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Source & license").font(.caption.bold()).foregroundStyle(.secondary)
            Text(source.publisher ?? source.displayName).font(.caption)
            if let license = source.license {
                Text(license).font(.caption2).foregroundStyle(.secondary)
            }
            if let attribution = source.attribution {
                Text(attribution).font(.caption2).italic().foregroundStyle(.secondary)
            }
            if let statusLabel {
                Text(statusLabel).font(.caption2.bold())
                    .foregroundStyle(worstStatus == "confirmed" ? Color.secondary : Color.orange)
            }
            if let urlString = source.url, let url = URL(string: urlString) {
                Link("View source", destination: url).font(.caption2)
            }
        }
        .padding(8)
        .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
    }
}

struct GuideLink: View {
    let guide: Guide

    var body: some View {
        HStack {
            Image(systemName: "person.crop.circle.badge.checkmark")
            VStack(alignment: .leading) {
                Text("Local guide: \(guide.name)").font(.caption.bold())
                Text(guide.bio).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer()
            if let urlStr = guide.bookingUrl, let url = URL(string: urlStr) {
                Link("Book", destination: url).font(.caption.bold())
            }
        }
        .padding(8)
        .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
    }
}

struct TrackSheet: View {
    @ObservedObject var tour: TourViewModel
    @ObservedObject private var cache = TourCache.shared
    @Environment(\.dismiss) private var dismiss
    @State private var narrationPreference = NarrationPreference.current
    @State private var fillInGap = FillInGapPreference.current
    @State private var narrationGap = NarrationGapPreference.current
    @State private var trackOrder = TrackPreference.current
    @State private var keepCarAudioConnected = AudioKeepalive.isEnabled
    @State private var defaultLocale = LocalePreference.defaultLocale

    /// Tracks in the user's preference order (ordered ones first, the rest in
    /// catalog order). This is also what the queue's ranking sees.
    private var orderedTracks: [Track] {
        guard !trackOrder.isEmpty else { return tour.allTracks }
        let rank = Dictionary(
            uniqueKeysWithValues: trackOrder.enumerated().map { ($1, $0) }
        )
        return tour.allTracks.enumerated().sorted { a, b in
            let ra = rank[a.element.slug] ?? Int.max
            let rb = rank[b.element.slug] ?? Int.max
            return ra != rb ? ra < rb : a.offset < b.offset
        }.map(\.element)
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack {
                        Button("All on") { tour.setEnabledTracks(Set(tour.allTracks.map(\.slug))) }
                        Spacer()
                        Button("All off") { tour.setEnabledTracks([]) }
                    }
                    .buttonStyle(.borderless)
                } header: {
                    Text("\(tour.enabledTrackSlugs.count) of \(tour.allTracks.count) tracks on")
                } footer: {
                    Text("Use a switch to mix tracks, or tap Only this track to listen to one. Demo plays a track as a simulated trip along its route. Download saves the entire track and its audio for use without service. Tap Downloaded to refresh a saved track.")
                }
                Section {
                    ForEach(orderedTracks) { track in
                        VStack(alignment: .leading, spacing: 8) {
                            Toggle(isOn: Binding(
                                get: { tour.enabledTrackSlugs.contains(track.slug) },
                                set: { _ in tour.toggleTrack(track.slug) }
                            )) {
                                VStack(alignment: .leading) {
                                    HStack(spacing: 6) {
                                        Text(track.name)
                                        if tour.isCompleted(track) {
                                            Label("Finished", systemImage: "checkmark.circle.fill")
                                                .font(.caption2)
                                                .foregroundStyle(.green)
                                                .labelStyle(.titleAndIcon)
                                        }
                                    }
                                    Text(track.countLabel).font(.caption).foregroundStyle(.secondary)
                                    Text(track.description).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                                    if let p = tour.trackProgress(track), p.played > 0, !tour.isCompleted(track) {
                                        Text("\(p.played) of \(p.total) heard")
                                            .font(.caption2)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                            }
                            HStack {
                                Button("Only this track") { tour.setEnabledTracks([track.slug]) }
                                    .buttonStyle(.borderless)
                                    .font(.subheadline)
                                    .accessibilityLabel("Only \(track.name)")
                                if !track.isFillIn, (track.spotCount ?? 1) > 0 {
                                    // A simulated trip along the track's route, stories and all.
                                    Button(tour.demo?.track.id == track.id ? "Demo on" : "Demo") {
                                        Task { await tour.startDemo(track) }
                                        dismiss()
                                    }
                                    .buttonStyle(.borderless)
                                    .font(.subheadline)
                                    .disabled(tour.demo?.track.id == track.id)
                                    .accessibilityLabel("Demo \(track.name)")
                                }
                                Spacer()
                                trackLanguageMenu(for: track)
                                downloadButton(for: track)
                            }
                            if let state = cache.downloadState(for: track),
                               state.phase == .failed, let error = state.errorText {
                                Text(error)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .contextMenu {
                            if let p = tour.trackProgress(track), p.played > 0 {
                                Button {
                                    tour.startOver(track)
                                } label: {
                                    Label("Start over", systemImage: "arrow.counterclockwise")
                                }
                            }
                        }
                    }
                    .onMove { from, to in
                        var slugs = orderedTracks.map(\.slug)
                        slugs.move(fromOffsets: from, toOffset: to)
                        trackOrder = slugs
                        TrackPreference.current = slugs
                    }
                    if !trackOrder.isEmpty {
                        Button("Clear track order") {
                            trackOrder = []
                            TrackPreference.current = []
                        }
                    }
                } header: {
                    Text("Tracks")
                } footer: {
                    Text("Drag to reorder (tap Edit). When several stories are in range at once, tracks higher in this list play first; without an order, the one you're heading toward plays first. A finished series switches itself off — toggle it back on to browse, or long-press for “Start over” to hear it fresh.")
                }

                Section {
                    NavigationLink {
                        ServerListView()
                    } label: {
                        HStack {
                            Text("Server")
                            Spacer()
                            Text(ServerPreference.current.name)
                                .foregroundStyle(.secondary)
                        }
                    }
                } footer: {
                    Text(ServerPreference.currentURL.absoluteString)
                }
                Section {
                    Picker("Mode", selection: $tour.modePreference) {
                        Text("Auto").tag(ActivityModePreference.auto)
                        ForEach(ActivityModePreference.explicit, id: \.self) {
                            Text($0.capitalized).tag($0)
                        }
                    }
                } header: {
                    Text("Activity mode")
                } footer: {
                    Text(tour.modePreference == ActivityModePreference.auto
                         ? "Auto infers walking or driving from your speed (currently \(tour.mode)). Stories authored for one mode only — a drive corridor, a hike — are hidden in other modes."
                         : "Stories authored for other modes only are hidden. Auto switches between walking and driving from your speed.")
                }
                Section {
                    Picker("Tour style", selection: $tour.tourStyle) {
                        Text("Wander — play what's ahead").tag(TourStyle.wander)
                        ForEach(tour.allTracks.filter { !$0.isFillIn }) { track in
                            Text("Walking tour: \(track.name) · \(track.countLabel)").tag(TourStyle.guided(trackSlug: track.slug))
                        }
                    }
                } header: {
                    Text("Tour style")
                } footer: {
                    Text(tour.tourStyle.isGuided
                         ? "One track as a guided walk: the app names the next stop, speaks directions, and tells its story when you arrive. No fill-ins."
                         : "Every enabled track: the tour predicts your path and plays the least-heard story coming up, just before you reach it.")
                }
                Section {
                    ForEach(NarrationPreference.allCases, id: \.self) { pref in
                        Button {
                            narrationPreference = pref
                            NarrationPreference.current = pref
                            tour.player.stop(reason: "narration_preference_changed")
                            tour.decideNext()
                        } label: {
                            HStack {
                                Text(pref.label).foregroundStyle(.primary)
                                Spacer()
                                if pref == narrationPreference {
                                    Image(systemName: "checkmark").foregroundStyle(.tint)
                                }
                            }
                        }
                    }
                } header: {
                    Text("Narration voice")
                } footer: {
                    Text("Server audio only is the default. It plays downloaded recordings and skips missing audio without device speech, including spoken directions. Choose fallback to allow the device voice when a recording is unavailable.")
                }
                Section {
                    Picker("Language", selection: $defaultLocale) {
                        ForEach(LocalePreference.known, id: \.code) { l in
                            Text(l.label).tag(l.code)
                        }
                    }
                    .onChange(of: defaultLocale) { _, newValue in
                        LocalePreference.defaultLocale = newValue
                        tour.decideNext()
                    }
                } header: {
                    Text("Language")
                } footer: {
                    Text("Default narration language across tracks. A track without content in this language falls back to whatever it has. Set a different language for one track below with its \u{2026} menu.")
                }
                Section {
                    Toggle("Keep car audio connected", isOn: $keepCarAudioConnected)
                        .onChange(of: keepCarAudioConnected) { _, enabled in
                            AudioKeepalive.shared.setEnabled(enabled)
                        }
                } header: {
                    Text("Car audio")
                } footer: {
                    Text("Keeps the audio connection active between stories. If car audio stutters, turn this off while parked to compare playback.")
                }
                Section {
                    Picker("Pause between stories", selection: $narrationGap) {
                        ForEach(NarrationGapPreference.allCases, id: \.self) { pref in
                            Text(pref.label).tag(pref)
                        }
                    }
                    .onChange(of: narrationGap) { _, value in
                        NarrationGapPreference.current = value
                        tour.decideNext()
                    }
                    Picker("Fill quiet gaps", selection: $fillInGap) {
                        ForEach(FillInGapPreference.allCases, id: \.self) { pref in
                            Text(pref.label).tag(pref)
                        }
                    }
                    .onChange(of: fillInGap) { _, v in FillInGapPreference.current = v }
                } header: {
                    Text("Story spacing")
                } footer: {
                    Text("The pause starts when a story finishes. Fill-in tracks wait for the longer quiet-gap setting before playing.")
                }

            }
            .navigationTitle("Tracks")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { EditButton() }
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .task { cache.refreshDownloadStates() }
            .onReceive(NotificationCenter.default.publisher(for: ServerPreference.didChange)) { _ in
                cache.refreshDownloadStates()
            }
            .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in
                cache.refreshDownloadStates()
            }
        }
    }

    private func trackLanguageMenu(for track: Track) -> some View {
        let current = LocalePreference.override(forTrack: track.slug)
        return Menu {
            Button {
                LocalePreference.setOverride(nil, forTrack: track.slug)
                tour.decideNext()
            } label: {
                if current == nil { Label("Follow default (\(LocalePreference.label(for: defaultLocale)))", systemImage: "checkmark") }
                else { Text("Follow default (\(LocalePreference.label(for: defaultLocale)))") }
            }
            ForEach(LocalePreference.known, id: \.code) { l in
                Button {
                    LocalePreference.setOverride(l.code, forTrack: track.slug)
                    tour.decideNext()
                } label: {
                    if current == l.code { Label(l.label, systemImage: "checkmark") }
                    else { Text(l.label) }
                }
            }
        } label: {
            // The globe alone while the track follows the default: the row
            // also holds Only this track, Demo and Download, and the word
            // "Language" is what made the labels hyphenate.
            if let current {
                Label(LocalePreference.label(for: current), systemImage: "globe")
                    .font(.subheadline)
            } else {
                Image(systemName: "globe")
                    .font(.subheadline)
            }
        }
        .accessibilityLabel("Language for \(track.name)")
    }

    private func downloadButton(for track: Track) -> some View {
        let state = cache.downloadState(for: track)
        return Button {
            Task {
                await cache.downloadTrack(track)
                tour.refreshDownloadedContent()
            }
        } label: {
            switch state?.phase {
            case .downloading:
                HStack(spacing: 5) {
                    ProgressView().controlSize(.mini)
                    if let state, state.total > 0 {
                        Text("\(min(99, state.completed * 100 / state.total))%")
                            .monospacedDigit()
                    } else {
                        Text("Preparing…")
                    }
                }
            case .downloaded:
                Label("Downloaded", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.green)
            case .failed:
                Label("Retry download", systemImage: "arrow.clockwise")
            case nil:
                Label("Download", systemImage: "arrow.down.circle")
            }
        }
        .font(.caption)
        .buttonStyle(.borderless)
        .disabled(state?.phase == .downloading)
        .accessibilityLabel(state?.phase == .downloaded
                            ? "\(track.name) downloaded. Refresh download"
                            : "Download all of \(track.name) for offline use")
    }
}

/// Plan a journey: search a destination, preview the route, prefetch the
/// corridor. While a journey is active, shows its progress and lets it end.
struct JourneySheet: View {
    @ObservedObject var tour: TourViewModel
    @ObservedObject var journey: JourneyPlanner
    @ObservedObject private var cache = TourCache.shared
    let userLocation: CLLocation?
    @Environment(\.dismiss) private var dismiss
    @State private var starting = false

    var body: some View {
        NavigationStack {
            Group {
                if !tour.journeyRoute.isEmpty {
                    activeJourney
                } else if let route = journey.plannedRoute {
                    routePreview(route)
                } else {
                    destinationSearch
                }
            }
            .navigationTitle("Journey")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }

    private var destinationSearch: some View {
        List {
            Section {
                TextField("Where are you headed?", text: $journey.query)
                    .textFieldStyle(.plain)
                    .autocorrectionDisabled()
                    .onSubmit {
                        Task { await journey.search(near: userLocation?.coordinate) }
                    }
            } footer: {
                Text("The route is computed on this phone; stories along the way are downloaded before you set out, so the tour works with no signal.")
            }
            if journey.isSearching {
                HStack { ProgressView(); Text("Searching…").foregroundStyle(.secondary) }
            }
            ForEach(journey.results) { r in
                Button {
                    guard let loc = userLocation else { return }
                    Task { await journey.planRoute(to: r, from: loc.coordinate, mode: tour.mode) }
                } label: {
                    VStack(alignment: .leading) {
                        Text(r.name).font(.body)
                        Text(r.subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
            }
            if userLocation == nil {
                Text("Waiting for your location…").font(.footnote).foregroundStyle(.secondary)
            }
            if let err = journey.routeError {
                Text(err).font(.footnote).foregroundStyle(.red)
            }
            if journey.isRouting {
                HStack { ProgressView(); Text("Computing route…").foregroundStyle(.secondary) }
            }
        }
    }

    private func routePreview(_ route: MKRoute) -> some View {
        List {
            Section("Route") {
                LabeledContent("To", value: journey.plannedDestination?.name ?? "")
                LabeledContent("Distance", value: formatDistance(route.distance))
                LabeledContent(
                    "Time",
                    value: Duration.seconds(route.expectedTravelTime)
                        .formatted(.units(allowed: [.hours, .minutes], width: .abbreviated))
                )
            }
            Section {
                Button {
                    starting = true
                    let coords = JourneyPlanner.decimated(route.polyline)
                    Task {
                        await tour.startJourney(route: coords, at: userLocation)
                        starting = false
                    }
                } label: {
                    if starting {
                        HStack { ProgressView(); Text("Fetching stories along the way…") }
                    } else {
                        Label("Start journey", systemImage: "figure.walk.motion")
                    }
                }
                .disabled(starting)
                Button("Pick somewhere else", role: .cancel) { journey.reset() }
            } footer: {
                Text("Starting downloads every story along the route and turns the tour on.")
            }
        }
    }

    private var activeJourney: some View {
        List {
            Section("Along the way") {
                if let p = cache.audioProgress {
                    if p.done < p.total {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Caching audio \(p.done)/\(p.total)…")
                            ProgressView(value: Double(p.done), total: Double(max(p.total, 1)))
                        }
                    } else {
                        Label("\(p.total) audio clips cached — ready for no signal.", systemImage: "checkmark.icloud")
                            .foregroundStyle(.green)
                    }
                }
                ForEach(tour.journeySpots) { s in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(s.spot.title).font(.body)
                            Text(s.track.name).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if s.isNarratable {
                            Image(systemName: "waveform").foregroundStyle(.secondary)
                        }
                    }
                }
                if tour.journeySpots.isEmpty {
                    Text("No published stories along this route yet.")
                        .foregroundStyle(.secondary)
                }
            }
            Section {
                Button("End journey", role: .destructive) {
                    tour.endJourney()
                    journey.reset()
                    dismiss()
                }
            }
        }
    }
}

extension Color {
    /// Parse a "#rrggbb" hex string.
    init?(hex: String?) {
        guard let hex, hex.hasPrefix("#"), hex.count == 7,
              let v = Int(hex.dropFirst(), radix: 16) else { return nil }
        self.init(
            red: Double((v >> 16) & 0xff) / 255,
            green: Double((v >> 8) & 0xff) / 255,
            blue: Double(v & 0xff) / 255
        )
    }
}
