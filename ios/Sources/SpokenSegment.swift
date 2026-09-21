import Foundation

/// One spoken unit and the silence to leave after it. The unit of pacing for
/// on-device narration: sentences breathe, scripted pauses actually pause.
///
/// Foundation-only on purpose — the speech builders (VocabSpeech, QuizSpeech)
/// and any target without AVFoundation (the watch app's shared slice) depend
/// on it.
struct SpokenSegment {
    let text: String
    let pauseAfter: TimeInterval

    /// Plain text → paced segments: one per sentence with a short breath
    /// after each, and an ellipsis (the transcript's marker for a scripted
    /// pause) rendered as think-time silence.
    static func segments(from text: String) -> [SpokenSegment] {
        var out: [SpokenSegment] = []
        let chunks = text.components(separatedBy: "…")
        for (i, chunk) in chunks.enumerated() {
            let trimmed = chunk.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { continue }
            var sentences: [String] = []
            trimmed.enumerateSubstrings(
                in: trimmed.startIndex..., options: [.bySentences, .localized]
            ) { s, _, _, _ in
                let t = s?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                if !t.isEmpty { sentences.append(t) }
            }
            if sentences.isEmpty { sentences = [trimmed] }
            out.append(contentsOf: sentences.map { SpokenSegment(text: $0, pauseAfter: 0.35) })
            // This chunk ended at an ellipsis: stretch its last breath into
            // think time.
            if i < chunks.count - 1, let last = out.indices.last {
                out[last] = SpokenSegment(text: out[last].text, pauseAfter: 2.5)
            }
        }
        return out
    }
}
