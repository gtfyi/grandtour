import { z } from "zod";
import type { BBox, GeoTrigger, LngLat, PolygonRing } from "./geo";
import { ringCentroid } from "./geo";

/**
 * Areas: the shared spatial vocabulary of the static distribution.
 *
 * An area is a geohash cell. Server and client both know the function, so
 * there is no list to publish or sync: a client turns its own position into
 * a cell id, asks for the tracks in that cell and its neighbours, and never
 * sends a coordinate anywhere. The catalog records which cells each track
 * touches (`trackAreas`); at `AREA_PRECISION` 4 a cell is about 39 km by
 * 20 km at the equator, which is the right grain for "which tracks are
 * around here" and coarse enough that a request reveals only a region.
 *
 * The Swift mirror is `AreaId` in ios/Sources/AreaId.swift; the two are
 * pinned together by scripts/area-parity. Change both or neither.
 */
export const AREA_PRECISION = 4;

const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

export const AreaId = z.string().regex(/^[0-9b-hjkmnp-z]{1,12}$/);
export type AreaId = z.infer<typeof AreaId>;

/** Longitude folded into [-180, 180). */
function wrapLng(lng: number): number {
  const w = ((((lng + 180) % 360) + 360) % 360) - 180;
  return w;
}

/** The cell containing a position. */
export function areaId(p: LngLat, precision = AREA_PRECISION): AreaId {
  let latLo = -90, latHi = 90, lngLo = -180, lngHi = 180;
  const lng = wrapLng(p.lng);
  let out = "", bits = 0, ch = 0, even = true;
  while (out.length < precision) {
    if (even) {
      const mid = (lngLo + lngHi) / 2;
      if (lng >= mid) { ch = ch * 2 + 1; lngLo = mid; } else { ch *= 2; lngHi = mid; }
    } else {
      const mid = (latLo + latHi) / 2;
      if (p.lat >= mid) { ch = ch * 2 + 1; latLo = mid; } else { ch *= 2; latHi = mid; }
    }
    even = !even;
    if (++bits === 5) { out += BASE32[ch]; bits = 0; ch = 0; }
  }
  return out;
}

/** The cell's bounding box. */
export function areaBounds(id: AreaId): BBox {
  let latLo = -90, latHi = 90, lngLo = -180, lngHi = 180, even = true;
  for (const c of id) {
    const v = BASE32.indexOf(c);
    if (v < 0) throw new Error(`invalid area id: ${id}`);
    for (let mask = 16; mask > 0; mask >>= 1) {
      if (even) {
        const mid = (lngLo + lngHi) / 2;
        if (v & mask) lngLo = mid; else lngHi = mid;
      } else {
        const mid = (latLo + latHi) / 2;
        if (v & mask) latLo = mid; else latHi = mid;
      }
      even = !even;
    }
  }
  return { minLat: latLo, minLng: lngLo, maxLat: latHi, maxLng: lngHi };
}

export function areaCenter(id: AreaId): LngLat {
  const b = areaBounds(id);
  return { lat: (b.minLat + b.maxLat) / 2, lng: (b.minLng + b.maxLng) / 2 };
}

/** The (up to eight) cells touching `id`, sorted. Fewer at the poles. */
export function areaNeighbors(id: AreaId): AreaId[] {
  const b = areaBounds(id);
  const c = areaCenter(id);
  const dLat = b.maxLat - b.minLat;
  const dLng = b.maxLng - b.minLng;
  const out = new Set<AreaId>();
  for (const dy of [-1, 0, 1]) {
    const lat = c.lat + dy * dLat;
    if (lat > 90 || lat < -90) continue;
    for (const dx of [-1, 0, 1]) {
      if (dx === 0 && dy === 0) continue;
      out.add(areaId({ lat, lng: c.lng + dx * dLng }, id.length));
    }
  }
  out.delete(id);
  return [...out].sort();
}

/** The cell a traveler is in, then its neighbours: what a client asks for. */
export function areasAround(p: LngLat, precision = AREA_PRECISION): AreaId[] {
  const home = areaId(p, precision);
  return [home, ...areaNeighbors(home)];
}

/** Every cell a ring passes through: its vertices, its edges sampled at half a cell, and its centroid. */
export function ringAreas(ring: PolygonRing, precision = AREA_PRECISION): AreaId[] {
  const out = new Set<AreaId>();
  const first = ring[0];
  if (!first) return [];
  const b = areaBounds(areaId(first, precision));
  const step = Math.min(b.maxLat - b.minLat, b.maxLng - b.minLng) / 2;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const z = ring[(i + 1) % ring.length]!;
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(z.lat - a.lat), Math.abs(z.lng - a.lng)) / step));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      out.add(areaId({ lat: a.lat + (z.lat - a.lat) * t, lng: a.lng + (z.lng - a.lng) * t }, precision));
    }
  }
  out.add(areaId(ringCentroid(ring), precision));
  return [...out].sort();
}

/** The cells a trigger can fire in: its centre and radius for a point, its fence for an area. */
export function triggerAreas(t: GeoTrigger, precision = AREA_PRECISION): AreaId[] {
  const out = new Set<AreaId>();
  if (t.region) for (const id of ringAreas(t.region, precision)) out.add(id);
  if (t.kind !== "area" && t.center) {
    const { lat, lng } = t.center;
    const dLat = t.radiusM / 111_320;
    const dLng = t.radiusM / (111_320 * Math.max(Math.cos((lat * Math.PI) / 180), 1e-6));
    for (const p of [
      { lat, lng },
      { lat: Math.min(90, lat + dLat), lng },
      { lat: Math.max(-90, lat - dLat), lng },
      { lat, lng: lng + dLng },
      { lat, lng: lng - dLng },
    ]) out.add(areaId(p, precision));
  }
  return [...out].sort();
}

/** The union of a set of triggers' cells, sorted: a track's footprint in the catalog. */
export function areasOf(triggers: Iterable<GeoTrigger>, precision = AREA_PRECISION): AreaId[] {
  const out = new Set<AreaId>();
  for (const t of triggers) for (const id of triggerAreas(t, precision)) out.add(id);
  return [...out].sort();
}
