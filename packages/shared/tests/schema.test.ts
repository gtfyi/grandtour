import { describe, expect, test } from "bun:test";
import { FiloDocument, annotateAudio, annotateSentences } from "filo";
import {
  GeoTrigger,
  NearbyQuery,
  FiloDocumentJson,
  ContentPieceInput,
} from "../src/index";

describe("GeoTrigger", () => {
  test("defaults radius and allows region", () => {
    const t = GeoTrigger.parse({ center: { lat: 40.0, lng: -74.0 } });
    expect(t.radiusM).toBe(80);
    expect(t.region).toBeUndefined();

    const withRegion = GeoTrigger.parse({
      center: { lat: 40, lng: -74 },
      radiusM: 120,
      region: [
        { lat: 40, lng: -74 },
        { lat: 40.001, lng: -74 },
        { lat: 40.001, lng: -74.001 },
      ],
    });
    expect(withRegion.region).toHaveLength(3);
  });

  test("rejects out-of-range coordinates", () => {
    expect(() => GeoTrigger.parse({ center: { lat: 200, lng: 0 } })).toThrow();
  });
});

describe("NearbyQuery", () => {
  test("coerces query-string params and splits tracks", () => {
    const q = NearbyQuery.parse({
      lat: "40.5",
      lng: "-74.1",
      radiusM: "1500",
      tracks: "history,nature",
      limit: "10",
    });
    expect(q.lat).toBe(40.5);
    expect(q.radiusM).toBe(1500);
    expect(q.tracks).toEqual(["history", "nature"]);
    expect(q.limit).toBe(10);
  });

  test("courseDeg coerces from the query string and stays optional", () => {
    const withCourse = NearbyQuery.parse({ lat: "40", lng: "-74", courseDeg: "92.5" });
    expect(withCourse.courseDeg).toBe(92.5);
    const without = NearbyQuery.parse({ lat: "40", lng: "-74" });
    expect(without.courseDeg).toBeUndefined();
  });

  test("locale defaults to en and passes through when given", () => {
    const defaulted = NearbyQuery.parse({ lat: "40", lng: "-74" });
    expect(defaulted.locale).toBe("en");
    const es = NearbyQuery.parse({ lat: "40", lng: "-74", locale: "es" });
    expect(es.locale).toBe("es");
  });
});

describe("filo document round-trips through the shared schema", () => {
  test("a built audio-aligned document validates and reconstructs", () => {
    const doc = FiloDocument.fromText("Welcome. This is the old courthouse.");
    annotateSentences(doc, {});
    annotateAudio(doc, {
      start: 0,
      end: 8, // "Welcome."
      url: "https://cdn.example.com/a.mp3",
      startMs: 0,
      endMs: 1200,
    });

    const json = doc.toJSON();
    // Validates against our wire schema...
    const parsed = FiloDocumentJson.parse(json);
    // ...and reconstructs into a real filo document.
    const rebuilt = FiloDocument.fromJSON(parsed as any);
    expect(rebuilt.text).toBe(doc.text);
    expect(rebuilt.tier("audio")?.annotations.length).toBe(1);

    const piece = ContentPieceInput.parse({
      spotId: "11111111-1111-1111-1111-111111111111",
      document: json,
      audioUrl: "https://cdn.example.com/a.mp3",
      durationMs: 1200,
      source: "ai",
    });
    expect(piece.document?.text).toBe(doc.text);
  });

  test("provenance warnings round-trip and default to empty when omitted", () => {
    const withWarnings = ContentPieceInput.parse({
      spotId: "11111111-1111-1111-1111-111111111111",
      source: "ai",
      provenance: { warnings: ["exa search failed: 429"] },
    });
    expect(withWarnings.provenance?.warnings).toEqual(["exa search failed: 429"]);

    const omitted = ContentPieceInput.parse({
      spotId: "11111111-1111-1111-1111-111111111111",
      source: "ai",
      provenance: { model: "claude-opus-4-8" },
    });
    expect(omitted.provenance?.warnings).toEqual([]);
  });
});
