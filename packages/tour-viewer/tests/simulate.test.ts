import { describe, expect, test } from "bun:test";
import { TrackExport } from "@grandtour/shared";
import fixture from "./fixtures/sample.grandtour.json";
import { planNarrationStops } from "../src/narrationRoute";
import { TourPlayback } from "../src/TourPlayback";
import { demoPace, demoStep, nextDemoStops, parseSimulation, simulatedMode } from "../src/simulate";

describe("parseSimulation", () => {
  test("no demo without ?simulate=", () => {
    expect(parseSimulation(new URLSearchParams(""))).toBeNull();
    expect(parseSimulation(new URLSearchParams("at=37.98,-122.59"))).toBeNull();
    expect(parseSimulation(new URLSearchParams("simulate=&mph=3"))).toBeNull();
  });
  test("a slug alone leaves the pace to the track", () => {
    expect(parseSimulation(new URLSearchParams("simulate=going-to-the-sun-road-audio-tour")))
      .toEqual({ slug: "going-to-the-sun-road-audio-tour", mph: null });
  });
  test("mph sets the pace; anything but a positive number leaves it to the track", () => {
    expect(parseSimulation(new URLSearchParams("simulate=news&mph=3"))!.mph).toBe(3);
    expect(parseSimulation(new URLSearchParams("simulate=news&mph=fast"))!.mph).toBeNull();
    expect(parseSimulation(new URLSearchParams("simulate=news&mph=-5"))!.mph).toBeNull();
    expect(parseSimulation(new URLSearchParams("simulate=news&mph=0"))!.mph).toBeNull();
  });
});

describe("demoPace", () => {
  test("an explicit mode sets the pace", () => {
    expect(demoPace({ spanKm: 55 }, "walking")).toBe(3);
    expect(demoPace({ spanKm: 0.5 }, "driving")).toBe(25);
    expect(demoPace({ spanKm: 0.5 }, "cycling")).toBe(10);
  });
  test("automatic: a village tour is walked, a park road is driven, an unknown track is driven", () => {
    expect(demoPace({ spanKm: 0.5 }, "auto")).toBe(3);
    expect(demoPace({ spanKm: 55.4 }, "auto")).toBe(25);
    expect(demoPace(null, "auto")).toBe(25);
  });
});

describe("simulatedMode", () => {
  test("the detector's line: 7 m/s (16 mph) and up is driving", () => {
    expect(simulatedMode(3)).toBe("walking");
    expect(simulatedMode(15)).toBe("walking");
    expect(simulatedMode(16)).toBe("driving");
    expect(simulatedMode(25)).toBe("driving");
  });
});

describe("demoStep", () => {
  const base = { item: false, playing: false, moving: true, distM: 100, totalM: 5000, nextM: 2000, idleMs: 3000, gapMs: 3000, leadM: 90 };
  test("a story just ended: wait out the story spacing, then jump to just before the next stop", () => {
    expect(demoStep({ ...base, idleMs: 0 })).toEqual({ kind: "none" });
    expect(demoStep({ ...base, idleMs: 2999 })).toEqual({ kind: "none" });
    expect(demoStep(base)).toEqual({ kind: "seek", distM: 1910 });
  });
  test("driving in: keep going, or set off again if parked; at the stop, play it", () => {
    expect(demoStep({ ...base, distM: 1950 })).toEqual({ kind: "none" });
    expect(demoStep({ ...base, distM: 1950, moving: false })).toEqual({ kind: "resume" });
    expect(demoStep({ ...base, distM: 2000 })).toEqual({ kind: "play" });
    expect(demoStep({ ...base, distM: 2040, moving: false })).toEqual({ kind: "play" });
  });
  test("while a story plays the car never passes the next stop, and moves again once it may", () => {
    expect(demoStep({ ...base, item: true, playing: true, distM: 2000 })).toEqual({ kind: "park" });
    expect(demoStep({ ...base, item: true, playing: true, distM: 2000, moving: false })).toEqual({ kind: "none" });
    expect(demoStep({ ...base, item: true, playing: true, distM: 1000, moving: false })).toEqual({ kind: "resume" });
    expect(demoStep({ ...base, item: true, playing: false, distM: 1000, moving: false })).toEqual({ kind: "none" });
  });
  test("no stop left: park at the end of the route once", () => {
    expect(demoStep({ ...base, nextM: null })).toEqual({ kind: "finish" });
    expect(demoStep({ ...base, nextM: null, distM: 5000 })).toEqual({ kind: "none" });
  });
});

describe("demo arrivals between animation frames", () => {
  const bundle = TrackExport.parse(fixture);
  const template = bundle.spots.find((s) => s.content.some((c) => c.audioUrl))!;
  // Like Puʻukoholā: stops outside the road's GPS triggers, and two stories
  // sharing a visitor-center stop. Only the demo's arrival fallback can play.
  const path = [{ lat: 0, lng: 0 }, { lat: 0, lng: 0.01 }];
  const sources = [0.002, 0.003, 0.01, 0.01].map((lng, i) => ({
    ...template,
    spot: {
      ...template.spot, id: `off-road-${i}`,
      trigger: { kind: "point" as const, center: { lat: 0.01, lng }, radiusM: 20 },
    },
  }));
  const stops = planNarrationStops(bundle.track, sources, path, true);
  const base = { item: false, playing: false, moving: true, totalM: stops.at(-1)!.distM,
    idleMs: 3000, gapMs: 3000, leadM: 15 };

  test("off-road stops survive overshoot, play once each, and drain the shared endpoint", () => {
    expect(stops.every((s) => s.closestRoadPoint)).toBe(true);
    const player = new TourPlayback(null, { gapSeconds: 0 });
    const recordings: string[] = [];
    player.attach({ src: "", currentTime: 0, pause: () => {}, load: () => {}, play: () => {
      recordings.push(player.getSnapshot().item!.spot.id);
      player.onPlay();
      return Promise.resolve();
    } });

    for (const stop of stops) {
      // Frames almost never land on the exact fractional route distance.
      const distM = Math.min(base.totalM, stop.distM + 0.25);
      const next = nextDemoStops(stops, player.isAvailable)[0]!;
      expect(next.item.spot.id).toBe(stop.item.spot.id);
      expect(demoStep({ ...base, distM, nextM: next.distM })).toEqual({ kind: "play" });
      player.play(next.item, true);
      player.onAudioEnded();
    }
    expect(recordings).toEqual(sources.map((s) => s.spot.id));
    expect(nextDemoStops(stops, player.isAvailable)).toEqual([]);
  });

  test("a playing story parks the traveler after crossing the next unheard stop", () => {
    const next = nextDemoStops(stops, (item) => item.spot.id !== stops[0]!.item.spot.id)[0]!;
    expect(demoStep({ ...base, item: true, playing: true, distM: next.distM + 0.25, nextM: next.distM }))
      .toEqual({ kind: "park" });
  });

  test("prefetching skips unavailable stories and repeated entrances, keeping two distinct stops", () => {
    const repeated = [stops[0]!, stops[0]!, ...stops.slice(1)];
    expect(nextDemoStops(repeated, () => true)).toEqual(stops.slice(0, 2));
    expect(nextDemoStops(repeated, (item) => item.spot.id !== stops[0]!.item.spot.id)).toEqual(stops.slice(1, 3));
  });
});
