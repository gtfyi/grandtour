import { describe, expect, test } from "bun:test";
import { FiloDocument, annotateSentences } from "filo";
import { alignAudioToSentences, charTimesByStringIndex } from "../src/ai/generate";
import { pointWkt, polygonWkt } from "../src/geo/queries";

describe("geo WKT helpers", () => {
  test("point is lng-lat ordered", () => {
    expect(pointWkt({ lat: 40.5, lng: -74.1 })).toBe("SRID=4326;POINT(-74.1 40.5)");
  });

  test("polygon auto-closes the ring", () => {
    const wkt = polygonWkt([
      { lat: 0, lng: 0 },
      { lat: 0, lng: 1 },
      { lat: 1, lng: 1 },
    ]);
    expect(wkt).toBe("SRID=4326;POLYGON((0 0, 1 0, 1 1, 0 0))");
  });
});

describe("charTimesByStringIndex", () => {
  test("ASCII identity: one time per string index", () => {
    const times = charTimesByStringIndex("abc", ["a", "b", "c"], [100, 200, 300]);
    expect(times).toEqual([100, 200, 300]);
  });

  test("multi-unit characters spread their time across UTF-16 units", () => {
    const times = charTimesByStringIndex("a🌉b", ["a", "🌉", "b"], [100, 200, 300]);
    expect(times).toEqual([100, 200, 200, 300]);
  });

  test("returns null when characters don't reconstruct the text", () => {
    expect(charTimesByStringIndex("abc", ["a", "x", "c"], [1, 2, 3])).toBeNull();
  });

  test("returns null on a length mismatch between chars and times", () => {
    expect(charTimesByStringIndex("ab", ["a", "b"], [1])).toBeNull();
  });
});

describe("alignAudioToSentences", () => {
  test("attaches one audio annotation per sentence with sentence timing", () => {
    const text = "Hello there. This is the bridge.";
    const doc = FiloDocument.fromText(text);
    const sentences = annotateSentences(doc, {});
    expect(sentences.length).toBe(2);

    // One per-character end time (ms) for the whole string.
    // Make times = 100ms per char for an easy assertion.
    const charEndMs = Array.from({ length: text.length }, (_, i) => (i + 1) * 100);

    alignAudioToSentences(doc, sentences, charEndMs, "https://cdn/x.mp3", "audio/mpeg");

    const audio = doc.tier("audio");
    expect(audio?.annotations.length).toBe(2);

    const first = audio!.annotations[0]!;
    // First sentence "Hello there." occupies string indices 0..12.
    expect((first.payload as any).startMs).toBe(0);
    expect((first.payload as any).endMs).toBe(12 * 100);
    expect((first.payload as any).url).toBe("https://cdn/x.mp3");
    // The audio annotation shares the sentence's byte range.
    expect(first.start).toBe(sentences[0]!.start);
    expect(first.end).toBe(sentences[0]!.end);

    const second = audio!.annotations[1]!;
    // Second sentence starts after the space at index 13.
    expect((second.payload as any).startMs).toBe(13 * 100);
    expect((second.payload as any).endMs).toBe(text.length * 100);
  });

  test("emoji text keeps sentence timings monotonic across the surrogate pair", () => {
    const text = "Look at the 🌉 span. It glows.";
    const doc = FiloDocument.fromText(text);
    const sentences = annotateSentences(doc, {});
    expect(sentences.length).toBe(2);

    // Synthetic provider segmentation: one entry per code point, 100ms/step.
    const chars = Array.from(text);
    const charEndMs = chars.map((_, k) => (k + 1) * 100);
    const times = charTimesByStringIndex(text, chars, charEndMs);
    expect(times).not.toBeNull();
    expect(times!.length).toBe(text.length); // UTF-16 length (emoji = 2 units)

    alignAudioToSentences(doc, sentences, times!, "https://cdn/z.mp3", "audio/mpeg");
    const [first, second] = doc.tier("audio")!.annotations;
    const a = first!.payload as any;
    const b = second!.payload as any;
    expect(a.endMs).toBeGreaterThan(a.startMs);
    expect(b.startMs).toBeGreaterThanOrEqual(a.endMs);
    expect(b.endMs).toBe(chars.length * 100);
  });

  test("serialized document round-trips with the audio tier", () => {
    const doc = FiloDocument.fromText("One. Two.");
    const sentences = annotateSentences(doc, {});
    const charEndMs = Array.from({ length: 9 }, (_, i) => (i + 1) * 50);
    alignAudioToSentences(doc, sentences, charEndMs, "https://cdn/y.mp3", "audio/mpeg");

    const json = doc.toJSON();
    const rebuilt = FiloDocument.fromJSON(json);
    expect(rebuilt.tier("audio")?.annotations.length).toBe(2);
  });
});
