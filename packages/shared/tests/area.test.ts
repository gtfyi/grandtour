import { describe, expect, test } from "bun:test";
import {
  AREA_PRECISION,
  areaBounds,
  areaCenter,
  areaId,
  areaNeighbors,
  areasAround,
  areasOf,
  ringAreas,
  triggerAreas,
} from "../src/area";

const fairfax = { lat: 37.9871, lng: -122.5889 };

describe("areaId", () => {
  test("matches the published geohash test vectors", () => {
    expect(areaId({ lat: 42.605, lng: -5.603 }, 5)).toBe("ezs42");
    expect(areaId({ lat: 57.64911, lng: 10.40744 }, 11)).toBe("u4pruydqqvj");
  });

  test("default precision is a regional cell", () => {
    expect(AREA_PRECISION).toBe(4);
    expect(areaId(fairfax)).toHaveLength(4);
    const b = areaBounds(areaId(fairfax));
    expect(b.maxLat - b.minLat).toBeCloseTo(0.17578125, 6);
    expect(b.maxLng - b.minLng).toBeCloseTo(0.3515625, 6);
  });

  test("bounds contain the point and round-trip through the centre", () => {
    for (const p of [fairfax, { lat: -33.8688, lng: 151.2093 }, { lat: 0, lng: 0 }, { lat: 89.99, lng: 179.99 }]) {
      const id = areaId(p);
      const b = areaBounds(id);
      expect(p.lat).toBeGreaterThanOrEqual(b.minLat);
      expect(p.lat).toBeLessThan(b.maxLat + 1e-9);
      expect(areaId(areaCenter(id))).toBe(id);
    }
  });

  test("longitude 180 is the same meridian as -180", () => {
    expect(areaId({ lat: 10, lng: 180 })).toBe(areaId({ lat: 10, lng: -180 }));
  });

  test("rejects garbage ids", () => {
    expect(() => areaBounds("a")).toThrow();
  });
});

describe("areaNeighbors", () => {
  test("eight distinct adjacent cells at mid-latitudes", () => {
    const home = areaId(fairfax);
    const around = areaNeighbors(home);
    expect(around).toHaveLength(8);
    expect(new Set(around).size).toBe(8);
    const hb = areaBounds(home);
    for (const n of around) {
      expect(n).not.toBe(home);
      const nb = areaBounds(n);
      const touchesLat = nb.maxLat >= hb.minLat - 1e-9 && nb.minLat <= hb.maxLat + 1e-9;
      const touchesLng = nb.maxLng >= hb.minLng - 1e-9 && nb.minLng <= hb.maxLng + 1e-9;
      expect(touchesLat && touchesLng).toBe(true);
    }
    expect(around).toEqual([...around].sort());
  });

  test("fewer cells at the pole, and wraps at the antimeridian", () => {
    expect(areaNeighbors(areaId({ lat: 89.99, lng: 0 })).length).toBeLessThan(8);
    const east = areaId({ lat: 10, lng: 179.9 });
    expect(areaNeighbors(east).some((n) => areaBounds(n).minLng === -180)).toBe(true);
  });

  test("areasAround puts the traveler's cell first", () => {
    const cells = areasAround(fairfax);
    expect(cells[0]).toBe(areaId(fairfax));
    expect(cells).toHaveLength(9);
  });
});

describe("ringAreas / triggerAreas / areasOf", () => {
  test("a fence crossing a cell edge lists both cells", () => {
    const b = areaBounds(areaId(fairfax));
    const ring = [
      { lat: b.minLat + 0.01, lng: b.maxLng - 0.01 },
      { lat: b.minLat + 0.01, lng: b.maxLng + 0.01 },
      { lat: b.minLat + 0.02, lng: b.maxLng + 0.01 },
    ];
    const cells = ringAreas(ring);
    expect(cells.length).toBeGreaterThanOrEqual(2);
    expect(cells).toContain(areaId(fairfax));
  });

  test("a fence wider than a cell covers the cells between its vertices", () => {
    const b = areaBounds(areaId(fairfax));
    const wide = (b.maxLng - b.minLng) * 3;
    const ring = [
      { lat: fairfax.lat, lng: fairfax.lng },
      { lat: fairfax.lat, lng: fairfax.lng + wide },
      { lat: fairfax.lat + 0.01, lng: fairfax.lng + wide },
      { lat: fairfax.lat + 0.01, lng: fairfax.lng },
    ];
    expect(ringAreas(ring).length).toBeGreaterThanOrEqual(4);
  });

  test("a point trigger near a cell edge reaches into the neighbour", () => {
    const b = areaBounds(areaId(fairfax));
    const edge = { lat: fairfax.lat, lng: b.maxLng - 0.0001 };
    const cells = triggerAreas({ kind: "point", center: edge, radiusM: 500 });
    expect(cells.length).toBe(2);
    expect(triggerAreas({ kind: "point", center: fairfax, radiusM: 40 })).toEqual([areaId(fairfax)]);
  });

  test("an area trigger is its fence, not its centre", () => {
    const far = { lat: 48.6855, lng: -113.7037 };
    const ring = [far, { lat: far.lat + 0.001, lng: far.lng }, { lat: far.lat, lng: far.lng + 0.001 }];
    const cells = triggerAreas({ kind: "area", center: fairfax, radiusM: 0, region: ring });
    expect(cells).toEqual([areaId(far)]);
  });

  test("areasOf is the sorted union over triggers", () => {
    const glacier = { lat: 48.6855, lng: -113.7037 };
    const cells = areasOf([
      { kind: "point", center: fairfax, radiusM: 40 },
      { kind: "point", center: glacier, radiusM: 40 },
      { kind: "point", center: fairfax, radiusM: 40 },
    ]);
    expect(cells).toEqual([areaId(fairfax), areaId(glacier)].sort());
  });
});
