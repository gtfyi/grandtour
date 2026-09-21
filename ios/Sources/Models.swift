import Foundation

// MARK: - Geo

struct LngLat: Codable, Hashable {
    let lat: Double
    let lng: Double
}

struct GeoTrigger: Codable {
    /// "point" (arrive → play; the default for pre-kind cached data), "area"
    /// (anywhere inside the `region` fence, gap-scheduled), or a future kind
    /// this build doesn't know — treated as point so decoding never fails.
    let kind: String?
    /// Present for every kind the server serves today (area = fence centroid,
    /// a representative point for maps/sorting — not trigger math).
    let center: LngLat
    let radiusM: Double
    /// Point: optional precise boundary. Area: the fence itself.
    let region: [LngLat]?

    /// Ambient semantics: no arrival moment, no locating; played from the
    /// gap planner while inside the fence, never from the arrival scheduler.
    var isArea: Bool { kind == "area" }

    // Defaulted so pre-kind construction sites (tests, watch) stay valid.
    init(kind: String? = nil, center: LngLat, radiusM: Double, region: [LngLat]? = nil) {
        self.kind = kind
        self.center = center
        self.radiusM = radiusM
        self.region = region
    }
}

// MARK: - Content (filo document)

/// A byte range into the document text.
struct FiloAnnotation: Codable {
    let start: Int
    let end: Int
    let kind: String
    let payload: [String: AnyCodable]
}

struct FiloTier: Codable {
    let id: String
    let kind: String
    let annotations: [FiloAnnotation]
}

struct FiloDocument: Codable {
    let id: String
    let text: String
    let byteLength: Int
    let tiers: [FiloTier]

    /// Audio segments (byte range + timing) for highlight-as-you-listen.
    var audioSegments: [AudioSegment] {
        guard let tier = tiers.first(where: { $0.id == "audio" || $0.kind == "audio" }) else { return [] }
        return tier.annotations.compactMap { a in
            guard let startMs = a.payload["startMs"]?.doubleValue,
                  let endMs = a.payload["endMs"]?.doubleValue else { return nil }
            return AudioSegment(byteStart: a.start, byteEnd: a.end, startMs: startMs, endMs: endMs)
        }
        .sorted { $0.startMs < $1.startMs }
    }
}

struct AudioSegment: Identifiable {
    let id = UUID()
    let byteStart: Int
    let byteEnd: Int
    let startMs: Double
    let endMs: Double
}

/// Per-asset licence verdict — mirrors `SourceRef.clearance` in the shared
/// zod schema. A source can be `confirmed` clear for its text but `unclear`
/// for its audio (an NPS tour whose narration is federal work but whose
/// audio blends a named third party's field recordings).
struct SourceClearance: Codable {
    let scope: String?
    let status: String
    let license: String?
    let reviewedBy: String?
    let reviewedAt: String?
    let note: String?
}

/// A work this content drew on or came from — enough to credit it and to
/// answer "may we reuse this?" without leaving the record. Mirrors
/// `SourceRef` in `@grandtour/shared`.
struct GenerationSource: Codable {
    let name: String?
    let url: String?
    let sourceDescription: String?
    let publisher: String?
    let license: String?
    let attribution: String?
    let date: String?
    let clearance: [SourceClearance]?

    // Pre-SourceRef cached data only ever had `{ title, url }`; the server
    // accepts and reads that shape as `name` too (LegacySourceRef).
    private enum CodingKeys: String, CodingKey {
        case name, title, url, sourceDescription = "description", publisher, license, attribution, date, clearance
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decodeIfPresent(String.self, forKey: .name)
            ?? c.decodeIfPresent(String.self, forKey: .title)
        url = try c.decodeIfPresent(String.self, forKey: .url)
        sourceDescription = try c.decodeIfPresent(String.self, forKey: .sourceDescription)
        publisher = try c.decodeIfPresent(String.self, forKey: .publisher)
        license = try c.decodeIfPresent(String.self, forKey: .license)
        attribution = try c.decodeIfPresent(String.self, forKey: .attribution)
        date = try c.decodeIfPresent(String.self, forKey: .date)
        clearance = try c.decodeIfPresent([SourceClearance].self, forKey: .clearance)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(name, forKey: .name)
        try c.encodeIfPresent(url, forKey: .url)
        try c.encodeIfPresent(sourceDescription, forKey: .sourceDescription)
        try c.encodeIfPresent(publisher, forKey: .publisher)
        try c.encodeIfPresent(license, forKey: .license)
        try c.encodeIfPresent(attribution, forKey: .attribution)
        try c.encodeIfPresent(date, forKey: .date)
        try c.encodeIfPresent(clearance, forKey: .clearance)
    }

