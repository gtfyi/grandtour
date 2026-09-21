import { expect, test } from "bun:test";
import { GeoTrigger, triggerAnchor } from "@grandtour/shared";
import { triggerFromDraft } from "../src/spotDraft";

test("moving an area pin survives serialization without changing its playback fence", () => {
  const region = [
    { lat: 37.99295, lng: -122.6056 },
    { lat: 37.99295, lng: -122.5938 },
    { lat: 37.9967, lng: -122.5938 },
    { lat: 37.9967, lng: -122.6056 },
  ];
  const center = { lat: 37.9959, lng: -122.5978 };
  const saved = GeoTrigger.parse(JSON.parse(JSON.stringify(triggerFromDraft({
    kind: "area", center, radiusM: 100, region,
  }))));
  expect(triggerAnchor(saved)).toEqual(center);
  expect(saved.kind).toBe("area");
  expect(saved.region).toEqual(region);
});

test("point drafts retain their arrival radius and coordinates", () => {
  const center = { lat: 37.9959, lng: -122.5978 };
  const saved = GeoTrigger.parse(triggerFromDraft({ kind: "point", center, radiusM: 80 }));
  expect(saved).toEqual({ kind: "point", center, radiusM: 80, region: undefined });
});
