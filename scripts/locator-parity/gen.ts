/**
 * Golden-case generator for the TS↔Swift locator parity check.
 * Emits a broad deterministic grid of inputs with the TS module's output;
 * run.sh compiles the Swift mirror and diffs. See locate.ts header.
 */
import { describeSpotLocation } from "../../packages/shared/src/locate";

const BASES = [
  { lat: 37.9869794, lng: -122.5893495 }, // Fairfax (real track)
  { lat: -33.8688, lng: 151.2093 },       // southern hemisphere, for trig signs
];
const DISTANCES = [3, 12, 37, 90, 152, 420, 980, 1840, 5000];
const BEARINGS = Array.from({ length: 12 }, (_, i) => i * 30 + 7); // off-axis
const COURSES = [null, 0, 33, 90, 179, 245, 310];
const ANCHORS = [null, "at the corner of Bolinas Road and Broadway", "a large black building"];

function offset(base: { lat: number; lng: number }, meters: number, bearing: number) {
  const rad = Math.PI / 180;
  return {
    lat: base.lat + (meters * Math.cos(bearing * rad)) / 111_320,
    lng: base.lng + (meters * Math.sin(bearing * rad)) / (111_320 * Math.cos(base.lat * rad)),
  };
}

const cases = [];
let i = 0;
for (const base of BASES)
  for (const d of DISTANCES)
    for (const b of BEARINGS)
      for (const course of COURSES) {
        const user = offset(base, d, b);
        const input = {
          spotLat: base.lat, spotLng: base.lng,
          userLat: user.lat, userLng: user.lng,
          courseDeg: course,
          anchor: ANCHORS[i++ % ANCHORS.length]!,
          metric: i % 2 === 0,
        };
        cases.push({ ...input, expect: describeSpotLocation(input) });
      }

console.log(JSON.stringify(cases));
