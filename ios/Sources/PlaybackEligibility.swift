import Foundation

/// Whole-track rules shared by the phone and watch. Nearby snapshots cannot
/// establish chapter order: an unheard predecessor may be outside the window.
struct PlaybackEligibility {
    private struct Membership {
        let index: Int
        let members: [TrackManifestUnit]
    }
    private var membership: [String: Membership] = [:]
    private(set) var seriesUnitIds: Set<String> = []

    init(manifests: [TrackManifest] = []) {
        for manifest in manifests {
            if manifest.isSeries { seriesUnitIds.formUnion(manifest.units.map(\.id)) }
            let groups = Dictionary(grouping: manifest.units.filter { $0.sequenceKey != nil }, by: \.sequenceKey)
            for members in groups.values {
                for unit in members {
                    guard let index = unit.sequenceIndex else { continue }
                    // Arrays share storage: don't materialize every prefix
                    // of a long series (quadratic memory).
                    membership[unit.id] = Membership(index: index, members: members)
                }
            }
        }
    }

    /// Keep the phone's existing fallback: units missing from the manifest
    /// pass until the manifest arrives. No inferred order from nearby alone.
    func isSequenceEligible(_ id: String, playCount: (String) -> Int) -> Bool {
        guard let group = membership[id] else { return true }
        return group.members.allSatisfy {
            ($0.sequenceIndex ?? Int.max) >= group.index || playCount($0.id) > 0
        }
    }
}
