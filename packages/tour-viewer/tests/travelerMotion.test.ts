import { expect, test } from "bun:test";
import {
  MAX_TRAVELER_FRAME_MS,
  TRAVELER_RESPONSE_MS,
  smoothHeading,
  smoothTravelerPosition,
  travelerFrameElapsed,
} from "../src/travelerMotion";

test("traveler motion is smooth and independent of frame subdivision", () => {
  const start = { lat: 0, lng: 0 };
  const target = { lat: 10, lng: -20 };
  const oneFrame = smoothTravelerPosition(start, target, TRAVELER_RESPONSE_MS);
  let manyFrames = start;
  for (let i = 0; i < 13; i++) {
    manyFrames = smoothTravelerPosition(manyFrames, target, 20);
  }
  expect(manyFrames.lat).toBeCloseTo(oneFrame.lat, 10);
  expect(manyFrames.lng).toBeCloseTo(oneFrame.lng, 10);
  expect(smoothTravelerPosition(start, target, 0)).toEqual(start);
});

test("traveler motion spreads recovery from a delayed frame across later frames", () => {
  expect(travelerFrameElapsed(16)).toBe(16);
  expect(travelerFrameElapsed(250)).toBe(MAX_TRAVELER_FRAME_MS);
  expect(travelerFrameElapsed(-1)).toBe(0);

  const start = { lat: 0, lng: 0 };
  const target = { lat: 10, lng: 10 };
  const recovered = smoothTravelerPosition(start, target, travelerFrameElapsed(250));
  const uncapped = smoothTravelerPosition(start, target, 250);
  expect(recovered.lat).toBeLessThan(uncapped.lat);
});

test("heading follow takes the shortest path across north", () => {
  const next = smoothHeading(350, 10, 160);
  expect((next - 350 + 360) % 360).toBeGreaterThan(0);
  expect((next - 350 + 360) % 360).toBeLessThan(20);
  const reverse = smoothHeading(10, 350, 160);
  expect((10 - reverse + 360) % 360).toBeGreaterThan(0);
  expect((10 - reverse + 360) % 360).toBeLessThan(20);
  expect(smoothHeading(42, 180, 0)).toBe(42);
});
