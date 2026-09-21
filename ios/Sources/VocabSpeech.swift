import Foundation

/// Spoken beats for a vocab fill-in item, built from the structured payload
/// rather than the flattened transcript, so the on-device voice gets real
/// pauses: recall time after the question, a breath between senses, air
/// around the spelling.
///
/// Mirrors `buildVocabScript` in server/src/ai/fillin/vocab.ts — same beats,
/// same pauses. A change to either side belongs on both.
enum VocabSpeech {
    /// Recall gap after "Can you define X?" — matches the server default.
    static let thinkPauseSeconds: TimeInterval = 3

    private static let ordinals = ["First", "Second", "Third", "Fourth", "Fifth"]

    static func beats(for p: VocabPayload) -> [SpokenSegment] {
        let word = p.word.trimmingCharacters(in: .whitespaces)
        var out: [SpokenSegment] = [
            SpokenSegment(text: "The word is: \(word).", pauseAfter: 0.5),
            SpokenSegment(text: "Can you define \(word)?", pauseAfter: thinkPauseSeconds),
        ]

        if p.senses.count == 1, let s = p.senses.first {
            let pos = s.partOfSpeech.map { ", \($0.trimmingCharacters(in: .whitespaces))," } ?? ""
            out.append(SpokenSegment(
                text: "\(word)\(pos) means: \(sentenceCase(s.definition))",
                pauseAfter: 0.8
            ))
            if let ex = s.exampleSentence {
                out.append(SpokenSegment(text: "In a sentence: \(sentenceCase(ex))", pauseAfter: 1.2))
            }
        } else {
            out.append(SpokenSegment(text: "\(word) has \(p.senses.count) meanings.", pauseAfter: 0.8))
            for (i, s) in p.senses.enumerated() {
                let ordinal = i < ordinals.count ? ordinals[i] : "Number \(i + 1)"
                let pos = s.partOfSpeech.map { posPhrase($0) } ?? ""
                out.append(SpokenSegment(
                    text: "\(ordinal)\(pos.isEmpty ? "" : ", \(pos)"): \(sentenceCase(s.definition))",
                    pauseAfter: s.exampleSentence != nil ? 0.6 : 1.0
                ))
                if let ex = s.exampleSentence {
                    out.append(SpokenSegment(text: "In a sentence: \(sentenceCase(ex))", pauseAfter: 1.2))
                }
            }
        }

        out.append(SpokenSegment(text: "\(word) is spelled: \(spellOut(word)).", pauseAfter: 0.8))
        out.append(SpokenSegment(text: "\(word).", pauseAfter: 0))
        return out
    }

    private static func posPhrase(_ pos: String) -> String {
        let p = pos.trimmingCharacters(in: .whitespaces)
        guard !p.isEmpty else { return "" }
        let article = "aeiouAEIOU".contains(p.first!) ? "an" : "a"
        return "as \(article) \(p)"
    }

    private static func sentenceCase(_ s: String) -> String {
        let t = s.trimmingCharacters(in: .whitespaces)
        guard let last = t.last else { return t }
        return ".!?…".contains(last) ? t : t + "."
    }

    /// "loquacious" → "L, O, Q, U, A, C, I, O, U, S" (matches the server).
    static func spellOut(_ word: String) -> String {
        word.compactMap { ch -> String? in
            if ch.isLetter { return ch.uppercased() }
            if ch == "-" { return "hyphen" }
            if ch == "'" || ch == "’" { return "apostrophe" }
            if ch == " " { return nil }
            return String(ch)
        }.joined(separator: ", ")
    }
}
