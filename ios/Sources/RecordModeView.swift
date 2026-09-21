import SwiftUI
import CoreLocation

/// Walk-and-record mode (PRD "Walk and Record"): press record, narrate where
/// you stand and save to a local track. Uploads follow when a writable server
/// is reachable; recording never depends on that connection.
///
/// Deliberately separate from touring: presenting this stops the tour first
/// (ContentView enforces it), and only the location pipeline is shared. The
/// microphone owns the audio session while a take is open; the ears
/// invariant resumes the moment the take is saved or discarded.
///
/// Layout note: the recording controls are a fixed panel ABOVE the list, not
/// list rows — the button must stay under the walker's thumb while the spot
/// list grows (and custom-shaped plain buttons inside List rows didn't
/// reliably receive taps on iOS 26).
struct RecordModeView: View {
    @StateObject private var vm = RecorderViewModel()
    @ObservedObject private var location = AppServices.shared.location
    @ObservedObject private var tour = AppServices.shared.tour
    @Environment(\.dismiss) private var dismiss
    @State private var showNewTrack = false
    @State private var newTrackName = ""
    @State private var confirmDiscard = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                recordPanel
                Divider()
                spotList
            }
            .navigationTitle("Record")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        if vm.take != nil || vm.engine.isRecording {
                            confirmDiscard = true
                        } else {
                            dismiss()
                        }
                    }
                    .disabled(vm.isSaving)
                }
            }
            .alert("New track", isPresented: $showNewTrack) {
                TextField("Name — “Cascade Canyon Loop”", text: $newTrackName)
                Button("Create") {
                    // Capture before clearing: the Task body runs after this
                    // closure returns, and would otherwise read "".
                    let name = newTrackName
                    newTrackName = ""
                    Task { await vm.createTrack(named: name) }
                }
                Button("Cancel", role: .cancel) { newTrackName = "" }
            } message: {
                Text("This track is saved on your phone. It uploads with your recordings when you connect to an authoring server.")
            }
            .alert("Microphone is off", isPresented: $vm.micDenied) {
                Button("Open Settings") {
                    if let url = URL(string: UIApplication.openSettingsURLString) {
                        UIApplication.shared.open(url)
                    }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Enable the microphone for GrandTour in Settings to record narration.")
            }
            .confirmationDialog("Discard the unsaved recording?", isPresented: $confirmDiscard, titleVisibility: .visible) {
                Button("Discard recording", role: .destructive) {
                    vm.discardTake()
                    dismiss()
                }
                Button("Keep recording", role: .cancel) {}
            }
        }
        .interactiveDismissDisabled(vm.take != nil || vm.engine.isRecording)
        .task {
            await vm.loadTracks()
        }
        .onDisappear { vm.discardTake() }
    }

    // MARK: Recording panel (fixed above the list)

    private var recordPanel: some View {
        VStack(spacing: 12) {
            trackPicker
                .disabled(vm.engine.isRecording || vm.take != nil)
            uploadStatus
            if vm.canEnablePlayback, let track = vm.selectedTrack?.remoteTrack,
               !tour.enabledTrackSlugs.contains(track.slug) {
                Button {
                    tour.toggleTrack(track.slug)
                } label: {
                    Label("Turn this track on for playback", systemImage: "waveform.badge.plus")
                        .font(.subheadline)
                }
            }
            if let take = vm.take {
                takeEditor(take)
            } else {
                recordButton
                gpsStatus
            }
            if let err = vm.error {
                Text(err)
                    .font(.footnote)
                    .foregroundStyle(.orange)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding()
    }

    private var trackPicker: some View {
        Group {
            if vm.tracks.isEmpty {
                Button { showNewTrack = true } label: {
                    Label("Create a track to record onto", systemImage: "plus.circle.fill")
                }
            } else {
                Menu {
                    ForEach(vm.tracks) { track in
                        Button(track.name) { vm.selectTrack(track) }
                    }
                    Divider()
                    Button { showNewTrack = true } label: {
                        Label("New track…", systemImage: "plus")
                    }
                } label: {
                    HStack {
                        Text("Recording onto").foregroundStyle(.secondary)
                        Spacer()
                        Text(vm.selectedTrack?.name ?? "Choose a track")
                            .fontWeight(.semibold)
                            .multilineTextAlignment(.trailing)
                        Image(systemName: "chevron.up.chevron.down")
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                    .padding(12)
                    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
                }
            }
        }
    }

    private var uploadStatus: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                if vm.library.isSyncing { ProgressView().controlSize(.small) }
                Label(vm.library.isSyncing ? "Uploading when connected…" : "Saved on this phone",
                      systemImage: "iphone")
                Spacer()
                NavigationLink { ServerListView() } label: {
                    Label("Server", systemImage: "network")
                }
                .disabled(vm.engine.isRecording || vm.take != nil)
            }
            Text(vm.library.syncMessage ?? "Create tracks and record offline. Uploads resume automatically when a server is reachable.")
                .foregroundStyle(.secondary)
            if let server = vm.selectedTrack?.serverURL {
                Text("Upload destination: \(server.host ?? server.absoluteString)")
                    .foregroundStyle(.secondary)
            }
        }
        .font(.caption)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var recordButton: some View {
        RecordButton(engine: vm.engine) {
            Task {
                if vm.engine.isRecording {
                    await vm.endTake()
                } else {
                    await vm.beginTake()
                }
            }
        }
        .disabled(vm.selectedTrack == nil)
        .opacity(vm.selectedTrack == nil ? 0.4 : 1)
    }

    @ViewBuilder
    private var gpsStatus: some View {
        if let loc = location.location, loc.horizontalAccuracy >= 0 {
            Label(
                "GPS ±\(Int(loc.horizontalAccuracy)) m",
                systemImage: loc.horizontalAccuracy <= 15 ? "location.fill" : "location"
            )
            .font(.caption)
            .foregroundStyle(loc.horizontalAccuracy <= 15 ? .green : .orange)
        } else {
            Label("Waiting for GPS…", systemImage: "location.slash")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    /// Name, listen back, save or discard a finished take.
    private func takeEditor(_ take: RecorderViewModel.Take) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(
                Duration.milliseconds(Int(take.durationMs))
                    .formatted(.time(pattern: .minuteSecond)) + " recorded",
                systemImage: "waveform"
            )
            .font(.subheadline).foregroundStyle(.secondary)

            TextField("Spot name — “The old mill”", text: $vm.takeTitle)
                .textFieldStyle(.roundedBorder)

            HStack(spacing: 12) {
                Button {
                    vm.engine.togglePreview(of: take.fileURL)
                } label: {
                    Image(systemName: vm.engine.isPreviewing ? "stop.circle" : "play.circle")
                        .font(.title2)
                }
                .buttonStyle(.bordered)

                Button {
                    Task { await vm.saveTake() }
                } label: {
                    if vm.isSaving {
                        ProgressView().frame(maxWidth: .infinity)
                    } else {
                        Label("Save spot", systemImage: "checkmark.circle.fill")
                            .frame(maxWidth: .infinity)
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(vm.isSaving || take.location == nil)

                Button(role: .destructive) {
                    vm.discardTake()
                } label: {
                    Image(systemName: "trash").font(.title3)
                }
                .buttonStyle(.bordered)
                .disabled(vm.isSaving)
            }
            if take.location == nil {
                Label("No GPS fix — a spot needs a place. Wait for GPS, then record again.",
                      systemImage: "exclamationmark.triangle")
                    .font(.caption).foregroundStyle(.red)
            }
        }
        .padding(12)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
    }

    // MARK: Spot list (recorded + pending)

    private var spotList: some View {
        List {
            if !vm.localRecordings.isEmpty { localSection }
            spotsSection
        }
        .listStyle(.insetGrouped)
    }

    private var localSection: some View {
        Section {
            ForEach(vm.localRecordings) { item in
                HStack {
                    Button {
                        vm.engine.togglePreview(of: vm.library.audioURL(for: item))
                    } label: {
                        Image(systemName: vm.engine.isPreviewing ? "stop.circle" : "play.circle")
                            .font(.title2)
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Listen to \(item.meta.title)")
                    .disabled(vm.engine.isRecording || vm.take != nil)
                    VStack(alignment: .leading) {
                        Text(item.meta.title)
                        Text(item.remoteSpot == nil ? "Waiting to upload" : "Uploaded • saved on phone")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Image(systemName: item.remoteSpot == nil ? "icloud.and.arrow.up" : "checkmark.icloud")
                        .foregroundStyle(item.remoteSpot == nil ? .orange : .green)
                }
                .swipeActions {
                    Button(role: .destructive) {
                        Task { await vm.deleteRecording(item) }
                    } label: { Label("Delete", systemImage: "trash") }
                    .disabled(vm.library.isSyncing)
                }
            }
            if vm.library.pendingCount > 0 {
                Button { Task { await vm.retryPending() } } label: {
                    Label("Upload now", systemImage: "arrow.clockwise.icloud")
                }
                .disabled(vm.library.isSyncing)
            }
        } header: {
            Text("Recordings on this phone")
        } footer: {
            Text("Audio and locations stay on this phone, including after upload. Uploads resume while GrandTour is open when you reconnect.")
        }
    }

    private var spotsSection: some View {
        Section {
            if vm.spots.isEmpty && vm.localRecordings.isEmpty {
                Text(vm.selectedTrack == nil
                     ? "Pick or create a track to see its spots."
                     : "Nothing recorded on this track yet.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            ForEach(vm.spots) { spot in
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(spot.title)
                        if let here = location.location {
                            let d = here.distance(from: CLLocation(
                                latitude: spot.trigger.center.lat,
                                longitude: spot.trigger.center.lng
                            ))
                            Text(formatDistance(d) + " away")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    Spacer()
                    Image(systemName: "waveform").foregroundStyle(.secondary)
                }
                .swipeActions {
                    Button(role: .destructive) {
                        Task { await vm.deleteSpot(spot) }
                    } label: {
                        Label("Delete", systemImage: "trash")
                    }
                }
            }
        } header: {
            if let track = vm.selectedTrack {
                Text("\(vm.spots.count + vm.localRecordings.count) spots on \(track.name)")
            }
        } footer: {
            Text("Walk, drive, or hike — record what you know at each stop. Once uploaded, turn the track on to hear your stories where you made them.")
        }
    }
}

/// The big red button: tap to start, tap to stop, pulsing with mic level and
/// showing the running clock while a take rolls.
private struct RecordButton: View {
    @ObservedObject var engine: RecordingEngine
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 8) {
                ZStack {
                    Circle()
                        .fill(Color.red.opacity(0.15 + 0.5 * engine.level))
                        .frame(width: 96, height: 96)
                        .animation(.linear(duration: 0.1), value: engine.level)
                    if engine.isRecording {
                        RoundedRectangle(cornerRadius: 6)
                            .fill(.red)
                            .frame(width: 34, height: 34)
                    } else {
                        Circle()
                            .fill(.red)
                            .frame(width: 72, height: 72)
                    }
                }
                Text(engine.isRecording
                     ? Duration.seconds(engine.elapsed).formatted(.time(pattern: .minuteSecond))
                     : "Tap to record")
                    .font(engine.isRecording ? .title3.monospacedDigit().bold() : .subheadline)
                    .foregroundStyle(engine.isRecording ? .primary : .secondary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(engine.isRecording ? "Stop recording" : "Start recording")
    }
}
