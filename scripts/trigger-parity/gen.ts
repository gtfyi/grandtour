/**
 * Golden-case generator for the TS↔Swift trigger parity check: point and
 * area triggers evaluated at positions inside, on, and beyond their
 * geometry, with the web's `isTriggered` and `distanceToSpot`. run.sh
 * replays them through the phone's `TriggerEvaluator.evaluate`. See the
 * "Trigger-kind evaluation" invariant in CLAUDE.md.
 */
import type { GeoTrigger, LngLat, Spot } from "../../packages/shared/src/content";
import { ringCentroid } from "../../packages/shared/src/geo";
import { distanceToSpot, isTriggered } from "../../packages/tour-viewer/src/nearby";

const base: LngLat = { lat: 37.9871, lng: -122.5889 };
const rad = Math.PI / 180;
const offset = (from: LngLat, meters: number, bearing: number): LngLat => ({
  lat: from.lat + (meters * Math.cos(bearing * rad)) / 111_320,
  lng: from.lng + (meters * Math.sin(bearing * rad)) / (111_320 * Math.cos(from.lat * rad)),
});
const square = (center: LngLat, halfM: number) => [
  offset(offset(center, halfM, 0), halfM, 270), offset(offset(center, halfM, 0), halfM, 90),
  offset(offset(center, halfM, 180), halfM, 90), offset(offset(center, halfM, 180), halfM, 270),
];

const triggers: Array<{ name: string; trigger: GeoTrigger }> = [
  { name: "point-40", trigger: { kind: "point", center: base, radiusM: 40 } },
  { name: "point-250", trigger: { kind: "point", center: base, radiusM: 250 } },
  { name: "point-with-region", trigger: { kind: "point", center: base, radiusM: 20, region: square(base, 120) } },
  { name: "area-town", trigger: { kind: "area", center: ringCentroid(square(base, 300)), radiusM: 0, region: square(base, 300) } },
  { name: "area-county", trigger: { kind: "area", center: ringCentroid(square(base, 5000)), radiusM: 0, region: square(base, 5000) } },
  { name: "area-southern", trigger: (() => { const c = { lat: -33.8688, lng: 151.2093 }; return { kind: "area", center: ringCentroid(square(c, 800)), radiusM: 0, region: square(c, 800) } as GeoTrigger; })() },
];
const spot = (trigger: GeoTrigger): Spot => ({
  id: "s", trackId: "t", slug: "s", title: "S", subtitle: "", trigger, modes: [],
  locating: { mode: "auto", clips: {} }, status: "published", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
});

const cases = [];
for (const { name, trigger } of triggers) {
  const c = trigger.center!;
  const positions: Array<[string, LngLat]> = [["centre", c]];
  for (const d of [10, 39, 41, 100, 119, 121, 299, 301, 400, 1500, 4999, 5001, 20_000])
    for (const b of [0, 45, 90, 200, 315]) positions.push([`${d}m@${b}`, offset(c, d, b)]);
  for (const [where, pos] of positions) {
    const s = spot(trigger);
    cases.push({ name, where, trigger, pos, expect: { triggered: isTriggered(pos, s), distanceM: distanceToSpot(pos, s) } });
  }
}
console.log(JSON.stringify(cases));
