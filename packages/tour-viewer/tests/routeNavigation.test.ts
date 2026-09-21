import { expect, test } from "bun:test";
import { TrackExport, cumulativeMeters, pointAlong } from "@grandtour/shared";
import rawBundle from "./fixtures/sample.grandtour.json";
import { computeNearby, isTriggered } from "../src/nearby";
import { planNarrationStops } from "../src/narrationRoute";
import { nextRouteStop, previousRouteStop, reverseRoute } from "../src/routeNavigation";

const bundle = TrackExport.parse(rawBundle);
const items = computeNearby(bundle.track, bundle.spots, bundle.spots[0]!.spot.trigger.center!, 0).slice(0, 3);
const stops = items.map((item, i) => ({ item, distM: i * 100, closestRoadPoint: false }));

test("forward navigation skips passed/current/heard stops and ends without wrapping", () => {
  expect(nextRouteStop(stops, 0, () => true)).toBe(stops[0]);
  expect(nextRouteStop(stops, 1, () => true)).toBe(stops[1]);
  expect(nextRouteStop(stops, 0, (item) => item.spot.id === items[2]!.spot.id)).toBe(stops[2]);
  expect(nextRouteStop(stops, 201, () => true)).toBeUndefined();
});

test("back revisits the previous distinct story, including co-located entrances", () => {
  expect(previousRouteStop(stops, 150, items[1]!.spot.id)).toBe(stops[0]);
  expect(previousRouteStop(stops, 150, null)).toBe(stops[1]);
  expect(previousRouteStop(stops, 0, items[0]!.spot.id)).toBeUndefined();
  const together = stops.map((stop) => ({ ...stop, distM: 0 }));
  expect(previousRouteStop(together, 0, items[1]!.spot.id)).toBe(together[0]);
  expect(previousRouteStop(together, 0, items[0]!.spot.id)).toBeUndefined();
});

test("reverse preset reverses path and stop order without mutating the original", () => {
  const route = { path: [{ lat: 38, lng: -122 }, { lat: 38.1, lng: -122.1 }], order: [0, 1], onRoads: true };
  const reversed = reverseRoute(route);
  expect(reversed.path[0]).toEqual(route.path[1]);
  expect(reversed.order).toEqual([1, 0]);
  expect(route.order).toEqual([0, 1]);
  expect(reverseRoute(reversed)).toEqual(route);
});

test("jump targets land within actual triggers rather than a passed or nearest-road arrival", () => {
  const source = bundle.spots[0]!;
  const center = source.spot.trigger.center!;
  const path = [{ lat: center.lat, lng: center.lng - 0.005 }, { lat: center.lat, lng: center.lng + 0.005 }];
  for (const route of [path, [...path].reverse()]) {
    const plan = planNarrationStops(bundle.track, [source], route);
    const stop = nextRouteStop(plan, 0, () => true)!;
    expect(stop).toBeDefined();
    expect(isTriggered(pointAlong(route, cumulativeMeters(route), stop.distM).pos, source.spot)).toBe(true);
  }
});
