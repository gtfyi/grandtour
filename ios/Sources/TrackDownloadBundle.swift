import Foundation

/// A whole published track, with no location, mode, or sampling limits.
/// Keep every content variant and locating clip in the saved bundle even
/// though the nearby scheduler only selects one narration per spot.
struct TrackDownloadBundle: Codable {
    let exportedAt: String
    let track: Track
    let spots: [TrackDownloadSpot]
    let fillInItems: [FillInItem]
    /// The authored route through the spots, when the track has one (a road
    /// tour's seasonal alignment); a demo drives it rather than routing.
    let routePath: [LngLat]?
    private let fillInUpdatedAt: [String: String]

    init(exportedAt: String, track: Track, spots: [TrackDownloadSpot], fillInItems: [FillInItem] = [], routePath: [LngLat]? = nil) {
        self.exportedAt = exportedAt
        self.track = track
        self.spots = spots
        self.fillInItems = fillInItems
        self.routePath = routePath
        fillInUpdatedAt = [:]
    }

    private enum CodingKeys: String, CodingKey {
        case exportedAt, track, spots, fillInItems, fillInUpdatedAt, routePath
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        exportedAt = try c.decode(String.self, forKey: .exportedAt)
        track = try c.decode(Track.self, forKey: .track)
        spots = try c.decode([TrackDownloadSpot].self, forKey: .spots)
        routePath = try c.decodeIfPresent([LngLat].self, forKey: .routePath)
        // Older tour bundles legitimately have no fill-in field. An older
        // server's fill-in bundle, however, cannot prove the track is empty.
        if track.isFillIn && !c.contains(.fillInItems) {
            throw DecodingError.keyNotFound(CodingKeys.fillInItems, .init(
                codingPath: decoder.codingPath,
                debugDescription: "This server does not support complete fill-in track downloads."
            ))
        }
        fillInItems = track.isFillIn
            ? try c.decode([FillInItem].self, forKey: .fillInItems)
            : try c.decodeIfPresent([FillInItem].self, forKey: .fillInItems) ?? []
        struct ItemTimestamp: Decodable { let id: String; let updatedAt: String? }
        let timestamps = try c.decodeIfPresent([ItemTimestamp].self, forKey: .fillInItems) ?? []
        fillInUpdatedAt = try c.decodeIfPresent([String: String].self, forKey: .fillInUpdatedAt)
            ?? timestamps.reduce(into: [:]) { result, item in
                if let date = item.updatedAt { result[item.id] = date }
            }
    }

    /// All published recordings, regardless of narration voice preference.
    var audioURLs: [String] {
        let narrations = spots.flatMap { $0.content.compactMap { $0.piece.audioUrl } }
        let locating = spots.flatMap { $0.locating?.clips.values.map(\.audioUrl) ?? [] }
        let fillers = fillInItems.compactMap { $0.content?.audioUrl }
        return Array(Set(narrations + locating + fillers)).sorted()
    }

    var nearbySpots: [NearbySpot] {
        let locale = LocalePreference.locale(forTrack: track.slug)
        return spots.map { item in
            NearbySpot(
                spot: item.spot, track: track,
                locating: item.spot.trigger.isArea ? nil : item.locating?.resolve(courseDeg: nil, bearingDeg: nil),
                distanceM: 0, triggered: false,
                content: item.bestContent(locale: locale), guide: nil
            )
        }
    }

    /// Build the sequence/completion index from the same complete snapshot.
    /// The bar matches /track-manifest: a document or recorded audio exists.
    var manifest: TrackManifest {
        let narratableSpots = spots.filter { $0.content.contains { $0.piece.audioUrl != nil || $0.piece.document != nil } }
        let narratableItems = fillInItems.filter { $0.content?.audioUrl != nil || $0.content?.document != nil }
        let units = track.isFillIn
            ? narratableItems.map { TrackManifestUnit(id: $0.id, sequenceKey: nil, sequenceIndex: nil) }
            : narratableSpots.map {
                TrackManifestUnit(id: $0.spot.id, sequenceKey: $0.spot.sequence?.key, sequenceIndex: $0.spot.sequence?.index)
            }
        let dates = track.isFillIn
            ? narratableItems.compactMap { fillInUpdatedAt[$0.id] }
            : narratableSpots.flatMap { item in
                ([item.updatedAt] + item.content.map(\.updatedAt)).compactMap { $0 }
            }
        return TrackManifest(
            trackId: track.id, slug: track.slug, lifecycle: track.lifecycle ?? "evergreen",
            contentUpdatedAt: dates.max(), units: units
        )
    }
}

