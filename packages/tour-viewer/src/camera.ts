import type { LngLat } from "@grandtour/shared";

export interface Camera {
  center: LngLat;
  zoom: number;
}

/** Kilometres in a degree of latitude — coarse, for a camera that only has to be about right. */
const KM_PER_DEG = 111.32;

/**
 * The zoom that roughly fits a span: ~360° at zoom 1, halving the span per
 * step, with a step of margin. Coarse on purpose; the viewer can always
 * zoom. No span at all (a single point) is a neighbourhood.
 */
function zoomForSpan(spanDeg: number): number {
  return spanDeg <= 0 ? 14 : Math.max(3, Math.min(15, Math.log2(360 / spanDeg) - 1));
}

/**
 * A camera on a track from its index entry alone — the centre and rough
 * diameter every index carries — so a map can open on the track before its
 * bundle has arrived: a demo's map is built here, not on the world.
 */
export function trackCamera(track: { center: LngLat; spanKm: number }): Camera {
  return { center: track.center, zoom: zoomForSpan(track.spanKm / KM_PER_DEG) };
}

/**
 * A camera that shows every point: the box around them, at a zoom that
 * roughly fits the spread. A single point zooms to a neighbourhood; no
 * points at all looks at the world.
 */
export function fitCamera(points: LngLat[]): Camera {
  if (points.length === 0) return { center: { lat: 0, lng: 0 }, zoom: 1 };
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const p of points) {
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
    minLng = Math.min(minLng, p.lng);
    maxLng = Math.max(maxLng, p.lng);
  }
  const spanDeg = Math.max(maxLat - minLat, maxLng - minLng);
  return { center: { lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2 }, zoom: zoomForSpan(spanDeg) };
}
