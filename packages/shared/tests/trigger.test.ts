import { describe, expect, test } from "bun:test";
import {
  GeoTrigger,
  Spot,
  SpotInput,
  Track,
  TrackInput,
  ringCentroid,
  triggerAnchor,
} from "../src";

const SQUARE = [
  { lat: 37.98, lng: -122.6 },
  { lat: 37.98, lng: -122.58 },
  { lat: 38.0, lng: -122.58 },
  { lat: 38.0, lng: -122.6 },
];

describe("GeoTrigger kinds", () => {
  test("pre-kind shape (center + radius) still parses, as point", () => {
    const t = GeoTrigger.parse({ center: { lat: 37.99, lng: -122.59 }, radiusM: 120 });
    expect(t.kind).toBe("point");
    expect(t.center).toEqual({ lat: 37.99, lng: -122.59 });
  });

  test("point without center is rejected", () => {
    expect(GeoTrigger.safeParse({ kind: "point", radiusM: 80 }).success).toBe(false);
  });

  test("area requires the fence polygon", () => {
    expect(GeoTrigger.safeParse({ kind: "area" }).success).toBe(false);
    const t = GeoTrigger.parse({ kind: "area", region: SQUARE });
    expect(t.kind).toBe("area");
    expect(t.center).toBeUndefined();
    expect(t.radiusM).toBe(80); // defaulted, unused for area
  });

  test("anywhere parses with no geometry (reserved kind)", () => {
    const t = GeoTrigger.parse({ kind: "anywhere" });
    expect(t.kind).toBe("anywhere");
    expect(triggerAnchor(t)).toBeNull();
  });

  test("triggerAnchor prefers center, falls back to fence centroid", () => {
    const point = GeoTrigger.parse({ center: { lat: 1, lng: 2 } });
    expect(triggerAnchor(point)).toEqual({ lat: 1, lng: 2 });
    const area = GeoTrigger.parse({ kind: "area", region: SQUARE });
    const anchor = triggerAnchor(area)!;
    expect(anchor.lat).toBeCloseTo(37.99, 6);
    expect(anchor.lng).toBeCloseTo(-122.59, 6);
  });

  test("ringCentroid of a degenerate ring falls back to the vertex mean", () => {
    const line = [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 2 },
      { lat: 0, lng: 4 },
    ];
    expect(ringCentroid(line)).toEqual({ lat: 0, lng: 2 });
  });
});

describe("Spot.sequence", () => {
  const base = {
    trackId: "3e0f9d5e-46c8-4dd8-9351-1e4f77f0f0aa",
    title: "Part two",
    trigger: { center: { lat: 37.99, lng: -122.59 } },
  };

  test("valid sequence parses on SpotInput", () => {
    const s = SpotInput.parse({ ...base, sequence: { key: "gold-rush", index: 1 } });
    expect(s.sequence).toEqual({ key: "gold-rush", index: 1 });
  });

  test("sequence key must be a slug, index a nonnegative int", () => {
    expect(SpotInput.safeParse({ ...base, sequence: { key: "Bad Key", index: 1 } }).success).toBe(false);
    expect(SpotInput.safeParse({ ...base, sequence: { key: "ok", index: -1 } }).success).toBe(false);
    expect(SpotInput.safeParse({ ...base, sequence: { key: "ok", index: 1.5 } }).success).toBe(false);
  });

  test("Spot without sequence still parses (old rows)", () => {
    const s = Spot.parse({
      id: "3e0f9d5e-46c8-4dd8-9351-1e4f77f0f0ab",
      slug: "old-spot",
      status: "published",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...base,
    });
    expect(s.sequence).toBeUndefined();
    expect(s.trigger.kind).toBe("point");
  });
});

describe("Track.lifecycle", () => {
  test("defaults to evergreen (old rows and inputs)", () => {
    const t = TrackInput.parse({ slug: "history", name: "History" });
    expect(t.lifecycle).toBeUndefined(); // omitted input stays omitted
    const full = Track.parse({
      id: "3e0f9d5e-46c8-4dd8-9351-1e4f77f0f0ac",
      slug: "history",
      name: "History",
      official: false,
      createdAt: new Date().toISOString(),
    });
    expect(full.lifecycle).toBe("evergreen");
  });

  test("series parses; junk is rejected", () => {
    expect(TrackInput.parse({ slug: "s", name: "S", lifecycle: "series" }).lifecycle).toBe("series");
    expect(TrackInput.safeParse({ slug: "s", name: "S", lifecycle: "weekly" }).success).toBe(false);
  });
});
