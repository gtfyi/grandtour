import Foundation

/// The distribution convention — the Swift mirror of `distribution.ts` in
/// @grandtour/shared.
///
/// A GrandTour *server* is any base URL that serves an index file and the
/// bundles it points to: a website, a GitHub repository served raw, a
/// folder, or the authoring server. The index says where the tours live;
/// the tours say where the data lives (audio by absolute URL, never
/// rewritten). Nothing else is required of a server.
enum Distribution {
    static let indexFile = "grandtour.json"
    static let toursDir = "tours"
    /// The conventional server: what a fresh install reads.
    static let conventionalServer = "https://grandtour.fyi"

    /// Where a server's index is, from however the user named the server —
    /// `grandtour.fyi`, `https://example.org/tours/`, `http://localhost:8787`,
    /// a GitHub repository (`github.com/gtfyi/content`, read raw from its
    /// default branch or the branch and folder of a `/tree/` link), or an
    /// explicit `.json` URL. Mirrors `indexUrl()`; nil when it names nothing.
    static func indexURL(for server: String) -> URL? {
        var s = server.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return nil }
        if s.range(of: #"^[A-Za-z][A-Za-z0-9+.-]*://"#, options: .regularExpression) == nil {
            s = "https://" + s
        }
        guard var comps = URLComponents(string: s), let host = comps.host?.lowercased(), !host.isEmpty,
              let scheme = comps.scheme?.lowercased(), scheme == "http" || scheme == "https"
        else { return nil }
        if host == "github.com" || host == "www.github.com" {
            let parts = comps.path.split(separator: "/").map(String.init)
            guard parts.count >= 2 else { return nil }
            let owner = parts[0]
            let repo = parts[1].hasSuffix(".git") ? String(parts[1].dropLast(4)) : parts[1]
            let isTree = parts.count >= 4 && parts[2] == "tree"
            let ref = isTree ? parts[3] : "main"
            let dir = isTree ? parts.dropFirst(4).joined(separator: "/") : ""
            return URL(string: "https://raw.githubusercontent.com/\(owner)/\(repo)/\(ref)/\(dir.isEmpty ? "" : dir + "/")\(indexFile)")
        }
        if comps.path.hasSuffix(".json") {
            return comps.url
        }
        if !comps.path.hasSuffix("/") { comps.path += "/" }
        comps.query = nil
        comps.fragment = nil
        guard let base = comps.url else { return nil }
        return URL(string: indexFile, relativeTo: base)?.absoluteURL
    }

    /// A track's bundle URL: `url` is absolute, or relative to the index.
    static func trackURL(_ track: IndexTrack, index: URL) -> URL? {
        URL(string: track.url, relativeTo: index)?.absoluteURL
    }

    /// Where a bundle lives when the index did not say (the conventional layout).
    static func defaultTrackURL(slug: String, index: URL) -> URL? {
        URL(string: "\(toursDir)/\(slug).grandtour.json", relativeTo: index)?.absoluteURL
    }
}

/// One entry of a server's index (`IndexTrack` in @grandtour/shared).
struct IndexTrack: Codable {
    let id: String
    let slug: String
    let name: String
    let description: String?
    let color: String?
    let icon: String?
    let lifecycle: String?
    let official: Bool?
    let visibility: String?
    /// The bundle, absolute or relative to the index's own URL.
    let url: String
    let spotCount: Int?
    let voicedCount: Int?
    let minutes: Double?
    let center: LngLat?
    let spanKm: Double?
    /// Every area cell the track's triggers touch — the selection key.
    let areas: [String]?
    let hash: String?
    let bytes: Int?
    let createdAt: String?

    /// The same track as the catalog would list it.
    var track: Track {
        Track(
            id: id, slug: slug, name: name, description: description ?? "",
            kind: "tour", lifecycle: lifecycle, icon: icon, color: color,
            official: official ?? false, spotCount: spotCount, itemCount: nil
        )
    }
}

/// A server's index (`Index` in @grandtour/shared).
struct GTIndex: Codable {
    let formatVersion: Int?
    let generatedAt: String?
    let name: String?
    let description: String?
    let tracks: [IndexTrack]

    var bySlug: [String: IndexTrack] {
        Dictionary(tracks.map { ($0.slug, $0) }, uniquingKeysWith: { a, _ in a })
    }
}
