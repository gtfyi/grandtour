import { describe, expect, test } from "bun:test";
import { fitCamera, trackCamera } from "../src/camera";

describe("fitCamera", () => {
  test("centres on the box around the points and zooms to their span", () => {
    const fit = fitCamera([{ lat: 48.5, lng: -114.0 }, { lat: 48.7, lng: -113.4 }, { lat: 48.6, lng: -113.7 }]);
    expect(fit.center.lat).toBeCloseTo(48.6);
    expect(fit.center.lng).toBeCloseTo(-113.7);
    expect(fit.zoom).toBeCloseTo(Math.log2(360 / 0.6) - 1);
  });
  test("a track's index entry places the camera on it before its bundle arrives", () => {
    const road = trackCamera({ center: { lat: 48.685, lng: -113.704 }, spanKm: 55.4 });
    expect(road.center).toEqual({ lat: 48.685, lng: -113.704 });
    expect(road.zoom).toBeCloseTo(Math.log2(360 / (55.4 / 111.32)) - 1);
    // About what fitting the road's own spots gives.
    expect(Math.abs(road.zoom - fitCamera([{ lat: 48.50, lng: -113.99 }, { lat: 48.75, lng: -113.43 }]).zoom)).toBeLessThan(0.5);
    expect(trackCamera({ center: { lat: 36.058, lng: -112.140 }, spanKm: 0.7 }).zoom).toBeGreaterThan(road.zoom);
    expect(trackCamera({ center: { lat: 0, lng: 0 }, spanKm: 0 }).zoom).toBe(14);
  });
  test("one point is a neighbourhood; none is the world; a continent stays wide", () => {
    expect(fitCamera([{ lat: 37.98, lng: -122.59 }])).toEqual({ center: { lat: 37.98, lng: -122.59 }, zoom: 14 });
    expect(fitCamera([])).toEqual({ center: { lat: 0, lng: 0 }, zoom: 1 });
    expect(fitCamera([{ lat: 25, lng: -125 }, { lat: 49, lng: -67 }]).zoom).toBe(3);
  });
});
