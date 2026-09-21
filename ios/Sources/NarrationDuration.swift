import Foundation

/// How long a piece of narration runs — the scheduler's lead window and the
/// "does this filler fit before the next spot" test both need it. Exact when
/// the server measured the recorded clip; otherwise estimated from the text
/// at on-device speaking pace (with scripted "…" pauses counted).
///
/// Foundation-only so the watch target and the test bundle share it.
enum NarrationDuration {
    /// AVSpeechSynthesizer at default rate, roughly.
    static let wordsPerSecond: Double = 2.5
    /// A spoken locator intro ("Coming up in 90 meters on your left.")
    static let introS: TimeInterval = 4
    /// Think-time rendered for each "…" in a script (SpokenSegment).
    static let ellipsisPauseS: TimeInterval = 2.5

    static func seconds(for content: ContentPiece?) -> TimeInterval {
        guard let content else { return 0 }
        if let ms = content.durationMs, ms > 0 { return ms / 1000 }
        return seconds(forText: content.document?.text ?? "")
    }

    static func seconds(forText text: String) -> TimeInterval {
        guard !text.isEmpty else { return 0 }
        let words = text.split { $0.isWhitespace || $0.isNewline }.count
        let pauses = Double(max(0, text.components(separatedBy: "…").count - 1)) * ellipsisPauseS
        return Double(words) / wordsPerSecond + pauses
    }

    /// A spot's narration as the tour plays it: locator intro, then the story.
    static func seconds(for s: NearbySpot) -> TimeInterval {
        seconds(for: s.content) + introS
    }
}
