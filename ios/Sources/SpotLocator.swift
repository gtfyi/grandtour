import Foundation

/// Deterministic spot locator — the Swift mirror of
/// `packages/shared/src/locate.ts`. Same tables, same formulas, byte-identical
/// output; the golden parity test (`scripts/locator-parity`) holds the two
/// together. Change one, change both.
///
/// Computed at *play time* from the freshest fix, so a narration that waited
/// in the queue still opens with a correct "Back 500 feet on your left" —
/// online or offline (pure math, no server).
enum SpotLocator {
    private static let earthR = 6_371_000.0

    static func haversineM(
        lat1: Double, lng1: Double, lat2: Double, lng2: Double
    ) -> Double {
        let rad = Double.pi / 180
        let dLat = (lat2 - lat1) * rad
        let dLng = (lng2 - lng1) * rad
        let a = sin(dLat / 2) * sin(dLat / 2)
            + cos(lat1 * rad) * cos(lat2 * rad) * sin(dLng / 2) * sin(dLng / 2)
        return 2 * earthR * asin(sqrt(a))
    }

    static func bearingDeg(
        userLat: Double, userLng: Double, spotLat: Double, spotLng: Double
    ) -> Double {
        let rad = Double.pi / 180
        let lat1 = userLat * rad
        let lat2 = spotLat * rad
        let dLng = (spotLng - userLng) * rad
        let y = sin(dLng) * cos(lat2)
        let x = cos(lat1) * sin(lat2) - sin(lat1) * cos(lat2) * cos(dLng)
        let deg = atan2(y, x) * 180 / .pi
        return (deg + 360).truncatingRemainder(dividingBy: 360)
    }

    enum Sector { case ahead, aheadRight, right, behindRight, behind, behindLeft, left, aheadLeft }

    static func sector(relDeg: Double) -> Sector {
        let r = (relDeg.truncatingRemainder(dividingBy: 360) + 360)
            .truncatingRemainder(dividingBy: 360)
        if r < 15 || r >= 345 { return .ahead }
        if r < 75 { return .aheadRight }
        if r < 105 { return .right }
        if r < 165 { return .behindRight }
        if r < 195 { return .behind }
        if r < 255 { return .behindLeft }
        if r < 285 { return .left }
        return .aheadLeft
    }

    /// "Ahead"/"behind" are corridors, not cones — see locate.ts. Those
    /// sectors additionally require the spot within `corridorM` of the line
    /// of travel; anything wider resolves to its side.
    static let corridorM = 10.0

    static func sector(relDeg: Double, distanceM: Double) -> Sector {
        let s = sector(relDeg: relDeg)
        if s != .ahead && s != .behind { return s }
        // Signed lateral offset from the course line: positive = right of it.
        let lateral = distanceM * sin(relDeg * .pi / 180)
        if abs(lateral) <= corridorM { return s }
        if s == .ahead { return lateral > 0 ? .aheadRight : .aheadLeft }
        return lateral > 0 ? .behindRight : .behindLeft
    }

    private static let winds = [
        "north", "northeast", "east", "southeast",
        "south", "southwest", "west", "northwest",
    ]

    static func cardinal(_ bearing: Double) -> String {
        let b = (bearing.truncatingRemainder(dividingBy: 360) + 360)
            .truncatingRemainder(dividingBy: 360)
        return winds[Int(((b + 22.5).truncatingRemainder(dividingBy: 360)) / 45)]
    }

    /// Rounding table — the parity contract with the TS side.
    static func distancePhrase(meters: Double, metric: Bool) -> String {
        if metric {
            if meters < 100 { return "\(Int((meters / 10).rounded()) * 10) meters" }
            let m = Int((meters / 50).rounded()) * 50
            if m < 1000 { return "\(m) meters" }
            return String(format: "%.1f kilometers", meters / 1000)
        }
        let ft = meters * 3.28084
        if ft < 100 { return "\(Int((ft / 10).rounded()) * 10) feet" }
        let f = Int((ft / 100).rounded()) * 100
        if f < 1000 { return "\(f) feet" }
        return String(format: "%.1f miles", ft / 5280)
    }

    private static func joinAnchor(_ phrase: String, _ anchor: String?) -> String {
        guard let a = anchor?.trimmingCharacters(in: .whitespaces), !a.isEmpty else {
            return "\(phrase)."
        }
        let prepositions = ["at ", "on ", "near ", "by ", "in ", "behind ", "across ", "opposite "]
        let lower = a.lowercased()
        let prepositional = prepositions.contains { lower.hasPrefix($0) }
        return prepositional ? "\(phrase), \(a)." : "\(phrase) — \(a)."
    }

    private static let hereM = 15.0

    /// The one-sentence locator. Same inputs → same text as the TS module.
    static func describe(
        spotLat: Double, spotLng: Double,
        userLat: Double, userLng: Double,
        courseDeg: Double?,
        anchor: String?,
        metric: Bool
    ) -> String {
        let d = haversineM(lat1: userLat, lng1: userLng, lat2: spotLat, lng2: spotLng)
        let bearing = bearingDeg(userLat: userLat, userLng: userLng, spotLat: spotLat, spotLng: spotLng)
        let dist = distancePhrase(meters: d, metric: metric)

        guard let course = courseDeg else {
            if d < hereM { return joinAnchor("Right here", anchor) }
            return joinAnchor("About \(dist) to the \(cardinal(bearing))", anchor)
        }

        let s = sector(relDeg: bearing - course, distanceM: d)

        if d < hereM {
            switch s {
            case .right: return joinAnchor("Right here on your right", anchor)
            case .left: return joinAnchor("Right here on your left", anchor)
            case .behind, .behindRight, .behindLeft:
                return joinAnchor("Right here, just behind you", anchor)
            default: return joinAnchor("Right here", anchor)
            }
        }

        switch s {
        case .ahead:
            return joinAnchor("Coming up in \(dist), straight ahead", anchor)
        case .aheadRight:
            return joinAnchor("Coming up in \(dist) on your right", anchor)
        case .aheadLeft:
            return joinAnchor("Coming up in \(dist) on your left", anchor)
        case .right:
            return joinAnchor("To your right, about \(dist) away", anchor)
        case .left:
            return joinAnchor("To your left, about \(dist) away", anchor)
        case .behindRight:
            return joinAnchor("Back \(dist) on your right", anchor)
        case .behindLeft:
            return joinAnchor("Back \(dist) on your left", anchor)
        case .behind:
            return joinAnchor("\(dist) behind you", anchor)
        }
    }
}