    /// Display label, since legacy rows only ever had `title`.
    var displayName: String { name ?? "Source" }
}

struct GenerationProvenance: Codable {
    let model: String?
    let sources: [GenerationSource]
    /// The work this content *is* when it was imported rather than written
    /// here (an NPS tour, a newspaper column) — the one that carries the
    /// licence this content is published under. Distinct from `sources`
    /// (what a script consulted while drafting).
    let origin: GenerationSource?
}

struct ContentPiece: Codable {
    let id: String
    let locale: String
    let variant: String
    let document: FiloDocument?
    let audioUrl: String?
    let durationMs: Double?
    let source: String
    let provenance: GenerationProvenance?
}

// MARK: - Tracks, spots, nearby

struct Track: Codable, Identifiable, Hashable {
    let id: String
    let slug: String
    let name: String
    let description: String
    /// "tour" (geo-triggered spots) or "fillin" (gap-filler items). Optional
    /// so pre-kind cached tracks.json still decodes; missing means tour.
    let kind: String?
    /// "evergreen" (replayable forever; the default for old data) or
    /// "series" (heard-once units, auto-disable when fully played).
    let lifecycle: String?
    let icon: String?
    let color: String?
    let official: Bool
    /// Published totals from the catalog. Optional for older servers/caches.
    let spotCount: Int?
    let itemCount: Int?

    var isFillIn: Bool { kind == "fillin" }
    var isSeries: Bool { lifecycle == "series" }

    var countLabel: String {
        let count = isFillIn ? itemCount : spotCount
        let unit = isFillIn ? "item" : "spot"
        guard let count else { return "\(unit.capitalized) count unavailable" }
        return "\(count.formatted()) \(unit)\(count == 1 ? "" : "s")"
    }

    // Defaulted so pre-lifecycle construction sites stay valid.
    init(
        id: String,
        slug: String,
        name: String,
        description: String,
        kind: String?,
        lifecycle: String? = nil,
        icon: String?,
        color: String?,
        official: Bool,
        spotCount: Int? = nil,
        itemCount: Int? = nil
    ) {
        self.id = id
        self.slug = slug
        self.name = name
        self.description = description
        self.kind = kind
        self.lifecycle = lifecycle
        self.icon = icon
        self.color = color
        self.official = official
        self.spotCount = spotCount
        self.itemCount = itemCount
    }
}

/// Ordered-story membership: parts sharing a key auto-play in index order.
struct SpotSequence: Codable, Hashable {
    let key: String
    let index: Int
}

struct Spot: Codable, Identifiable {
    let id: String
    let trackId: String
    let title: String
    let subtitle: String
    let trigger: GeoTrigger
    let sequence: SpotSequence?
    let modes: [String]
    let status: String
    /// Only the anchor is decoded from the server's locating object; the
    /// template/clips stay server-side concerns.
    let locating: SpotLocating?

    // Defaulted so pre-sequence construction sites stay valid.
    init(
        id: String,
        trackId: String,
        title: String,
        subtitle: String,
        trigger: GeoTrigger,
        sequence: SpotSequence? = nil,
        modes: [String],
        status: String,
        locating: SpotLocating?
    ) {
        self.id = id
        self.trackId = trackId
        self.title = title
        self.subtitle = subtitle
        self.trigger = trigger
        self.sequence = sequence
        self.modes = modes
        self.status = status
        self.locating = locating
    }
}

/// The slice of `spot.locating` the app uses: the authored anchor text that
/// the deterministic locator appends ("at the corner of X and Y").
struct SpotLocating: Codable {
    let anchor: String?
}

struct Guide: Codable {
    let id: String
    let name: String
    let bio: String
    let bookingUrl: String?
    let contactEmail: String?
}

/// Where-to-look instruction, already resolved for this traveler's heading.
struct LocatingResolved: Codable {
    let text: String
    let audioUrl: String?
    let durationMs: Double?
}

struct NearbySpot: Codable, Identifiable {
    var id: String { spot.id }
    let spot: Spot
    let track: Track
    /// Played/shown before the narration; nil when disabled or heading unknown.
    let locating: LocatingResolved?
    let distanceM: Double
    let triggered: Bool
    let content: ContentPiece?
    let guide: Guide?

    /// True when there's something to narrate: a recorded clip, or text the
    /// on-device voice can speak instead.
    var isNarratable: Bool {
        content?.audioUrl != nil || content?.document?.text.isEmpty == false
    }
}

// MARK: - Fill-in items (non-location-anchored gap fillers)

