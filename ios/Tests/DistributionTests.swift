import XCTest
@testable import GrandTour

/// Mirrors packages/shared/tests/distribution.test.ts: the two sides must
/// name the same index for the same server spelling.
final class DistributionTests: XCTestCase {
    func testBareHostOriginFolderAndDevServerNameTheirIndex() {
        XCTAssertEqual(Distribution.indexURL(for: "grandtour.fyi")?.absoluteString, "https://grandtour.fyi/grandtour.json")
        XCTAssertEqual(Distribution.indexURL(for: "https://grandtour.fyi")?.absoluteString, "https://grandtour.fyi/grandtour.json")
        XCTAssertEqual(Distribution.indexURL(for: " https://example.org/tours ")?.absoluteString, "https://example.org/tours/grandtour.json")
        XCTAssertEqual(Distribution.indexURL(for: "http://localhost:8787")?.absoluteString, "http://localhost:8787/grandtour.json")
        XCTAssertEqual(Distribution.indexURL(for: "http://100.80.32.94:8787/?x=1#y")?.absoluteString, "http://100.80.32.94:8787/grandtour.json")
    }

    func testGitHubRepositoriesAreReadRaw() {
        XCTAssertEqual(Distribution.indexURL(for: "github.com/gtfyi/content")?.absoluteString,
                       "https://raw.githubusercontent.com/gtfyi/content/main/grandtour.json")
        XCTAssertEqual(Distribution.indexURL(for: "https://github.com/gtfyi/content.git")?.absoluteString,
                       "https://raw.githubusercontent.com/gtfyi/content/main/grandtour.json")
        XCTAssertEqual(Distribution.indexURL(for: "https://github.com/gtfyi/content/tree/dev/marin")?.absoluteString,
                       "https://raw.githubusercontent.com/gtfyi/content/dev/marin/grandtour.json")
        XCTAssertNil(Distribution.indexURL(for: "github.com/gtfyi"))
    }

    func testExplicitIndexFileAndGarbage() {
        XCTAssertEqual(Distribution.indexURL(for: "https://example.org/anything/index.json")?.absoluteString, "https://example.org/anything/index.json")
        XCTAssertNil(Distribution.indexURL(for: ""))
        XCTAssertNil(Distribution.indexURL(for: "ftp://example.org"))
    }

    func testIndexDecodesAndMapsToTracks() throws {
        let json = """
        {"formatVersion":1,"generatedAt":"2026-09-19T00:00:00.000Z","name":"GrandTour","tracks":[
          {"id":"00000000-0000-4000-8000-000000000001","slug":"history","name":"History","description":"Stories.",
           "color":"#8B5E3C","lifecycle":"evergreen","official":true,"url":"tours/history.grandtour.json",
           "spotCount":169,"voicedCount":169,"minutes":179.1,"center":{"lat":37.99,"lng":-122.33},"spanKm":8227,
           "areas":["9q8x","9q8z"],"hash":"\(String(repeating: "a", count: 64))","bytes":1,"createdAt":"2026-01-01T00:00:00.000Z"}]}
        """
        let index = try JSONDecoder().decode(GTIndex.self, from: Data(json.utf8))
        XCTAssertEqual(index.tracks.count, 1)
        let entry = try XCTUnwrap(index.bySlug["history"])
        XCTAssertEqual(entry.areas, ["9q8x", "9q8z"])
        let track = entry.track
        XCTAssertEqual(track.slug, "history")
        XCTAssertEqual(track.kind, "tour")
        XCTAssertTrue(track.official)
        XCTAssertEqual(track.spotCount, 169)
        let base = try XCTUnwrap(Distribution.indexURL(for: "grandtour.fyi"))
        XCTAssertEqual(Distribution.trackURL(entry, index: base)?.absoluteString, "https://grandtour.fyi/tours/history.grandtour.json")
        let raw = try XCTUnwrap(Distribution.indexURL(for: "github.com/gtfyi/content"))
        XCTAssertEqual(Distribution.trackURL(entry, index: raw)?.absoluteString,
                       "https://raw.githubusercontent.com/gtfyi/content/main/tours/history.grandtour.json")
        XCTAssertEqual(Distribution.defaultTrackURL(slug: "news", index: base)?.absoluteString, "https://grandtour.fyi/tours/news.grandtour.json")
    }
}
