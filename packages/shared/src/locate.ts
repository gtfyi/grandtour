/**
 * Deterministic spot locator: given where the traveler is, which way they're
 * moving, and where a spot is, produce one sentence that places the spot
 * relative to them — computed at the moment it's needed, so it's correct even
 * when a queued narration plays long after its trigger fired.
 *
 *   "Coming up in 500 feet on your right, at the corner of Bolinas and Broadway."
 *   "Back 150 meters on your left — a large black building."
 *   "About 200 meters to the northeast."   (no course known)
 *
 * The geometry phrase is pure math; the optional `anchor` is per-spot authored
 * text (address, corner, visual description) appended verbatim.
 *
 * This module is mirrored in Swift (ios/Sources/SpotLocator.swift) so the
 * phone can compute phrases at play time, offline. The two implementations
 * are pinned together by a golden-case parity test — any change here must be
 * made there too, and the tables below are the contract.
 *
 * Note on the "PostGIS owns geo math" invariant: that governs *queries*.
 * This is presentation math over one pair of points, and it must run on the
 * phone with no server; both implementations use the same haversine so they
 * produce byte-identical text.
 */

export interface LocateInput {
  spotLat: number;
  spotLng: number;
  userLat: number;
  userLng: number;
  /** Direction of travel, compass degrees (0 = north); null when unknown. */
  courseDeg: number | null;
  /** Per-spot anchor text, e.g. "at the corner of X and Y". */
  anchor: string | null;
  /** true → meters/kilometers; false → feet/miles. */
  metric: boolean;
}

import { bearingDeg, haversineM } from "./geo";

/** The traveler-relative sector for a bearing given a course. */
export type Sector =
  | "ahead" | "aheadRight" | "right" | "behindRight"
  | "behind" | "behindLeft" | "left" | "aheadLeft";

export function sector(relDeg: number): Sector {
  const r = ((relDeg % 360) + 360) % 360;
  if (r < 15 || r >= 345) return "ahead";
  if (r < 75) return "aheadRight";
  if (r < 105) return "right";
  if (r < 165) return "behindRight";
  if (r < 195) return "behind";
  if (r < 255) return "behindLeft";
  if (r < 285) return "left";
  return "aheadLeft";
}

/**
 * "Ahead"/"behind" are corridors, not cones. The ±15° ahead cone alone is
 * ~50 m wide at 200 m out, so on a street it calls storefronts across the
 * road "straight ahead" — but the traveler will arrive with them on a side.
 * Those sectors additionally require the spot to lie within CORRIDOR_M of
 * the traveler's line of travel; anything wider resolves to its side.
 */
export const CORRIDOR_M = 10;

export function sectorAt(relDeg: number, distanceM: number): Sector {
  const s = sector(relDeg);
  if (s !== "ahead" && s !== "behind") return s;
  // Signed lateral offset from the course line: positive = right of it.
  const lateral = distanceM * Math.sin((relDeg * Math.PI) / 180);
  if (Math.abs(lateral) <= CORRIDOR_M) return s;
  if (s === "ahead") return lateral > 0 ? "aheadRight" : "aheadLeft";
  return lateral > 0 ? "behindRight" : "behindLeft";
}

const WINDS = [
  "north", "northeast", "east", "southeast",
  "south", "southwest", "west", "northwest",
] as const;

export function cardinal(bearing: number): string {
  const b = ((bearing % 360) + 360) % 360;
  return WINDS[Math.floor(((b + 22.5) % 360) / 45)]!;
}

/**
 * Distance rendered navigation-style. Rounding table (the parity contract):
 *   metric:   <100 m → nearest 10 m; <1000 m → nearest 50 m (1000 promotes
 *             to km); else kilometers to one decimal.
 *   imperial: <100 ft → nearest 10 ft; <1000 ft → nearest 100 ft (1000
 *             promotes to miles); else miles to one decimal.
 */
export function distancePhrase(meters: number, metric: boolean): string {
  if (metric) {
    if (meters < 100) return `${Math.round(meters / 10) * 10} meters`;
    const m = Math.round(meters / 50) * 50;
    if (m < 1000) return `${m} meters`;
    return `${(meters / 1000).toFixed(1)} kilometers`;
  }
  const ft = meters * 3.28084;
  if (ft < 100) return `${Math.round(ft / 10) * 10} feet`;
  const f = Math.round(ft / 100) * 100;
  if (f < 1000) return `${f} feet`;
  return `${(ft / 5280).toFixed(1)} miles`;
}

/** How the anchor glues on: prepositional anchors read on with a comma. */
function joinAnchor(phrase: string, anchor: string | null): string {
  if (!anchor) return `${phrase}.`;
  const a = anchor.trim();
  if (!a) return `${phrase}.`;
  const prepositional = /^(at|on|near|by|in|behind|across|opposite)\s/i.test(a);
  return prepositional ? `${phrase}, ${a}.` : `${phrase} — ${a}.`;
}

/** Within this, the traveler is effectively at the spot. */
const HERE_M = 15;

/**
 * The one-sentence locator. Deterministic: same inputs, same text, in both
 * languages.
 */
export function describeSpotLocation(input: LocateInput): string {
  const user = { lat: input.userLat, lng: input.userLng };
  const spot = { lat: input.spotLat, lng: input.spotLng };
  const d = haversineM(user, spot);
  const bearing = bearingDeg(user, spot);
  const dist = distancePhrase(d, input.metric);

  if (input.courseDeg == null) {
    if (d < HERE_M) return joinAnchor("Right here", input.anchor);
    return joinAnchor(`About ${dist} to the ${cardinal(bearing)}`, input.anchor);
  }

  const s = sectorAt(bearing - input.courseDeg, d);

  if (d < HERE_M) {
    switch (s) {
      case "right": return joinAnchor("Right here on your right", input.anchor);
      case "left": return joinAnchor("Right here on your left", input.anchor);
      case "behind": case "behindRight": case "behindLeft":
        return joinAnchor("Right here, just behind you", input.anchor);
      default: return joinAnchor("Right here", input.anchor);
    }
  }

  switch (s) {
    case "ahead":
      return joinAnchor(`Coming up in ${dist}, straight ahead`, input.anchor);
    case "aheadRight":
      return joinAnchor(`Coming up in ${dist} on your right`, input.anchor);
    case "aheadLeft":
      return joinAnchor(`Coming up in ${dist} on your left`, input.anchor);
    case "right":
      return joinAnchor(`To your right, about ${dist} away`, input.anchor);
    case "left":
      return joinAnchor(`To your left, about ${dist} away`, input.anchor);
    case "behindRight":
      return joinAnchor(`Back ${dist} on your right`, input.anchor);
    case "behindLeft":
      return joinAnchor(`Back ${dist} on your left`, input.anchor);
    case "behind":
      return joinAnchor(`${dist} behind you`, input.anchor);
  }
}
