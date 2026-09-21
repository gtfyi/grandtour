import SwiftUI

/// Renders the narration text and highlights the segment matching `currentMs`,
/// using filo audio-tier byte ranges mapped onto the Swift String's UTF-8 view.
struct TranscriptView: View {
    let document: FiloDocument
    let currentMs: Double

    var body: some View {
        Text(attributed)
            .font(.body)
            .lineSpacing(4)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var attributed: AttributedString {
        var result = AttributedString(document.text)
        guard let seg = activeSegment else { return result }
        guard let range = stringRange(byteStart: seg.byteStart, byteEnd: seg.byteEnd) else { return result }
        if let lower = AttributedString.Index(range.lowerBound, within: result),
           let upper = AttributedString.Index(range.upperBound, within: result) {
            result[lower..<upper].backgroundColor = .accentColor.opacity(0.3)
            result[lower..<upper].foregroundColor = .primary
        }
        return result
    }

    private var activeSegment: AudioSegment? {
        document.audioSegments.first { currentMs >= $0.startMs && currentMs < $0.endMs }
    }

    /// Map a UTF-8 byte range to a Swift String.Index range.
    private func stringRange(byteStart: Int, byteEnd: Int) -> Range<String.Index>? {
        guard let loStr = stringIndex(atByteOffset: byteStart),
              let hiStr = stringIndex(atByteOffset: byteEnd),
              loStr <= hiStr
        else { return nil }
        return loStr..<hiStr
    }

    /// Resolve a byte offset to a String.Index, clamping forward (≤3 bytes)
    /// to the next character boundary when the offset lands mid-character.
    private func stringIndex(atByteOffset offset: Int) -> String.Index? {
        let utf8 = document.text.utf8
        for adjusted in offset...(offset + 3) {
            guard let i = utf8.index(utf8.startIndex, offsetBy: adjusted, limitedBy: utf8.endIndex)
            else { return nil }
            if let s = i.samePosition(in: document.text) {
                return s // misaligned byte range; clamped when adjusted > offset
            }
        }
        return nil
    }
}
