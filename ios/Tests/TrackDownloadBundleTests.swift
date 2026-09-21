import XCTest

final class TrackDownloadBundleTests: XCTestCase {
    private func piece(_ id: String, locale: String = "en", audio: String? = nil, updatedAt: String = "2026-09-01T00:00:00.000Z") -> [String: Any] {
        [
            "id": id, "locale": locale, "variant": id,
            "document": ["id": id, "text": "A story", "byteLength": 7, "tiers": []],
            "audioUrl": audio as Any? ?? NSNull(), "durationMs": 1000,
            "source": "human", "provenance": NSNull(), "updatedAt": updatedAt,
        ]
    }

    private func track(kind: String = "tour") -> [String: Any] {
        ["id": "track", "slug": "whole-track", "name": "Whole track", "description": "", "kind": kind, "lifecycle": "series", "official": true]
    }

    private func tourJSON() -> [String: Any] {
        func clip(_ side: String) -> [String: Any] {
            ["text": "Look \(side)", "audioUrl": "https://example.com/\(side).mp3", "durationMs": 500]
        }
        return [
            "exportedAt": "2026-09-07T12:00:00.000Z", "track": track(),
            "spots": [[
                "spot": [
                    "id": "far-away-spot", "trackId": "track", "title": "Far away", "subtitle": "",
                    "trigger": ["kind": "point", "center": ["lat": 1, "lng": 170], "radiusM": 100],
                    "sequence": ["key": "chapter", "index": 8], "modes": ["walking"], "status": "published",
                    "updatedAt": "2026-09-05T00:00:00.000Z",
                    "locating": ["mode": "auto", "anchor": "at the tower", "clips": ["left": clip("left"), "right": clip("right"), "fixed": clip("fixed")]],
                ],
                "content": [
                    piece("english-text", updatedAt: "2026-09-07T00:00:00.000Z"),
                    piece("spanish", locale: "es", audio: "https://example.com/es.mp3"),
                    piece("english-old", audio: "https://example.com/old.mp3"),
                    piece("english-new", audio: "https://example.com/new.mp3", updatedAt: "2026-09-06T00:00:00.000Z"),
                    piece("duplicate-audio", locale: "fr", audio: "https://example.com/es.mp3"),
                ],
            ]],
        ]
    }

    private func decode(_ object: [String: Any]) throws -> TrackDownloadBundle {
        try JSONDecoder().decode(TrackDownloadBundle.self, from: JSONSerialization.data(withJSONObject: object))
    }

    func testWholeTrackKeepsEveryVariantAndLocatingClipAcrossDiskRoundTrip() throws {
        let bundle = try decode(tourJSON())
        let restored = try JSONDecoder().decode(TrackDownloadBundle.self, from: JSONEncoder().encode(bundle))
        XCTAssertEqual(restored.spots.count, 1)
        XCTAssertEqual(restored.spots[0].content.count, 5)
        XCTAssertEqual(Set(restored.audioURLs), Set(["es", "old", "new", "left", "right", "fixed"].map { "https://example.com/\($0).mp3" }))
        XCTAssertEqual(restored.nearbySpots[0].content?.id, "english-new")
        XCTAssertEqual(restored.nearbySpots[0].spot.trigger.center.lng, 170)
        XCTAssertEqual(restored.nearbySpots[0].spot.modes, ["walking"])
        XCTAssertEqual(restored.nearbySpots[0].spot.locating?.anchor, "at the tower")
        XCTAssertNil(restored.nearbySpots[0].locating, "A downloaded track cannot guess the traveler's future heading")
        XCTAssertEqual(restored.manifest.units.map(\.id), ["far-away-spot"])
        XCTAssertEqual(restored.manifest.units[0].sequenceKey, "chapter")
        XCTAssertEqual(restored.manifest.units[0].sequenceIndex, 8)
        XCTAssertEqual(restored.manifest.contentUpdatedAt, "2026-09-07T00:00:00.000Z")
    }

    func testLocatingResolvesOnlyFromCurrentHeadingAndPreservesFixedClip() throws {
        let locating = try XCTUnwrap(decode(tourJSON()).spots[0].locating)
        XCTAssertNil(locating.resolve(courseDeg: nil, bearingDeg: 90))
        XCTAssertNil(locating.resolve(courseDeg: -1, bearingDeg: 90))
        XCTAssertEqual(locating.resolve(courseDeg: 0, bearingDeg: 90)?.audioUrl, "https://example.com/right.mp3")
        XCTAssertEqual(locating.resolve(courseDeg: 0, bearingDeg: 270)?.audioUrl, "https://example.com/left.mp3")
        XCTAssertEqual(locating.resolve(courseDeg: 350, bearingDeg: 10)?.text, "Look to your right.")
        let fixed = TrackDownloadLocating(mode: "custom", template: "Look at the tower.", clips: locating.clips)
        XCTAssertEqual(fixed.resolve(courseDeg: nil, bearingDeg: nil)?.audioUrl, "https://example.com/fixed.mp3")
        XCTAssertNil(TrackDownloadLocating(mode: "none", clips: locating.clips).resolve(courseDeg: 0, bearingDeg: 90))
    }

    func testFillInBundleRejectsMissingOrNullCompleteItemsField() throws {
        var json: [String: Any] = ["exportedAt": "2026-09-07T00:00:00.000Z", "track": track(kind: "fillin"), "spots": []]
        XCTAssertThrowsError(try decode(json))
        json["fillInItems"] = NSNull()
        XCTAssertThrowsError(try decode(json))
        json["fillInItems"] = []
        XCTAssertEqual(try decode(json).fillInItems.count, 0)
    }

    func testCompleteFillInBundleExceedsOnlineSampleLimitAndKeepsManifest() throws {
        let items: [[String: Any]] = (0..<2001).map { index in
            [
                "id": "item-\(index)", "trackId": "track", "moduleType": "future-module", "payload": [:],
                "order": index, "status": "published", "updatedAt": "2026-09-06T00:00:00.000Z",
                "content": piece("content-\(index)", audio: "https://example.com/\(index).mp3"),
            ]
        }
        let bundle = try decode([
            "exportedAt": "2026-09-07T00:00:00.000Z", "track": track(kind: "fillin"), "spots": [], "fillInItems": items,
        ])
        let restored = try JSONDecoder().decode(TrackDownloadBundle.self, from: JSONEncoder().encode(bundle))
        XCTAssertEqual(restored.fillInItems.count, 2001)
        XCTAssertEqual(restored.audioURLs.count, 2001)
        XCTAssertEqual(restored.manifest.units.count, 2001)
        XCTAssertEqual(restored.manifest.contentUpdatedAt, "2026-09-06T00:00:00.000Z")
    }
}
