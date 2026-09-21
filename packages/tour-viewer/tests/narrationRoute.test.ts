import { describe, expect, test } from "bun:test";
import { TrackExport, type GeoTrigger } from "@grandtour/shared";
import fixture from "./fixtures/sample.grandtour.json";
import { arrivalsBetween, planNarrationStops } from "../src/narrationRoute";
import { isTriggered, type StaticSpot } from "../src/nearby";

const bundle = TrackExport.parse(fixture);
const template = bundle.spots.find((s) => s.content.some((c) => c.audioUrl))!;
const road = [{ lat: 0, lng: -0.01 }, { lat: 0, lng: 0.01 }];
function source(trigger: GeoTrigger): StaticSpot {
  return { ...template, spot: { ...template.spot, trigger } };
}
const point = () => source({ kind: "point", center: { lat: 0, lng: 0 }, radiusM: 20 });

describe("route narration arrivals", () => {
  test("detects a narrow trigger crossed between sparse route vertices", () => {
    const s = point();
    expect(road.every((pos) => !isTriggered(pos, s.spot))).toBe(true);
    const stops = planNarrationStops(bundle.track, [s], road);
    expect(stops).toHaveLength(1);
    expect(stops[0]!.distM).toBeCloseTo(1092.05, 0);
    expect(stops[0]!.item.triggered).toBe(true);
    expect(arrivalsBetween(stops, 0, 1500)).toHaveLength(1);
    expect(arrivalsBetween(stops, 1500, 2000)).toHaveLength(0);
  });
  test("keeps later entrances on loops and does not duplicate shared vertices", () => {
    const stops = planNarrationStops(bundle.track, [point()], [...road, { lat: 0, lng: 0 }, road[0]!]);
    expect(stops).toHaveLength(2);
    expect(stops[1]!.distM).toBeGreaterThan(stops[0]!.distM);
    const split = planNarrationStops(bundle.track, [point()], [road[0]!, { lat: 0, lng: 0 }, road[1]!]);
    expect(split).toHaveLength(1);
  });
  test("finds polygon entry even if the centroid is away from the road", () => {
    const s = source({ kind: "area", radiusM: 0, region: [
      {lat: -0.0001, lng: -0.001}, {lat: -0.0001, lng: 0.001},
      {lat: 0.01, lng: 0.001}, {lat: 0.01, lng: -0.001},
    ] });
    const stops = planNarrationStops(bundle.track, [s], road);
    expect(stops).toHaveLength(1);
    expect(stops[0]!.distM).toBeCloseTo(1000.85, 0);
    expect(stops[0]!.closestRoadPoint).toBe(false);
  });
  test("point fences also trigger outside the circular radius", () => {
    const s = source({ kind: "point", radiusM: 5, center: {lat: 0.009, lng: 0}, region: [
      {lat: -0.001, lng: -0.001}, {lat: -0.001, lng: 0.001},
      {lat: 0.01, lng: 0.001}, {lat: 0.01, lng: -0.001},
    ] });
    expect(planNarrationStops(bundle.track, [s], road)).toHaveLength(1);
  });
  test("custom routes exclude unrelated places; preset tours identify nearest road visits", () => {
    const far = source({ kind: "point", center: {lat: 0.01, lng: 0}, radiusM: 20 });
    expect(planNarrationStops(bundle.track, [far], road)).toHaveLength(0);
    const stops = planNarrationStops(bundle.track, [far], road, true);
    expect(stops).toHaveLength(1);
    expect(stops[0]!.closestRoadPoint).toBe(true);
    expect(stops[0]!.distM).toBeCloseTo(1111.95, 0);
  });
  test("scripts without recordings remain in the plan for device TTS", () => {
    const s = point();
    s.content = s.content.map((c) => ({ ...c, audioUrl: null }));
    expect(planNarrationStops(bundle.track, [s], road)).toHaveLength(1);
    expect(planNarrationStops(bundle.track, [{ ...s, content: [] }], road)).toHaveLength(0);
  });
  test("empty paths and repeated coordinates are safe", () => {
    expect(planNarrationStops(bundle.track, [point()], [])).toHaveLength(0);
    const center = {lat: 0, lng: 0};
    const stops = planNarrationStops(bundle.track, [point()], [center, center]);
    expect(stops).toHaveLength(1);
    expect(stops[0]!.distM).toBe(0);
  });
});

