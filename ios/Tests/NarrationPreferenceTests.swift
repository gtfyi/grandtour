import XCTest

final class NarrationPreferenceTests: XCTestCase {
    func testFreshInstallAndLegacySettingsDefaultToServerOnly() {
        let name = "NarrationPreferenceTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        XCTAssertEqual(NarrationPreference.load(from: defaults), .serverOnly)
        defaults.set("serverWhenAvailable", forKey: "narrationPreference")
        XCTAssertEqual(NarrationPreference.load(from: defaults), .serverOnly)
        defaults.set("deviceVoiceOnly", forKey: "narrationPreferenceV2")
        XCTAssertEqual(NarrationPreference.load(from: defaults), .deviceVoiceOnly)
        defaults.set("serverWhenAvailable", forKey: "narrationPreferenceV2")
        XCTAssertEqual(NarrationPreference.load(from: defaults), .serverWhenAvailable)
    }

    func testServerOnlyRequiresRecordingAndStillPrefetchesAudio() {
        let text = ContentPiece(id: "text", locale: "en", variant: "default",
            document: FiloDocument(id: "script", text: "A story", byteLength: 7, tiers: []),
            audioUrl: nil, durationMs: nil, source: "human", provenance: nil)
        let recorded = ContentPiece(id: "recorded", locale: "en", variant: "default",
            document: nil, audioUrl: "https://example.com/audio.mp3", durationMs: 1000,
            source: "human", provenance: nil)
        XCTAssertFalse(NarrationPreference.serverOnly.canNarrate(text))
        XCTAssertTrue(NarrationPreference.serverOnly.canNarrate(recorded))
        XCTAssertFalse(NarrationPreference.serverOnly.canNarrate(nil))
        XCTAssertTrue(NarrationPreference.serverOnly.prefersServerAudio)
        XCTAssertFalse(NarrationPreference.serverOnly.allowsDeviceSpeech)
        XCTAssertTrue(NarrationPreference.serverWhenAvailable.canNarrate(text))
        XCTAssertTrue(NarrationPreference.deviceVoiceOnly.canNarrate(text))
        XCTAssertFalse(NarrationPreference.deviceVoiceOnly.canNarrate(recorded))
    }
}
