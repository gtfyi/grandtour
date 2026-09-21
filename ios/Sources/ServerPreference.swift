import Foundation

/// A GrandTour server the app can talk to. The built-in one comes from the
/// build (`GrandTourAPIBaseURL` in Info.plist); the rest are user-added.
struct GrandTourServer: Codable, Identifiable, Equatable, Hashable {
    let id: UUID
    var name: String
    var url: URL

    /// Parse and normalize user input: a site (`grandtour.fyi`), a GitHub
    /// repository (`github.com/org/repo`), or an http(s) URL. A bare name
    /// gets `https://`, except a local machine, which gets `http://`; a
    /// trailing slash is dropped so path appends stay clean.
    static func parseURL(_ raw: String) -> URL? {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return nil }
        if !s.contains("://") {
            let host = s.split(separator: "/").first.map(String.init) ?? s
            let local = host.hasPrefix("localhost") || host.hasPrefix("127.0.0.1")
                || host.range(of: #"^\d{1,3}(\.\d{1,3}){3}(:\d+)?$"#, options: .regularExpression) != nil
            s = (local ? "http://" : "https://") + s
        }
        while s.hasSuffix("/") { s.removeLast() }
        guard let u = URL(string: s),
              let scheme = u.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = u.host, !host.isEmpty,
              Distribution.indexURL(for: s) != nil
        else { return nil }
        return u
    }
}

/// The list of known servers and which one is active. Global and user-set,
/// like NarrationPreference; every `GrandTourAPI()` reads the selection on
/// each request, so switching takes effect immediately. Listeners that hold
/// server-derived state (catalog, nearby, data version) should reload on
/// `didChange`.
enum ServerPreference {
    static let didChange = Notification.Name("GrandTourServerPreferenceDidChange")

    private static let serversKey = "grandtourServers"
    private static let selectedKey = "grandtourSelectedServer"
    /// Stable ids for the standing entries so a selection survives relaunch.
    private static let builtInId = UUID(uuidString: "00000000-0000-0000-0000-00000000B1D1")!
    private static let conventionalId = UUID(uuidString: "00000000-0000-0000-0000-00000000C0DE")!

    /// The conventional server every install can read: grandtour.fyi.
    static var conventional: GrandTourServer {
        GrandTourServer(id: conventionalId, name: "grandtour.fyi", url: URL(string: Distribution.conventionalServer)!)
    }

    /// The server this build was compiled against (`GrandTourAPIBaseURL` in
    /// Info.plist — a dev machine, a tailnet box), or nil when the build
    /// names none or names the conventional server itself.
    static var builtIn: GrandTourServer? {
        guard let url = (Bundle.main.object(forInfoDictionaryKey: "GrandTourAPIBaseURL") as? String)
            .flatMap(GrandTourServer.parseURL),
              url != conventional.url
        else { return nil }
        return GrandTourServer(id: builtInId, name: "Built-in", url: url)
    }

    /// User-added servers, persisted as JSON.
    private static var custom: [GrandTourServer] {
        get {
            guard let data = UserDefaults.standard.data(forKey: serversKey),
                  let list = try? JSONDecoder().decode([GrandTourServer].self, from: data)
            else { return [] }
            return list
        }
        set {
            UserDefaults.standard.set(try? JSONEncoder().encode(newValue), forKey: serversKey)
        }
    }

    /// The standing entries first — the build's own server when it has one,
    /// then grandtour.fyi — then user-added ones in the order they were created.
    static var servers: [GrandTourServer] { [builtIn].compactMap { $0 } + [conventional] + custom }

    /// A build that names a server starts on it (development, a tailnet box);
    /// everyone else starts on the conventional server.
    private static var defaultId: UUID { builtIn == nil ? conventionalId : builtInId }

    static var selectedId: UUID {
        get {
            UserDefaults.standard.string(forKey: selectedKey).flatMap(UUID.init(uuidString:)) ?? defaultId
        }
        set { UserDefaults.standard.set(newValue.uuidString, forKey: selectedKey) }
    }

    /// The active server; falls back to the default if the selection was removed.
    static var current: GrandTourServer {
        servers.first { $0.id == selectedId } ?? servers.first { $0.id == defaultId } ?? conventional
    }

    static var currentURL: URL { current.url }

    /// The standing entries cannot be edited or removed.
    static func isBuiltIn(_ server: GrandTourServer) -> Bool { server.id == builtInId || server.id == conventionalId }

    /// Make `id` the active server. No-op (no notification) if unchanged.
    static func select(_ id: UUID) {
        guard id != selectedId, servers.contains(where: { $0.id == id }) else { return }
        selectedId = id
        notify()
    }

    @discardableResult
    static func add(name: String, url: URL) -> GrandTourServer {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        let server = GrandTourServer(id: UUID(), name: trimmed.isEmpty ? (url.host ?? url.absoluteString) : trimmed, url: url)
        custom.append(server)
        return server
    }

    /// Edit a user-added server. If it's the active one, listeners reload.
    static func update(_ server: GrandTourServer) {
        guard !isBuiltIn(server) else { return }
        var list = custom
        guard let i = list.firstIndex(where: { $0.id == server.id }) else { return }
        let urlChanged = list[i].url != server.url
        list[i] = server
        custom = list
        if urlChanged, server.id == selectedId { notify() }
    }

    /// Remove a user-added server. Removing the active one falls back to
    /// the default.
    static func remove(_ id: UUID) {
        guard id != builtInId, id != conventionalId else { return }
        custom.removeAll { $0.id == id }
        if selectedId == id {
            selectedId = defaultId
            notify()
        }
    }

    private static func notify() {
        NotificationCenter.default.post(name: didChange, object: nil)
    }
}
