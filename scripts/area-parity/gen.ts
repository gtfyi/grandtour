/**
 * Golden-case generator for the TS↔Swift area-cell parity check: a grid of
 * positions (both hemispheres, the poles, the antimeridian) at several
 * precisions, with the TS module's cell, bounds and neighbours. run.sh
 * compiles the Swift mirror and diffs. See area.ts header.
 */
import { areaBounds, areaId, areaNeighbors } from "../../packages/shared/src/area";

const LATS = [-89.99, -60, -33.8688, -0.0001, 0, 37.9871, 48.6855, 60, 89.99, 90];
const LNGS = [-180, -179.99, -122.5889, -113.7037, -0.0001, 0, 10.40744, 151.2093, 179.99, 180];
const PRECISIONS = [1, 3, 4, 5, 7];

const cases = [];
for (const lat of LATS)
  for (const lng of LNGS)
    for (const precision of PRECISIONS) {
      const id = areaId({ lat, lng }, precision);
      cases.push({ lat, lng, precision, id, bounds: areaBounds(id), neighbors: areaNeighbors(id) });
    }
console.log(JSON.stringify(cases));
