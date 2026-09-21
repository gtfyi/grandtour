// Parity runner: replays the TS golden cases through the Swift AreaId.
import Foundation

struct Bounds: Decodable { let minLat, minLng, maxLat, maxLng: Double }
struct Case: Decodable {
    let lat, lng: Double
    let precision: Int
    let id: String
    let bounds: Bounds
    let neighbors: [String]
}

let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
let cases = try JSONDecoder().decode([Case].self, from: data)
var failures = 0
func fail(_ c: Case, _ what: String, _ ts: String, _ swift: String) {
    failures += 1
    if failures <= 10 { print("MISMATCH \(what) at \(c.lat),\(c.lng) p\(c.precision)\n  ts:    \(ts)\n  swift: \(swift)") }
}
for c in cases {
    let id = AreaId.encode(lat: c.lat, lng: c.lng, precision: c.precision)
    if id != c.id { fail(c, "id", c.id, id); continue }
    guard let b = AreaId.bounds(id) else { fail(c, "bounds", "\(c.bounds)", "nil"); continue }
    let close = { (a: Double, b: Double) in abs(a - b) < 1e-12 }
    if !(close(b.minLat, c.bounds.minLat) && close(b.minLng, c.bounds.minLng)
         && close(b.maxLat, c.bounds.maxLat) && close(b.maxLng, c.bounds.maxLng)) {
        fail(c, "bounds", "\(c.bounds)", "\(b)")
    }
    let n = AreaId.neighbors(id)
    if n != c.neighbors { fail(c, "neighbors", c.neighbors.joined(separator: ","), n.joined(separator: ",")) }
}
print("\(cases.count - failures)/\(cases.count) cases match")
exit(failures == 0 ? 0 : 1)