struct TrackDownloadContent: Codable {
    let piece: ContentPiece
    let updatedAt: String?

    init(piece: ContentPiece, updatedAt: String? = nil) {
        self.piece = piece
        self.updatedAt = updatedAt
    }

    private enum CodingKeys: String, CodingKey { case updatedAt }

    init(from decoder: Decoder) throws {
        piece = try ContentPiece(from: decoder)
        updatedAt = try decoder.container(keyedBy: CodingKeys.self).decodeIfPresent(String.self, forKey: .updatedAt)
    }

    func encode(to encoder: Encoder) throws {
        try piece.encode(to: encoder)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(updatedAt, forKey: .updatedAt)
    }
}

struct TrackDownloadSpot: Codable {
    let spot: Spot
    let content: [TrackDownloadContent]
    let locating: TrackDownloadLocating?
    let updatedAt: String?

    init(spot: Spot, content: [TrackDownloadContent], locating: TrackDownloadLocating? = nil, updatedAt: String? = nil) {
        self.spot = spot
        self.content = content
        self.locating = locating
        self.updatedAt = updatedAt
    }

    private enum CodingKeys: String, CodingKey { case spot, content }
    private enum SpotKeys: String, CodingKey { case locating, updatedAt }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        spot = try c.decode(Spot.self, forKey: .spot)
        content = try c.decode([TrackDownloadContent].self, forKey: .content)
        let metadata = try c.nestedContainer(keyedBy: SpotKeys.self, forKey: .spot)
        locating = try metadata.decodeIfPresent(TrackDownloadLocating.self, forKey: .locating)
        updatedAt = try metadata.decodeIfPresent(String.self, forKey: .updatedAt)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(content, forKey: .content)
        let spotEncoder = c.superEncoder(forKey: .spot)
        try spot.encode(to: spotEncoder)
        var metadata = spotEncoder.container(keyedBy: SpotKeys.self)
        try metadata.encodeIfPresent(locating, forKey: .locating)
        try metadata.encodeIfPresent(updatedAt, forKey: .updatedAt)
    }

    func bestContent(locale: String) -> ContentPiece? {
        content.sorted { a, b in
            if (a.piece.locale == locale) != (b.piece.locale == locale) { return a.piece.locale == locale }
            if (a.piece.audioUrl != nil) != (b.piece.audioUrl != nil) { return a.piece.audioUrl != nil }
            return (a.updatedAt ?? "") > (b.updatedAt ?? "")
        }.first?.piece
    }
}

/// Raw locating instructions must survive decoding: /nearby only supplies
/// the clip for one heading, but a full download needs both sides and fixed.
struct TrackDownloadLocating: Codable {
    struct Clip: Codable {
        let text: String
        let audioUrl: String
        let durationMs: Double
    }

    let mode: String
    let anchor: String?
    let template: String?
    let clips: [String: Clip]

    init(mode: String = "auto", anchor: String? = nil, template: String? = nil, clips: [String: Clip] = [:]) {
        self.mode = mode
        self.anchor = anchor
        self.template = template
        self.clips = clips
    }

    private enum CodingKeys: String, CodingKey { case mode, anchor, template, clips }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        mode = try c.decodeIfPresent(String.self, forKey: .mode) ?? "auto"
        anchor = try c.decodeIfPresent(String.self, forKey: .anchor)
        template = try c.decodeIfPresent(String.self, forKey: .template)
        clips = try c.decodeIfPresent([String: Clip].self, forKey: .clips) ?? [:]
    }

    func resolve(courseDeg: Double?, bearingDeg: Double?) -> LocatingResolved? {
        guard mode != "none" else { return nil }
        let text = mode == "custom" ? template?.trimmingCharacters(in: .whitespacesAndNewlines) : "Look to your {{side}}."
        guard let text, !text.isEmpty else { return nil }
        var key = "fixed"
        var resolved = text
        if text.contains("{{side}}") {
            guard let courseDeg, let bearingDeg, courseDeg >= 0, courseDeg.isFinite, bearingDeg.isFinite else { return nil }
            let relative = ((bearingDeg - courseDeg).truncatingRemainder(dividingBy: 360) + 360)
                .truncatingRemainder(dividingBy: 360)
            key = relative < 180 ? "right" : "left"
            resolved = text.replacingOccurrences(of: "{{side}}", with: key)
        }
        return LocatingResolved(text: resolved, audioUrl: clips[key]?.audioUrl, durationMs: clips[key]?.durationMs)
    }
}
