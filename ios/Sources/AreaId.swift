import Foundation

/// Area cells — the Swift mirror of `area.ts` in @grandtour/shared.
///
/// An area is a geohash cell. The phone turns its own position into a cell
/// id, keeps the catalog tracks whose `areas` meet that cell and its
/// neighbours, and fetches those bundles; no coordinate ever leaves the
/// device. The TS and Swift implementations are pinned together by
/// scripts/area-parity — change both or neither.
enum AreaId {
    static let precision = 4
    private static let base32 = Array("0123456789bcdefghjkmnpqrstuvwxyz")

    struct Bounds: Equatable {
        let minLat: Double, minLng: Double, maxLat: Double, maxLng: Double
    }

    /// Longitude folded into [-180, 180).
    static func wrapLng(_ lng: Double) -> Double {
        (((lng + 180).truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360)) - 180
    }

    /// The cell containing a position.
    static func encode(lat: Double, lng: Double, precision: Int = AreaId.precision) -> String {
        var latLo = -90.0, latHi = 90.0, lngLo = -180.0, lngHi = 180.0
        let lng = wrapLng(lng)
        var out = "", bits = 0, ch = 0, even = true
        while out.count < precision {
            if even {
                let mid = (lngLo + lngHi) / 2
                if lng >= mid { ch = ch * 2 + 1; lngLo = mid } else { ch *= 2; lngHi = mid }
            } else {
                let mid = (latLo + latHi) / 2
                if lat >= mid { ch = ch * 2 + 1; latLo = mid } else { ch *= 2; latHi = mid }
            }
            even.toggle()
            bits += 1
            if bits == 5 { out.append(base32[ch]); bits = 0; ch = 0 }
        }
        return out
    }

    /// The cell's bounding box; nil for an invalid id.
    static func bounds(_ id: String) -> Bounds? {
        var latLo = -90.0, latHi = 90.0, lngLo = -180.0, lngHi = 180.0, even = true
        for c in id {
            guard let v = base32.firstIndex(of: c) else { return nil }
            var mask = 16
            while mask > 0 {
                if even {
                    let mid = (lngLo + lngHi) / 2
                    if v & mask != 0 { lngLo = mid } else { lngHi = mid }
                } else {
                    let mid = (latLo + latHi) / 2
                    if v & mask != 0 { latLo = mid } else { latHi = mid }
                }
                even.toggle()
                mask >>= 1
            }
        }
        return Bounds(minLat: latLo, minLng: lngLo, maxLat: latHi, maxLng: lngHi)
    }

    static func center(_ id: String) -> (lat: Double, lng: Double)? {
        guard let b = bounds(id) else { return nil }
        return ((b.minLat + b.maxLat) / 2, (b.minLng + b.maxLng) / 2)
    }

    /// The (up to eight) cells touching `id`, sorted. Fewer at the poles.
    static func neighbors(_ id: String) -> [String] {
        guard let b = bounds(id), let c = center(id) else { return [] }
        let dLat = b.maxLat - b.minLat
        let dLng = b.maxLng - b.minLng
        var out = Set<String>()
        for dy in [-1.0, 0.0, 1.0] {
            let lat = c.lat + dy * dLat
            if lat > 90 || lat < -90 { continue }
            for dx in [-1.0, 0.0, 1.0] {
                if dx == 0 && dy == 0 { continue }
                out.insert(encode(lat: lat, lng: c.lng + dx * dLng, precision: id.count))
            }
        }
        out.remove(id)
        return out.sorted()
    }

    /// The cell a traveler is in, then its neighbours: what the phone asks for.
    static func around(lat: Double, lng: Double, precision: Int = AreaId.precision) -> [String] {
        let home = encode(lat: lat, lng: lng, precision: precision)
        return [home] + neighbors(home)
    }
}
