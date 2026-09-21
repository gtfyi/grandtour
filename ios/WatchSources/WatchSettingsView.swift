import SwiftUI

/// Tracks, voice, mode, and the before-you-go audio download.
struct WatchSettingsView: View {
    @ObservedObject private var engine = WatchAppServices.shared.engine
    @ObservedObject private var cache = WatchAudioCache.shared
    @State private var narration = NarrationPreference.current
    @State private var narrationGap = NarrationGapPreference.current
    @State private var prefetching = false
    @State private var servers = ServerPreference.servers
    @State private var selectedServer = ServerPreference.selectedId
    @State private var newServerURL = ""

    var body: some View {
        Form {
            Section("Tracks") {
                if engine.allTracks.isEmpty {
                    Text("No tracks loaded.")
                        .foregroundStyle(.secondary)
                }
                ForEach(engine.allTracks.filter { !$0.isFillIn }, id: \.id) { track in
                    Toggle(isOn: Binding(
                        get: { engine.enabledTrackSlugs.contains(track.slug) },
                        set: { on in
                            if on { engine.enabledTrackSlugs.insert(track.slug) }
                            else { engine.enabledTrackSlugs.remove(track.slug) }
                        }
                    )) {
                        VStack(alignment: .leading) {
                            Text(track.name)
                            Text(track.countLabel).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            Section {
                Picker("Server", selection: $selectedServer) {
                    ForEach(servers) { s in
                        Text(s.name).tag(s.id)
                    }
                }
                .onChange(of: selectedServer) { _, id in
                    ServerPreference.select(id)
                    selectedServer = ServerPreference.selectedId
                }
                TextField("Add http://host:8787", text: $newServerURL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .onSubmit {
                        guard let url = GrandTourServer.parseURL(newServerURL) else { return }
                        let added = ServerPreference.add(name: url.host ?? "", url: url)
                        servers = ServerPreference.servers
                        newServerURL = ""
                        selectedServer = added.id
                    }
            } header: {
                Text("Server")
            } footer: {
                Text(ServerPreference.currentURL.absoluteString)
            }
            Section("Mode") {
                Picker("Mode", selection: $engine.mode) {
                    Text("Walking").tag("walking")
                    Text("Hiking").tag("hiking")
                    Text("Cycling").tag("cycling")
                }
            }
            Section("Narration") {
                Picker("Pause between stories", selection: $narrationGap) {
                    ForEach(NarrationGapPreference.allCases, id: \.self) { pref in
                        Text(pref.label).tag(pref)
                    }
                }
                .onChange(of: narrationGap) { _, value in NarrationGapPreference.current = value }
                Picker("Voice", selection: $narration) {
                    ForEach(NarrationPreference.allCases, id: \.self) { p in
                        Text(p.label).tag(p)
                    }
                }
                .onChange(of: narration) { _, newValue in
                    NarrationPreference.current = newValue
                    engine.player.stop()
                }
            }
            Section {
                Button {
                    prefetching = true
                    Task {
                        await engine.prefetchNearbyAudio()
                        prefetching = false
                    }
                } label: {
                    if let p = cache.progress {
                        Label("\(p.done)/\(p.total) downloaded", systemImage: "arrow.down.circle")
                    } else {
                        Label("Download nearby audio", systemImage: "arrow.down.circle")
                    }
                }
                .disabled(prefetching)
            } footer: {
                Text("Grabs stories within 5 km so the tour plays without a connection.")
            }
        }
        .navigationTitle("Settings")
    }
}
