import { beforeEach, describe, expect, test } from "bun:test";
import {
  adminHeaders,
  makeContent,
  makeFillInItem,
  makeSpot,
  makeTrack,
  resetDb,
} from "./helpers";
import app from "../src/index";

// Query point ≈ Brooklyn Bridge (helpers' default spot center).
const AT = { lat: 40.70611, lng: -73.99653 };
// ~1.5 km north — inside a 2 km cap, outside the fence below.
const NORTH = { lat: 40.72, lng: -73.99653 };
// ~111 km away.
const FAR = { lat: 41.70611, lng: -73.99653 };

/** A fence around AT (lng −74.000…−73.990, lat 40.700…40.712). */
const FENCE_WKT =
  "SRID=4326;POLYGON((-74.000 40.700, -73.990 40.700, -73.990 40.712, -74.000 40.712, -74.000 40.700))";
const FENCE_RING = [
  { lat: 40.7, lng: -74.0 },
  { lat: 40.7, lng: -73.99 },
  { lat: 40.712, lng: -73.99 },
  { lat: 40.712, lng: -74.0 },
];

function nearby(params: Record<string, string | number>) {
  const qs = new URLSearchParams(
    Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
  );
  return app.fetch(new Request(`http://localhost/api/nearby?${qs}`));
}

beforeEach(async () => {
  await resetDb();
});

describe("area triggers in /api/nearby", () => {
  test("inside the fence: triggered, zero distance, no locating", async () => {
    const track = await makeTrack();
    const spot = await makeSpot(track.id, {
      triggerKind: "area",
      regionWkt: FENCE_WKT,
      sequence: { key: "town-story", index: 0 },
    });
    await makeContent(spot.id, { audioUrl: "http://localhost:8787/uploads/a.mp3" });

    const { spots } = await (await nearby({ ...AT, radiusM: 2000, courseDeg: 90 })).json();
    expect(spots.length).toBe(1);
    expect(spots[0].spot.trigger.kind).toBe("area");
    expect(spots[0].spot.sequence).toEqual({ key: "town-story", index: 0 });
    expect(spots[0].triggered).toBe(true);
    expect(spots[0].distanceM).toBe(0);
    // No "where to look" for a place the traveler is standing in — even with
    // a course that would resolve a side for a point spot.
    expect(spots[0].locating).toBeNull();
  });

  test("inside the cap but outside the fence: returned, untriggered, fence distance", async () => {
    const track = await makeTrack();
    await makeSpot(track.id, { triggerKind: "area", regionWkt: FENCE_WKT });
    const { spots } = await (await nearby({ ...NORTH, radiusM: 2000 })).json();
    expect(spots.length).toBe(1);
    expect(spots[0].triggered).toBe(false);
    // Distance to the fence edge (~0.9 km), not to the centroid (~1.6 km).
    expect(spots[0].distanceM).toBeGreaterThan(500);
    expect(spots[0].distanceM).toBeLessThan(1200);
  });

  test("fence far outside the cap: not returned", async () => {
    const track = await makeTrack();
    await makeSpot(track.id, { triggerKind: "area", regionWkt: FENCE_WKT });
    const { spots } = await (await nearby({ ...FAR, radiusM: 2000 })).json();
    expect(spots.length).toBe(0);
  });

  test("point spots keep their original semantics alongside", async () => {
    const track = await makeTrack();
    await makeSpot(track.id, { radiusM: 100, title: "Point spot" });
    await makeSpot(track.id, { triggerKind: "area", regionWkt: FENCE_WKT, title: "Area spot" });
    const { spots } = await (await nearby({ ...AT, radiusM: 2000 })).json();
    expect(spots.length).toBe(2);
    const point = spots.find((s: any) => s.spot.title === "Point spot");
    expect(point.spot.trigger.kind).toBe("point");
    expect(point.triggered).toBe(true);
  });
});

describe("admin spot writes with trigger kinds", () => {
  test("area spot without center gets the fence centroid", async () => {
    const track = await makeTrack();
    const res = await app.fetch(
      new Request("http://localhost/api/admin/spots", {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({
          trackId: track.id,
          title: "Downtown stories",
          trigger: { kind: "area", region: FENCE_RING },
        }),
      }),
    );
    expect(res.status).toBe(201);
    const { spot } = await res.json();
    expect(spot.trigger.kind).toBe("area");
    expect(spot.trigger.center.lat).toBeCloseTo(40.706, 3);
    expect(spot.trigger.center.lng).toBeCloseTo(-73.995, 3);
    expect(spot.trigger.region.length).toBeGreaterThanOrEqual(4);
  });

  test("area without a fence is rejected", async () => {
    const track = await makeTrack();
    const res = await app.fetch(
      new Request("http://localhost/api/admin/spots", {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({
          trackId: track.id,
          title: "No fence",
          trigger: { kind: "area" },
        }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("anywhere is reserved: rejected at write time", async () => {
    const track = await makeTrack();
    const res = await app.fetch(
      new Request("http://localhost/api/admin/spots", {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({
          trackId: track.id,
          title: "Anywhere",
          trigger: { kind: "anywhere" },
        }),
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.detail).toContain("anywhere");
  });

  test("a taken sequence slot is an authoring error, not a 500", async () => {
    const track = await makeTrack();
    await makeSpot(track.id, { sequence: { key: "story", index: 1 } });
    const res = await app.fetch(
      new Request("http://localhost/api/admin/spots", {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({
          trackId: track.id,
          title: "Duplicate slot",
          trigger: { center: AT },
          sequence: { key: "story", index: 1 },
        }),
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.detail).toContain("sequence");
  });
});

describe("/api/track-manifest", () => {
  test("lists narratable units with sequence + lifecycle; skips silent spots", async () => {
    const tour = await makeTrack({ slug: "series-tour", lifecycle: "series" });
    const heard = await makeSpot(tour.id, { sequence: { key: "story", index: 0 } });
    await makeContent(heard.id, { audioUrl: "http://localhost:8787/uploads/a.mp3" });
    // Published spot with no published content: not narratable, not a unit.
    await makeSpot(tour.id, { title: "Silent spot" });
    // Draft spot: excluded outright.
    await makeSpot(tour.id, { status: "draft" });

    const fillin = await makeTrack({ slug: "vocab", kind: "fillin" });
    await makeFillInItem(fillin.id, { audioUrl: "http://localhost:8787/uploads/v.mp3" });

    const res = await app.fetch(
      new Request("http://localhost/api/track-manifest?tracks=series-tour,vocab"),
    );
    expect(res.status).toBe(200);
    const { tracks } = await res.json();
    expect(tracks.length).toBe(2);

    const tourManifest = tracks.find((t: any) => t.slug === "series-tour");
    expect(tourManifest.lifecycle).toBe("series");
    expect(tourManifest.units.length).toBe(1);
    expect(tourManifest.units[0]).toEqual({
      id: heard.id,
      sequenceKey: "story",
      sequenceIndex: 0,
    });
    expect(tourManifest.contentUpdatedAt).not.toBeNull();

    const vocabManifest = tracks.find((t: any) => t.slug === "vocab");
    expect(vocabManifest.lifecycle).toBe("evergreen");
    expect(vocabManifest.units.length).toBe(1);
  });
});
