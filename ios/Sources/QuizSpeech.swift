import Foundation

/// Spoken beats for a quiz fill-in item, built from the structured payload
/// rather than the flattened transcript, so the on-device voice gets a real
/// recall pause after the question and air between the answers.
///
/// Mirrors `buildQuizScript` in server/src/ai/fillin/quiz.ts — same beats,
/// same pauses. A change to either side belongs on both. (One deliberate
/// asymmetry lives server-side: provider break tags cap at 3 seconds, so
/// recorded audio compresses long recall pauses that this path keeps whole.)
enum QuizSpeech {
    /// Base recall gap after the question — matches the server default.
    static let thinkPauseSeconds: TimeInterval = 3

    private static let numberWords = [
        "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
    ]

    /// More answers to recall → more think time, capped so a ten-item list
    /// doesn't leave the traveler in dead air.
    static func thinkPause(answerCount: Int) -> TimeInterval {
        min(thinkPauseSeconds + 1.5 * TimeInterval(answerCount - 1), 10)
    }

    static func beats(for p: QuizPayload) -> [SpokenSegment] {
        var out: [SpokenSegment] = [
            SpokenSegment(text: "\(p.category.trimmingCharacters(in: .whitespaces)) quiz.", pauseAfter: 0.5),
            SpokenSegment(text: questionCase(p.question), pauseAfter: thinkPause(answerCount: p.answers.count)),
        ]

        if p.answers.count == 1, let a = p.answers.first {
            out.append(SpokenSegment(text: "The answer: \(sentenceCase(a))", pauseAfter: 0.8))
        } else {
            out.append(SpokenSegment(text: "There are \(p.answers.count).", pauseAfter: 0.6))
            for (i, a) in p.answers.enumerated() {
                let num = i < numberWords.count ? numberWords[i] : "Number \(i + 1)"
                out.append(SpokenSegment(
                    text: "\(num): \(sentenceCase(a))",
                    pauseAfter: i == p.answers.count - 1 ? 0.8 : 0.6
                ))
            }
        }

        if let note = p.note {
            out.append(SpokenSegment(text: sentenceCase(note), pauseAfter: 0))
        }
        if var last = out.popLast() {
            last = SpokenSegment(text: last.text, pauseAfter: 0)
            out.append(last)
        }
        return out
    }

    private static func sentenceCase(_ s: String) -> String {
        let t = s.trimmingCharacters(in: .whitespaces)
        guard let last = t.last else { return t }
        return ".!?…".contains(last) ? t : t + "."
    }

    /// A question beat should actually ask — default to "?" when unpunctuated.
    private static func questionCase(_ s: String) -> String {
        let t = s.trimmingCharacters(in: .whitespaces)
        guard let last = t.last else { return t }
        return ".!?…".contains(last) ? t : t + "?"
    }
}
