import type { ContentPiece, LngLat, LocatingResolved, NearbySpot, Spot, Track } from "@grandtour/shared";
import {
  DEFAULT_LOCATING_TEMPLATE,
  SIDE_TOKEN,
  bearingDeg,
  haversineM,
  localDistanceM,
  locatingTemplate,
  pointInRing,
  ringCentroid,
  sectorAt,
  triggerAnchor,
} from "@grandtour/shared";

/**
 * Client-side mirror of `findNearby` (server/src/geo/queries.ts) and its
 * `NearbySpot` shaping, built entirely from pure functions already in
 * @grandtour/shared — trigger distances are `localDistanceM`, the phone's
 * own arithmetic; the locating sector is spherical like `SpotLocator`. This is what lets the viewer answer "what's near me, and is it
 * triggered?" from a static bundle with no server round-trip.
 *
 * Known divergence from the server: outside an area spot's fence the
 * distance is to its centroid rather than PostGIS's exact distance-to-polygon
 * (the phone measures the same way), and point-in-region is a planar ray
 * cast, not geodesic `ST_Covers`. Adequate at town scale.
 */

const DEFAULT_LIMIT = 50;

/**
 * Distance from `pos` to a spot's trigger, as the phone and the server
 * measure it: a point spot to its centre; an area spot 0 while inside its
 * fence (so ambient spots never read as "far away"), else to its centre,
 * the server-computed centroid. Pinned to `TriggerEvaluator.evaluate` by
 * scripts/trigger-parity.
 */
export function distanceToSpot(pos: LngLat, spot: Spot): number {
  const { trigger } = spot;
  if (trigger.kind === "area") {
    if (trigger.region && pointInRing(pos, trigger.region)) return 0;
    const anchor = trigger.center ?? (trigger.region ? ringCentroid(trigger.region) : null);
    return anchor ? localDistanceM(pos, anchor) : Infinity;
  }
  const anchor = triggerAnchor(trigger);
  return anchor ? localDistanceM(pos, anchor) : Infinity;
}

export function isTriggered(pos: LngLat, spot: Spot): boolean {
  const { trigger } = spot;
  if (trigger.kind === "area") {
    return trigger.region ? pointInRing(pos, trigger.region) : false;
  }
  const anchor = triggerAnchor(trigger);
  const withinRadius = anchor ? localDistanceM(pos, anchor) <= trigger.radiusM : false;
  const withinRegion = trigger.region ? pointInRing(pos, trigger.region) : false;
  return withinRadius || withinRegion;
}

/** Best published content for this spot: prefer locale "en", else first. */
export function pickContent(pieces: ContentPiece[]): ContentPiece | null {
  return pieces.find((c) => c.locale === "en" && c.audioUrl)
    ?? pieces.find((c) => c.audioUrl)
    ?? pieces.find((c) => c.locale === "en") ?? pieces[0] ?? null;
}

/**
 * Resolve the locating instruction for this traveler, mirroring the
 * server's preference for a pre-rendered clip over a synthesized phrase.
 */
function resolveLocating(
  pos: LngLat,
  spot: Spot,
  courseDeg: number | null,
): LocatingResolved | null {
  const tpl = locatingTemplate(spot.locating);
  if (!tpl) return null;
  const anchor = triggerAnchor(spot.trigger);
  if (!anchor) return null;

  const directional = tpl.includes(SIDE_TOKEN);
  if (directional) {
    if (courseDeg == null) return null; // side unknown — same rule as /nearby
    const bearing = bearingDeg(pos, anchor);
    const s = sectorAt(bearing - courseDeg, haversineM(pos, anchor));
    const side: "left" | "right" =
      s === "left" || s === "behindLeft" || s === "aheadLeft" ? "left" : "right";
    const clip = spot.locating.clips?.[side];
    if (clip) return clip;
    return { text: tpl.replaceAll(SIDE_TOKEN, side), audioUrl: null, durationMs: null };
  }

  const clip = spot.locating.clips?.fixed;
  if (clip) return clip;
  return { text: tpl, audioUrl: null, durationMs: null };
}

export interface StaticSpot {
  spot: Spot;
  content: ContentPiece[];
}

/**
 * Recompute "what's nearby" from a static bundle, shape-compatible with the
 * server's `NearbySpot[]` (minus `guide`, which the export bundle doesn't
 * carry — guides are a booking-lead feature out of scope for a static
 * preview). Every published spot is included regardless of distance; the
 * caller decides whether to gate display on distance (free-explore mode
 * shows everything, GPS/drive modes can filter/sort by it).
 */
export function computeNearby(
  track: Track,
  spots: StaticSpot[],
  pos: LngLat,
  courseDeg: number | null,
  limit = DEFAULT_LIMIT,
): NearbySpot[] {
  return spots
    .map(({ spot, content }): NearbySpot => ({
      spot,
      track,
      locating: resolveLocating(pos, spot, courseDeg),
      distanceM: distanceToSpot(pos, spot),
      triggered: isTriggered(pos, spot),
      content: pickContent(content),
      guide: null,
    }))
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, limit);
}

export { DEFAULT_LOCATING_TEMPLATE };
