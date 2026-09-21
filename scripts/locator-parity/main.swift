// Parity runner: replays the TS golden cases through the Swift SpotLocator.
import Foundation

struct Case: Decodable {
    let spotLat, spotLng, userLat, userLng: Double
    let courseDeg: Double?
    let anchor: String?
    let metric: Bool
    let expect: String
}

let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
let cases = try JSONDecoder().decode([Case].self, from: data)
var failures = 0
for c in cases {
    let got = SpotLocator.describe(
        spotLat: c.spotLat, spotLng: c.spotLng,
        userLat: c.userLat, userLng: c.userLng,
        courseDeg: c.courseDeg, anchor: c.anchor, metric: c.metric
    )
    if got != c.expect {
        failures += 1
        if failures <= 10 {
            print("MISMATCH\n  ts:    \(c.expect)\n  swift: \(got)")
        }
    }
}
print("\(cases.count - failures)/\(cases.count) cases match")
exit(failures == 0 ? 0 : 1)
