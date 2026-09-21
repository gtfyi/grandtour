import { describe, expect, test } from "bun:test";
import { TrackExport, type NearbySpot } from "@grandtour/shared";
import { isArea, pickAmbient, sequenceReleased } from "../src/eligibility";
import rawBundle from "./fixtures/sample.grandtour.json";

const bundle = TrackExport.parse(rawBundle);
const at = "2026-01-01T00:00:00.000Z";
const fairfax = { lat: 37.9871, lng: -122.5889 };

function item(id: string, extra: Partial<NearbySpot["spot"]> = {}, distanceM = 0): NearbySpot {
  const base = bundle.spots[0]!;
  return { spot: { ...base.spot, id, ...extra }, track: bundle.track, locating: null, distanceM, triggered: true, content: base.content[0] ?? null, guide: null };
}
const square = (half: number) => [
  { lat: fairfax.lat + half, lng: fairfax.lng - half }, { lat: fairfax.lat + half, lng: fairfax.lng + half },
  { lat: fairfax.lat - half, lng: fairfax.lng + half }, { lat: fairfax.lat - half, lng: fairfax.lng - half },
];

describe("sequenceReleased", () => {
  const chapters: TrackExport = {
    ...bundle,
    spots: [1, 2, 3].map((index) => ({
      spot: { ...bundle.spots[0]!.spot, id: `part-${index}`, slug: `part-${index}`, sequence: { key: "story", index }, createdAt: at, updatedAt: at },
      content: bundle.spots[1]!.content,
    })),
  };
  test("a later part waits for every earlier part to have been heard", () => {
    const heard = new Set<string>();
    const part = (n: number) => item(`part-${n}`, { sequence: { key: "story", index: n } });
    expect(sequenceReleased(part(1), chapters, (id) => heard.has(id))).toBe(true);
    expect(sequenceReleased(part(2), chapters, (id) => heard.has(id))).toBe(false);
    expect(sequenceReleased(part(3), chapters, (id) => heard.has(id))).toBe(false);
    heard.add("part-1");
    expect(sequenceReleased(part(2), chapters, (id) => heard.has(id))).toBe(true);
    expect(sequenceReleased(part(3), chapters, (id) => heard.has(id))).toBe(false);
    heard.add("part-2");
    expect(sequenceReleased(part(3), chapters, (id) => heard.has(id))).toBe(true);
  });
  test("stories without a sequence, and parts the bundle does not list, pass", () => {
    expect(sequenceReleased(item("free"), chapters, () => false)).toBe(true);
    expect(sequenceReleased(item("part-2", { sequence: { key: "story", index: 2 } }), undefined, () => false)).toBe(true);
  });
});

describe("pickAmbient", () => {
  const county = item("county", { trigger: { kind: "area", center: fairfax, radiusM: 0, region: square(0.05) } }, 0);
  const town = item("town", { trigger: { kind: "area", center: fairfax, radiusM: 0, region: square(0.005) } }, 0);
  const block = item("block", { trigger: { kind: "area", center: fairfax, radiusM: 0, region: square(0.001) } }, 0);
  const history = (played: Record<string, number>) => ({
    playCount: (id: string) => (played[id] == null ? 0 : 1),
    lastPlayedAtS: (id: string) => played[id] ?? null,
  });
  test("unheard first, then the longest-forgotten, then the most specific fence", () => {
    expect(pickAmbient([county, town, block], history({}))?.spot.id).toBe("block");
    expect(pickAmbient([county, town, block], history({ block: 100 }))?.spot.id).toBe("town");
    expect(pickAmbient([county, town, block], history({ block: 100, town: 50, county: 200 }))?.spot.id).toBe("town");
    expect(pickAmbient([county, town, block], history({ block: 100, town: 100, county: 100 }))?.spot.id).toBe("block");
    expect(pickAmbient([], history({}))).toBeNull();
  });
  test("isArea reads the trigger kind", () => {
    expect(isArea(town)).toBe(true);
    expect(isArea(item("p"))).toBe(false);
  });
});