/// One meaning of a vocab word; a word worth knowing often has several.
struct VocabSense: Codable {
    let partOfSpeech: String?
    let definition: String
    let exampleSentence: String?
}

struct VocabPayload: Codable {
    let word: String
    let pronunciation: String?
    /// Curated sense first; narration covers all of them in order.
    let senses: [VocabSense]
}

/// A quiz item: question, recall pause, answers in payload order (rank order
/// for ranked questions), optional extra fact.
struct QuizPayload: Codable {
    /// Spoken as the intro beat ("Geography quiz.").
    let category: String
    let question: String
    let answers: [String]
    let note: String?
}

/// Module payload, decoded by shape (the two are disjoint: word/senses vs
/// question/answers). A payload from a module type this build doesn't know
/// decodes as `.unknown` instead of failing the whole items array — such an
/// item is still speakable from its content document.
enum FillInPayload: Codable {
    case vocab(VocabPayload)
    case quiz(QuizPayload)
    case unknown

    init(from decoder: Decoder) throws {
        if let v = try? VocabPayload(from: decoder) {
            self = .vocab(v)
        } else if let q = try? QuizPayload(from: decoder) {
            self = .quiz(q)
        } else {
            self = .unknown
        }
    }

    func encode(to encoder: Encoder) throws {
        switch self {
        case .vocab(let p): try p.encode(to: encoder)
        case .quiz(let p): try p.encode(to: encoder)
        case .unknown:
            // Round-trips through the disk cache as `.unknown` again.
            _ = encoder.container(keyedBy: CodingKeys.self)
        }
    }

    private enum CodingKeys: CodingKey {}

    /// What the item is about — list rows, now-playing, diagnostics.
    var displayTitle: String {
        switch self {
        case .vocab(let p): return p.word
        case .quiz(let p): return p.question
        case .unknown: return ""
        }
    }
}

/// One item of a fill-in track: content with no place, played when the tour
/// planner sees a gap in narration. Its `content` reuses ContentPiece, so it
/// plays through AudioPlayer exactly like a spot's narration (the think-time
/// pause is baked into the audio).
struct FillInItem: Codable, Identifiable {
    let id: String
    let trackId: String
    let moduleType: String
    let payload: FillInPayload
    let order: Int?
    let content: ContentPiece?
    let status: String

    /// Same bar as NearbySpot.isNarratable: recorded clip, or text for the
    /// on-device voice.
    var isNarratable: Bool {
        content?.audioUrl != nil || content?.document?.text.isEmpty == false
    }
}

// MARK: - Track manifest (/api/track-manifest)

/// One published, narratable unit of a track — a spot (tour) or item
/// (fill-in) id, with its sequence slot when it has one.
struct TrackManifestUnit: Codable {
    let id: String
    let sequenceKey: String?
    let sequenceIndex: Int?
}

/// A track's whole unit index, regardless of what's in range. Drives the two
/// jobs /nearby can't: sequence eligibility (are all earlier parts heard,
/// wherever they are?) and completion (played ∩ manifest, computed on-device
/// because play history never leaves the phone).
struct TrackManifest: Codable {
    let trackId: String
    let slug: String
    let lifecycle: String
    let contentUpdatedAt: String?
    let units: [TrackManifestUnit]

    var isSeries: Bool { lifecycle == "series" }
}

struct NearbyResponse: Codable {
    let spots: [NearbySpot]
    /// Newest change timestamp in range; send back as `changedSince` to poll cheaply.
    let dataVersion: String?
    /// True when nothing changed since `changedSince` — `spots` is empty
    /// because there's nothing new, not because the area is empty.
    let unchanged: Bool

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        spots = try c.decode([NearbySpot].self, forKey: .spots)
        dataVersion = try c.decodeIfPresent(String.self, forKey: .dataVersion)
        unchanged = try c.decodeIfPresent(Bool.self, forKey: .unchanged) ?? false
    }
}

// MARK: - AnyCodable (for filo payloads)

/// Minimal type-erased JSON value, enough to read numbers/strings from payloads.
struct AnyCodable: Codable {
    let value: Any

    var doubleValue: Double? {
        switch value {
        case let d as Double: return d
        case let i as Int: return Double(i)
        case let s as String: return Double(s)
        default: return nil
        }
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let d = try? c.decode(Double.self) { value = d }
        else if let s = try? c.decode(String.self) { value = s }
        else if let b = try? c.decode(Bool.self) { value = b }
        else { value = "" }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch value {
        case let d as Double: try c.encode(d)
        case let s as String: try c.encode(s)
        case let b as Bool: try c.encode(b)
        default: try c.encodeNil()
        }
    }
}
