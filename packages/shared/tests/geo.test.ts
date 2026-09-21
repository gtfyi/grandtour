import { describe, expect, test } from "bun:test";
import {
  bearingDeg,
  cumulativeMeters,
  haversineM,
  nearestNeighborOrder,
  pointAlong,
  ringAreaM2,
} from "../src/geo";

describe("haversineM", () => {
  test("zero distance for identical points", () => {
    expect(haversineM({ lat: 40, lng: -74 }, { lat: 40, lng: -74 })).toBe(0);
  });

  test("~111km per degree of latitude", () => {
    const d = haversineM({ lat: 40, lng: -74 }, { lat: 41, lng: -74 });
    expect(d).toBeGreaterThan(110_000);
    expect(d).toBeLessThan(112_000);
  });
});

describe("bearingDeg", () => {
  test("due north ≈ 0°, due east ≈ 90°", () => {
    expect(bearingDeg({ lat: 40, lng: -74 }, { lat: 41, lng: -74 })).toBeCloseTo(0, 0);
    expect(bearingDeg({ lat: 40, lng: -74 }, { lat: 40, lng: -73 })).toBeCloseTo(90, 0);
  });
});

describe("pointAlong", () => {
  const path = [
    { lat: 40, lng: -74 },
    { lat: 40, lng: -73 }, // due east
  ];
  const cum = cumulativeMeters(path);

  test("start and end clamp", () => {
    expect(pointAlong(path, cum, -100).pos).toEqual(path[0]!);
    expect(pointAlong(path, cum, 1e9).pos.lng).toBeCloseTo(-73, 5);
  });

  test("midpoint is halfway along and heads east", () => {
    const mid = pointAlong(path, cum, cum[1]! / 2);
    expect(mid.pos.lng).toBeCloseTo(-73.5, 3);
    expect(mid.headingDeg).toBeCloseTo(90, 0);
  });
});

describe("nearestNeighborOrder", () => {
  test("keeps the start, then hops to the nearest each time", () => {
    // 0 at origin, then a far point, a near point, a mid point.
    const pts = [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 10 }, // far
      { lat: 0, lng: 1 }, // near
      { lat: 0, lng: 5 }, // mid
    ];
    expect(nearestNeighborOrder(pts)).toEqual([0, 2, 3, 1]);
  });

  test("passes through short inputs unchanged", () => {
    expect(nearestNeighborOrder([{ lat: 1, lng: 1 }])).toEqual([0]);
    expect(nearestNeighborOrder([{ lat: 1, lng: 1 }, { lat: 2, lng: 2 }])).toEqual([0, 1]);
  });
});

describe("ringAreaM2", () => {
  test("a 200 m square is about 40,000 m², and a bigger fence is bigger", () => {
    const at = { lat: 37.9871, lng: -122.5889 };
    const square = (halfM: number) => {
      const dLat = halfM / 111_320, dLng = halfM / (111_320 * Math.cos((at.lat * Math.PI) / 180));
      return [{ lat: at.lat + dLat, lng: at.lng - dLng }, { lat: at.lat + dLat, lng: at.lng + dLng }, { lat: at.lat - dLat, lng: at.lng + dLng }, { lat: at.lat - dLat, lng: at.lng - dLng }];
    };
    expect(ringAreaM2(square(100))).toBeCloseTo(40_000, -2);
    expect(ringAreaM2(square(1000))).toBeGreaterThan(ringAreaM2(square(100)));
    expect(ringAreaM2(undefined)).toBe(Infinity);
    expect(ringAreaM2([at, at])).toBe(Infinity);
  });
});
