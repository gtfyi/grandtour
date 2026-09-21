import { z } from "zod";

/**
 * Geo primitives for GrandTour location triggers.
 *
 * All coordinates are WGS84 (lat/lng degrees). Distances are meters.
 * These shapes map directly onto PostGIS GEOGRAPHY columns server-side:
 *   - LngLat            -> GEOGRAPHY(Point, 4326)
 *   - Polygon ring      -> GEOGRAPHY(Polygon, 4326)
 */

export const Latitude = z.number().min(-90).max(90);
export const Longitude = z.number().min(-180).max(180);

/** A single coordinate. Note the field order: lat then lng (human-readable). */
export const LngLat = z.object({
  lat: Latitude,
  lng: Longitude,
});
export type LngLat = z.infer<typeof LngLat>;

/**
 * A polygon as a single outer ring of coordinates (no holes for v1).
 * The ring need not repeat its first point; the server closes it.
 * Minimum 3 distinct vertices.
 */
export const PolygonRing = z.array(LngLat).min(3);
export type PolygonRing = z.infer<typeof PolygonRing>;

/**
 * A location trigger: how a spot decides the user is "here" — and, just as
 * much, how the app schedules it. The kind is scheduling semantics, not only
 * geometry:
 *
 * - `point` — "you have arrived somewhere": fires within `radiusM` of
 *   `center` (or inside the optional precise `region` boundary — either
 *   match is a hit), plays promptly with locating audio. The default, and
 *   the shape every pre-kind spot parses as.
 * - `area` — "this is relevant anywhere in this fence": playable whenever
 *   the traveler is inside the `region` polygon, but only scheduled into
 *   narration gaps (like fill-ins, with priority over them). No arrival
 *   moment, no locating.
 * - `anywhere` — reserved: content with no geometry at all. Accepted by the
 *   schema so the wire shape is future-proof, but rejected at authoring time
 *   for now (nothing serves it yet — use a fill-in track, or an `area` fence
 *   around the whole region of interest).
 */
export const TriggerKind = z.enum(["point", "area", "anywhere"]);
export type TriggerKind = z.infer<typeof TriggerKind>;

export const GeoTrigger = z
  .object({
    /** Missing on old data; defaults to `point` (the original semantics). */
    kind: TriggerKind.default("point"),
    /**
     * `point`: the trigger center (required). `area`: a representative
     * coordinate for map pins and route ordering — the server fills it with
     * the fence's centroid when omitted; it plays no part in triggering.
     */
    center: LngLat.optional(),
    /** Meters. Fires a `point` trigger. Default 80m (a city block-ish). */
    radiusM: z.number().positive().max(50_000).default(80),
    /**
     * `point`: optional precise boundary; containment also triggers.
     * `area`: the fence itself (required).
     */
    region: PolygonRing.optional(),
  })
  .superRefine((t, ctx) => {
    if (t.kind === "point" && !t.center) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "point trigger requires center" });
    }
    if (t.kind === "area" && !t.region) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "area trigger requires region (the fence polygon)",
      });
    }
  })
  .describe("Where a spot activates as the user moves through space.");
export type GeoTrigger = z.infer<typeof GeoTrigger>;

/**
 * Planar centroid of a polygon ring — a representative point for map pins,
 * distance sorting, and route ordering, NOT trigger math (PostGIS owns that).
 * Adequate at town scale; degenerate rings fall back to the vertex mean.
 */
export function ringCentroid(ring: PolygonRing): LngLat {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % ring.length]!;
    const cross = p.lng * q.lat - q.lng * p.lat;
    a += cross;
    cx += (p.lng + q.lng) * cross;
    cy += (p.lat + q.lat) * cross;
  }
  if (Math.abs(a) < 1e-12) {
    return {
      lat: ring.reduce((s, p) => s + p.lat, 0) / ring.length,
      lng: ring.reduce((s, p) => s + p.lng, 0) / ring.length,
    };
  }
  return { lng: cx / (3 * a), lat: cy / (3 * a) };
}

/**
 * The trigger's representative coordinate: its center when present, else the
 * area fence's centroid. Null only for `anywhere` triggers, which nothing
 * serves yet — every spot the API returns has an anchor.
 */
export function triggerAnchor(t: GeoTrigger): LngLat | null {
  if (t.center) return t.center;
  if (t.region) return ringCentroid(t.region);
  return null;
}

// ─── Geo math (client-side sim, distance/heading display) ───────────────────
// Server geo lives in PostGIS; these are for the admin drive simulator and
// any lightweight client math. Great-circle, meters, degrees.

const R_EARTH_M = 6_371_000;
const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

/**
 * The one distance the tour logic measures with, on every platform: the
 * flat-earth distance on the WGS84 ellipsoid with the meridional and
 * prime-vertical radii taken at the *observer's* latitude. The phone's
 * `Geo.localDistanceM` is this same arithmetic in the same order (it is what
 * `CLLocation.distance(from:)` computes when its cached local projection is
 * fresh at the observer — CoreLocation itself varies by ~1e-5 with call
 * history, so the tour logic stopped calling it). Within 1e-6 of a true
 * geodesic under 5 km, which is all triggers and scheduling ever look at;
 * not for long spans. Pinned by scripts/scheduler-parity and
 * scripts/trigger-parity.
 */
