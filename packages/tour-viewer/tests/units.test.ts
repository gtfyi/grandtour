import { expect, test } from "bun:test";
import { formatDistance, formatSpeed } from "../src/units";

test("imperial distance uses feet nearby and miles along a route", () => {
  expect(formatDistance(30.48, "imperial")).toBe("100 ft");
  expect(formatDistance(1609.344, "imperial")).toBe("1.0 mi");
});
test("metric converts the same physical distance and speed", () => {
  expect(formatDistance(50, "metric")).toBe("50 m");
  expect(formatDistance(1609.344, "metric")).toBe("1.6 km");
  expect(formatSpeed(25, "metric")).toBe("40 km/h");
  expect(formatSpeed(25, "imperial")).toBe("25 mph");
});
