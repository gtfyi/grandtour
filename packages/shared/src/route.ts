import type { LngLat } from "./geo";
import { nearestNeighborOrder } from "./geo";

export interface RoutedTrack {
  /** The dense polyline the traveler follows (road-following or straight). */
  path: LngLat[];
  /** Whether OSRM road geometry was used (false = straight-line fallback). */
  onRoads: boolean;
  /** The spot order the route visits (indices into the input spots). */
  order: number[];
}

/**
 * Build a drive route through the given waypoints (spot centers, or a
 * custom start/destination pair). Orders them nearest-neighbour from the
 * first (a no-op for exactly two waypoints), then asks the public OSRM demo
 * server for road geometry. Falls back to straight segments if OSRM is
 * unreachable or returns nothing — the caller can tell which via `onRoads`.
 *
 * OSRM demo server: no key, rate-limited, not for production. Swap the base
 * URL for a self-hosted OSRM or a keyed provider later.
 */
const OSRM_BASE = "https://router.project-osrm.org/route/v1/driving";

export async function buildRoute(waypoints: LngLat[]): Promise<RoutedTrack> {
  if (waypoints.length === 0) return { path: [], onRoads: false, order: [] };
  if (waypoints.length === 1) {
    return { path: [waypoints[0]!], onRoads: false, order: [0] };
  }

  const order = nearestNeighborOrder(waypoints);
  const ordered = order.map((i) => waypoints[i]!);
  const straight: RoutedTrack = { path: ordered, onRoads: false, order };

  try {
    const coords = ordered.map((p) => `${p.lng},${p.lat}`).join(";");
    const url = `${OSRM_BASE}/${coords}?overview=full&geometries=geojson`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return straight;
    const data = (await res.json()) as {
      routes?: Array<{ geometry?: { coordinates?: [number, number][] } }>;
    };
    const line = data.routes?.[0]?.geometry?.coordinates;
    if (!line || line.length < 2) return straight;
    return {
      path: line.map(([lng, lat]) => ({ lat, lng })),
      onRoads: true,
      order,
    };
  } catch {
    return straight; // offline / rate-limited / blocked → straight lines
  }
}

/** Speed presets, mph → m/s, with a label for the UI. */
export const SPEED_PRESETS = [
  { label: "Walk · 2 mph", mph: 2 },
  { label: "Walk · 3 mph", mph: 3 },
  { label: "Drive · 25 mph", mph: 25 },
  { label: "Drive · 45 mph", mph: 45 },
  { label: "Drive · 65 mph", mph: 65 },
] as const;

export const mphToMps = (mph: number) => mph * 0.44704;
