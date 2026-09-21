// Parity runner: replays the TS golden cases through the Swift TriggerEvaluator.
import CoreLocation
import Foundation

struct Expect: Decodable { let triggered: Bool; let distanceM: Double }
struct Case: Decodable {
    let name: String
    let `where`: String
    let trigger: GeoTrigger
    let pos: LngLat
    let expect: Expect
}

let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
let cases = try JSONDecoder().decode([Case].self, from: data)
var failures = 0
for c in cases {
    let loc = CLLocation(latitude: c.pos.lat, longitude: c.pos.lng)
    let (triggered, d) = TriggerEvaluator.evaluate(c.trigger, at: loc)
    // Distances: the web uses haversine on a sphere, the phone CoreLocation's
    // geodesic — they agree within a few tenths of a percent.
    let tolerance = max(1.5, c.expect.distanceM * 0.005)
    let ok = triggered == c.expect.triggered && abs(d - c.expect.distanceM) <= tolerance
    if !ok {
        failures += 1
        if failures <= 10 {
            print("MISMATCH \(c.name) \(c.where)\n  ts:    triggered=\(c.expect.triggered) d=\(c.expect.distanceM)\n  swift: triggered=\(triggered) d=\(d)")
        }
    }
}
print("\(cases.count - failures)/\(cases.count) cases match")
exit(failures == 0 ? 0 : 1)
