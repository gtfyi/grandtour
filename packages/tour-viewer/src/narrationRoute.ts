import type { LngLat, NearbySpot, Track } from "@grandtour/shared";
import { bearingDeg, cumulativeMeters, haversineM, triggerAnchor } from "@grandtour/shared";
import { computeNearby, isTriggered, pickContent, type StaticSpot } from "./nearby";

export interface NarrationStop {
  item: NearbySpot;
  /** Distance along the route at which the trigger is entered. */
  distM: number;
  /** Preset tours can visit the nearest road point of an off-road story. */
  closestRoadPoint: boolean;
}
const interpolate = (a: LngLat, b: LngLat, t: number): LngLat => ({
  lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t,
});

/** Cut at trigger boundaries to catch circles and polygons even when both
 * segment endpoints are outside. Coordinates are local to a town-scale route. */
function triggerCuts(a: LngLat, b: LngLat, source: StaticSpot): number[] {
  const cuts = [0, 1];
  const add = (t: number) => { if (t > 0 && t < 1) cuts.push(t); };
  const trigger = source.spot.trigger;
  const center = triggerAnchor(trigger);
  if (trigger.kind !== "area" && center) {
    const scaleY = 6371000 * Math.PI / 180;
    const scaleX = scaleY * Math.cos(center.lat * Math.PI / 180);
    const x = (a.lng - center.lng) * scaleX, y = (a.lat - center.lat) * scaleY;
    const dx = (b.lng - a.lng) * scaleX, dy = (b.lat - a.lat) * scaleY;
    const aa = dx * dx + dy * dy, bb = 2 * (x * dx + y * dy);
    const cc = x * x + y * y - trigger.radiusM ** 2;
    const discriminant = bb * bb - 4 * aa * cc;
    if (aa > 0 && discriminant >= 0) {
      add((-bb - Math.sqrt(discriminant)) / (2 * aa));
      add((-bb + Math.sqrt(discriminant)) / (2 * aa));
    }
  }
  const ring = trigger.region ?? [];
  for (let i = 0; i < ring.length; i++) {
    const c = ring[i]!, d = ring[(i + 1) % ring.length]!;
    const rx = b.lng - a.lng, ry = b.lat - a.lat;
    const sx = d.lng - c.lng, sy = d.lat - c.lat;
    const cross = rx * sy - ry * sx;
    if (Math.abs(cross) < 1e-18) continue;
    const qx = c.lng - a.lng, qy = c.lat - a.lat;
    const t = (qx * sy - qy * sx) / cross, u = (qx * ry - qy * rx) / cross;
    if (u >= 0 && u <= 1) add(t);
  }
  return cuts.sort((x, y) => x - y);
}

/** Precompute arrivals rather than relying on the latest animation frame.
 * Keep later entrances too, so seeking onto a later loop still works. */
export function planNarrationStops(track: Track, sources: StaticSpot[], path: LngLat[], preset = false): NarrationStop[] {
  if (!path.length) return [];
  const cumulative = cumulativeMeters(path);
  const stops: NarrationStop[] = [];
  for (const source of sources) {
    const content = pickContent(source.content);
    if (!content?.audioUrl && !content?.document?.text.trim()) continue;
    const anchor = triggerAnchor(source.spot.trigger);
    if (!anchor) continue;
    let inside = isTriggered(path[0]!, source.spot);
    let entered = false;
    const add = (pos: LngLat, heading: number, distM: number, closestRoadPoint = false) => {
      const item = computeNearby(track, [source], pos, heading)[0]!;
      stops.push({ item: { ...item, triggered: true }, distM, closestRoadPoint });
      entered = true;
    };
    if (inside) add(path[0]!, path.length > 1 ? bearingDeg(path[0]!, path[1]!) : 0, 0);
    let nearest = { distance: haversineM(anchor, path[0]!), pos: path[0]!, distM: 0, heading: 0 };
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1]!, b = path[i]!;
      const length = cumulative[i]! - cumulative[i - 1]!;
      if (length === 0) continue;
      const heading = bearingDeg(a, b);
      const scale = Math.cos(anchor.lat * Math.PI / 180);
      const dx = (b.lng - a.lng) * scale, dy = b.lat - a.lat;
      const fraction = Math.max(0, Math.min(1,
        (((anchor.lng - a.lng) * scale) * dx + (anchor.lat - a.lat) * dy) / (dx * dx + dy * dy)));
      const projected = interpolate(a, b, fraction);
      const distance = haversineM(anchor, projected);
      if (distance < nearest.distance) nearest = { distance, pos: projected, distM: cumulative[i - 1]! + length * fraction, heading };
      const cuts = triggerCuts(a, b, source);
      for (let j = 1; j < cuts.length; j++) {
        const from = cuts[j - 1]!, to = cuts[j]!;
        if (to - from < 1e-12) continue;
        const inInterval = isTriggered(interpolate(a, b, (from + to) / 2), source.spot);
        if (inInterval && !inside) {
          const t = from + Math.min((to - from) / 2, 0.1 / length);
          add(interpolate(a, b, t), heading, cumulative[i - 1]! + length * t);
        }
        inside = inInterval;
      }
      const endInside = isTriggered(b, source.spot);
      if (endInside && !inside) add(b, heading, cumulative[i]!);
      inside = endInside;
    }
    if (!entered && preset) add(nearest.pos, nearest.heading, nearest.distM, true);
  }
  return stops.sort((a, b) => a.distM - b.distM);
}

export function arrivalsBetween(stops: NarrationStop[], fromM: number, toM: number): NearbySpot[] {
  return stops.filter((s) => s.distM >= fromM && s.distM <= toM).map((s) => s.item);
}