export function localDistanceM(observer: LngLat, target: LngLat): number {
  const phi = (observer.lat * Math.PI) / 180;
  const s = Math.sin(phi);
  const w = 1 - WGS84_E2 * s * s;
  const n = WGS84_A / Math.sqrt(w);
  const m = (WGS84_A * (1 - WGS84_E2)) / (w * Math.sqrt(w));
  let dLng = target.lng - observer.lng;
  if (dLng > 180) dLng -= 360; else if (dLng < -180) dLng += 360;
  const x = (n * Math.cos(phi) * dLng * Math.PI) / 180;
  const y = (m * (target.lat - observer.lat) * Math.PI) / 180;
  return Math.sqrt(x * x + y * y);
}
const WGS84_A = 6_378_137;
const WGS84_F = 1 / 298.257223563;
const WGS84_E2 = WGS84_F * (2 - WGS84_F);

/** Great-circle distance between two coordinates, in meters (a sphere, ~0.3% off the ellipsoid): display, coarse sorting, and the locator, which the phone also measures spherically. */
export function haversineM(a: LngLat, b: LngLat): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Initial compass bearing from a to b, degrees (0 = north, clockwise). */
export function bearingDeg(a: LngLat, b: LngLat): number {
  const dLng = toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(toRad(b.lat));
  const x =
    Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
    Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Linear interpolation between two coordinates by fraction t in [0,1]. */
export function lerpLngLat(a: LngLat, b: LngLat, t: number): LngLat {
  return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
}

/** Cumulative length (meters) of a polyline, one entry per vertex (first = 0). */
export function cumulativeMeters(path: LngLat[]): number[] {
  const out = [0];
  for (let i = 1; i < path.length; i++) out.push(out[i - 1]! + haversineM(path[i - 1]!, path[i]!));
  return out;
}

/**
 * Point at `distM` meters along a polyline, plus the heading of the segment
 * it falls on. Clamps to the ends. `cum` is cumulativeMeters(path) (pass it in
 * to avoid recomputing every animation frame).
 */
export function pointAlong(
  path: LngLat[],
  cum: number[],
  distM: number,
): { pos: LngLat; headingDeg: number } {
  if (path.length === 0) return { pos: { lat: 0, lng: 0 }, headingDeg: 0 };
  if (path.length === 1) return { pos: path[0]!, headingDeg: 0 };
  const total = cum[cum.length - 1]!;
  const d = Math.max(0, Math.min(distM, total));
  let i = 1;
  while (i < cum.length && cum[i]! < d) i++;
  const segStart = path[i - 1]!;
  const segEnd = path[i]!;
  const segLen = cum[i]! - cum[i - 1]!;
  const t = segLen > 0 ? (d - cum[i - 1]!) / segLen : 0;
  return { pos: lerpLngLat(segStart, segEnd, t), headingDeg: bearingDeg(segStart, segEnd) };
}

/**
 * Order points to visit them all starting from the first, greedily hopping to
 * the nearest unvisited one (a cheap nearest-neighbor tour). Returns indices
 * into the input array. Used to sequence a track's spots into a route.
 */
export function nearestNeighborOrder(points: LngLat[]): number[] {
  if (points.length <= 2) return points.map((_, i) => i);
  const order = [0];
  const seen = new Set([0]);
  while (order.length < points.length) {
    const from = points[order[order.length - 1]!]!;
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < points.length; i++) {
      if (seen.has(i)) continue;
      const d = haversineM(from, points[i]!);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    order.push(best);
    seen.add(best);
  }
  return order;
}

/**
 * Point-in-polygon test (ray casting) for a ring in lng/lat degrees. Planar,
 * not geodesic — adequate at town scale for client-side trigger-kind `area`
 * containment (e.g. the static tour viewer), NOT a replacement for
 * PostGIS's `ST_Covers`, which remains the source of truth server-side.
 */
export function pointInRing(p: LngLat, ring: PolygonRing): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    const intersects =
      a.lat > p.lat !== b.lat > p.lat &&
      p.lng < ((b.lng - a.lng) * (p.lat - a.lat)) / (b.lat - a.lat) + a.lng;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Approximate area (m²) of a lat/lng ring: shoelace with a cosine latitude
 * correction, fine at town scale. The gap planner prefers the most specific
 * ambient fence (a neighbourhood over a county). Mirrors
 * `TriggerEvaluator.approxAreaM2` on the phone.
 */
export function ringAreaM2(ring: PolygonRing | null | undefined): number {
  if (!ring || ring.length < 3) return Infinity;
  const mPerDegLat = 111_320;
  const midLat = ring.reduce((sum, p) => sum + p.lat, 0) / ring.length;
  const mPerDegLng = mPerDegLat * Math.cos((midLat * Math.PI) / 180);
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!, q = ring[(i + 1) % ring.length]!;
    sum += p.lng * mPerDegLng * (q.lat * mPerDegLat) - q.lng * mPerDegLng * (p.lat * mPerDegLat);
  }
  return Math.abs(sum) / 2;
}

/** A bounding box query input (admin map viewport, or coarse prefilter). */
export const BBox = z.object({
  minLat: Latitude,
  minLng: Longitude,
  maxLat: Latitude,
  maxLng: Longitude,
});
export type BBox = z.infer<typeof BBox>;
