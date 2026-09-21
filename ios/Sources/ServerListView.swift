import SwiftUI

/// Pick which GrandTour server the app talks to, and manage the list.
/// The built-in entry is the build's default and can't be edited or removed;
/// user-added ones can. Selecting a server takes effect immediately
/// (ServerPreference.didChange reloads the tour).
struct ServerListView: View {
    @State private var servers = ServerPreference.servers
    @State private var selectedId = ServerPreference.selectedId
    @State private var adding = false

    var body: some View {
        List {
            Section {
                ForEach(servers) { server in
                    HStack {
                        Button {
                            ServerPreference.select(server.id)
                            selectedId = ServerPreference.selectedId
                        } label: {
                            HStack {
                                VStack(alignment: .leading) {
                                    Text(server.name).foregroundStyle(.primary)
                                    Text(server.url.absoluteString)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                if server.id == selectedId {
                                    Image(systemName: "checkmark").foregroundStyle(.tint)
                                }
                            }
                        }
                        if !ServerPreference.isBuiltIn(server) {
                            NavigationLink {
                                ServerFormView(existing: server) { reload() }
                            } label: {
                                EmptyView()
                            }
                            .frame(width: 0)
                            .opacity(0)
                            Image(systemName: "info.circle").foregroundStyle(.tint)
                        }
                    }
                }
                .onDelete { offsets in
                    for i in offsets where !ServerPreference.isBuiltIn(servers[i]) {
                        ServerPreference.remove(servers[i].id)
                    }
                    reload()
                }
            } footer: {
                Text("A server is any address that serves GrandTour's track list: grandtour.fyi, a GitHub repository (github.com/org/repo), or a machine running GrandTour, such as a dev box over Tailscale (http://100.x.y.z:8787). Switching reloads tracks and stops the tour.")
            }
            Section {
                Button {
                    adding = true
                } label: {
                    Label("Add server", systemImage: "plus")
                }
            }
        }
        .navigationTitle("Servers")
        .sheet(isPresented: $adding) {
            NavigationStack {
                ServerFormView(existing: nil) { reload() }
            }
        }
        .onAppear(perform: reload)
    }

    private func reload() {
        servers = ServerPreference.servers
        selectedId = ServerPreference.selectedId
    }
}

/// Add or edit a server: a name and an http(s) URL.
struct ServerFormView: View {
    let existing: GrandTourServer?
    let onSave: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var urlText: String
    @State private var selectAfterSave = true

    init(existing: GrandTourServer?, onSave: @escaping () -> Void) {
        self.existing = existing
        self.onSave = onSave
        _name = State(initialValue: existing?.name ?? "")
        _urlText = State(initialValue: existing?.url.absoluteString ?? "")
    }

    private var parsedURL: URL? { GrandTourServer.parseURL(urlText) }

    var body: some View {
        Form {
            Section {
                TextField("Name", text: $name)
                TextField("grandtour.fyi, github.com/org/repo, or http://host:8787", text: $urlText)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            } footer: {
                if !urlText.isEmpty, parsedURL == nil {
                    Text("Enter a site, a GitHub repository, or an http(s) address.").foregroundStyle(.red)
                }
            }
            if existing == nil {
                Section {
                    Toggle("Use this server now", isOn: $selectAfterSave)
                }
            }
        }
        .navigationTitle(existing == nil ? "Add Server" : "Edit Server")
        .toolbar {
            if existing == nil {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") { save() }.disabled(parsedURL == nil)
            }
        }
    }

    private func save() {
        guard let url = parsedURL else { return }
        if var server = existing {
            server.name = name.trimmingCharacters(in: .whitespaces).isEmpty ? (url.host ?? url.absoluteString) : name
            server.url = url
            ServerPreference.update(server)
        } else {
            let server = ServerPreference.add(name: name, url: url)
            if selectAfterSave { ServerPreference.select(server.id) }
        }
        onSave()
        dismiss()
    }
}
