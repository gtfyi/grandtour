import { describe, expect, test } from "bun:test";
import { SCHEDULER, SpotScheduler, localDistanceM, narrationDurationS, narrationSecondsForText, schedulerContext } from "../src";
import { JourneySimulator, fixtures, type SimSpot } from "./journeySimulator";

const base = fixtures.base;
const now = 1_000_000_000;

function spotAt(id: string, eastM: number, o: { northM?: number; radiusM?: number; triggered?: boolean; trackId?: string; trackSlug?: string; narratable?: boolean; hasContent?: boolean } = {}) {
  const c = fixtures.offset(base, eastM, o.northM ?? 0);
  const d = localDistanceM(base, c);
  const radiusM = o.radiusM ?? 35;
  return fixtures.nearbySpot({ id, title: id, center: c, radiusM, distanceM: d, triggered: o.triggered ?? d <= radiusM,
    trackId: o.trackId, trackSlug: o.trackSlug, narratable: o.narratable, hasContent: o.hasContent });
}

function ctx(o: { courseDeg: number | null; speed: number; mode?: string; journeyRoute?: typeof base[]; trackOrder?: string[];
  trackIdToSlug?: Record<string, string>; playedAgoS?: Record<string, number>; playCounts?: Record<string, number>;
  busyForS?: number; nowPlayingId?: string | null; narrationS?: number; at?: typeof base }) {
  const played = o.playedAgoS ?? {};
  const counts = o.playCounts ?? {};
  return schedulerContext({
    location: { ...(o.at ?? base), speedMps: o.speed },
    courseDeg: o.courseDeg, mode: o.mode ?? "walking", journeyRoute: o.journeyRoute ?? [],
    trackOrder: o.trackOrder ?? [], trackIdToSlug: o.trackIdToSlug ?? {}, nowS: now,
    lastPlayedAtS: (id) => (played[id] != null ? now - played[id]! : null),
    playCount: (id) => counts[id] ?? (played[id] != null ? 1 : 0),
    busyForS: o.busyForS ?? 0, nowPlayingId: o.nowPlayingId ?? null,
    durationS: () => o.narrationS ?? 60,
  });
}

// ─── Unit tests, ported from SpotSchedulerUnitTests ────────────────────────

describe("ahead / behind", () => {
  test("targets the ahead spot and ignores the passed one", () => {
    const plan = new SpotScheduler().plan([spotAt("behind", -100), spotAt("ahead", 80)], ctx({ courseDeg: 90, speed: 1.4 }));
    expect(plan.target?.spot.id).toBe("ahead");
    expect(plan.playNow?.spot.id).toBe("ahead");
  });
  test("passing the centre does not discard a still-valid arrival", () => {
    const plan = new SpotScheduler().plan([spotAt("just-passed", -20, { triggered: true })], ctx({ courseDeg: 90, speed: 1.4 }));
    expect(plan.target?.spot.id).toBe("just-passed");
    expect(plan.playNow?.spot.id).toBe("just-passed");
  });
  test("a driving arrival wins over a farther preferred unheard story", () => {
    const c = ctx({ courseDeg: 90, speed: 18, mode: "driving", trackOrder: ["preferred"], trackIdToSlug: { "preferred-id": "preferred" } });
    const plan = new SpotScheduler().plan([spotAt("farther", 800, { trackId: "preferred-id", trackSlug: "preferred" }), spotAt("here", -40, { radiusM: 100 })], c);
    expect(plan.target?.spot.id).toBe("here");
    expect(plan.playNow?.spot.id).toBe("here");
  });
  test("an arrival expires outside its trigger", () => {
    const plan = new SpotScheduler().plan([spotAt("passed", -110, { radiusM: 100 })], ctx({ courseDeg: 90, speed: 18, mode: "driving" }));
    expect(plan.playNow).toBeNull();
    expect(plan.target).toBeNull();
  });
  test("an arrival never interrupts the current story or bypasses history", () => {
    const s = new SpotScheduler();
    const arrived = spotAt("here", -20, { radiusM: 100 });
    expect(s.plan([arrived], ctx({ courseDeg: 90, speed: 18, mode: "driving", busyForS: 40, nowPlayingId: "playing" })).playNow).toBeNull();
    expect(s.plan([arrived], ctx({ courseDeg: 90, speed: 18, mode: "driving", playedAgoS: { here: 10 } })).playNow).toBeNull();
  });
  test("within the here tolerance the spot still plays; without a course the trigger is trusted", () => {
    const s = new SpotScheduler();
    expect(s.plan([spotAt("here", -10, { triggered: true })], ctx({ courseDeg: 90, speed: 1.4 })).playNow?.spot.id).toBe("here");
    expect(s.plan([spotAt("somewhere", -30, { triggered: true })], ctx({ courseDeg: null, speed: 0 })).playNow?.spot.id).toBe("somewhere");
  });
});

describe("start window", () => {
  test("opens within the lead when head-on", () => {
    const s = new SpotScheduler();
    const c = ctx({ courseDeg: 90, speed: 1.4, narrationS: 60 });
    expect(s.isStartable(spotAt("near", 85), c)).toBe(true);
    expect(s.isStartable(spotAt("far", 100), c)).toBe(false);
    expect(s.opensInS(spotAt("far", 100), c)!).toBeCloseTo((100 - 91) / 1.4, 0);
  });
  test("a lateral spot waits for the radius", () => {
    const s = new SpotScheduler();
    const side = spotAt("side", 60, { northM: 60 });
    const plan = s.plan([side], ctx({ courseDeg: 90, speed: 1.4, narrationS: 60 }));
    expect(plan.target).toBeNull();
    expect(plan.playNow).toBeNull();
  });
  test("standing still opens no lead window; an invalid speed uses the mode's pace", () => {
    const s = new SpotScheduler();
    const spot = spotAt("ahead", 50);
    expect(s.isStartable(spot, ctx({ courseDeg: 90, speed: 0, narrationS: 60 }))).toBe(false);
    expect(s.isStartable(spot, ctx({ courseDeg: 90, speed: -1, narrationS: 60 }))).toBe(true);
  });
  test("the lead is capped", () => {
    const s = new SpotScheduler();
    const c = ctx({ courseDeg: 90, speed: 12, mode: "driving", narrationS: 180 });
    const capM = (SCHEDULER.maxLeadS + SCHEDULER.arriveMarginS) * 12;
    expect(s.isStartable(spotAt("in", capM - 20, { radiusM: 60 }), c)).toBe(true);
    expect(s.isStartable(spotAt("out", capM + 40, { radiusM: 60 }), c)).toBe(false);
  });
});

describe("fillers and the gap budget", () => {
  test("a filler plays when it fits before the target", () => {
    const plan = new SpotScheduler().plan([spotAt("heard", 30), spotAt("fresh", 250)], ctx({ courseDeg: 90, speed: 1.4, playedAgoS: { heard: 24 * 3600 }, narrationS: 30 }));
    expect(plan.target?.spot.id).toBe("fresh");
    expect(plan.playNow?.spot.id).toBe("heard");
    expect(plan.targetOpensInS!).toBeCloseTo((250 - 49) / 1.4, 0);
  });
  test("a filler yields when it would not fit", () => {
    const plan = new SpotScheduler().plan([spotAt("heard", 30), spotAt("fresh", 120)], ctx({ courseDeg: 90, speed: 1.4, playedAgoS: { heard: 24 * 3600 }, narrationS: 60 }));
    expect(plan.target?.spot.id).toBe("fresh");
    expect(plan.playNow).toBeNull();
    expect(plan.gapBudgetS!).toBeCloseTo((120 - 91) / 1.4, 0);
  });
  test("no target means an unbounded gap", () => {
    const s = new SpotScheduler();
    const plan = s.plan([], ctx({ courseDeg: 90, speed: 1.4 }));
    expect(plan.target).toBeNull();
    expect(plan.gapBudgetS).toBeNull();
    expect(s.fits(600, null)).toBe(true);
    expect(s.fits(30, 30)).toBe(false);
  });
  test("an off-path fresh target cannot block a story on the path", () => {
    const s = new SpotScheduler();
    const c = ctx({ courseDeg: 90, speed: 1.4, playedAgoS: { here: 86400 }, narrationS: 30 });
    expect(s.opensInS(spotAt("side", 20, { northM: 200 }), c)).toBeNull();
    const plan = s.plan([spotAt("side", 20, { northM: 200 }), spotAt("here", 20)], c);
    expect(plan.target?.spot.id).toBe("here");
    expect(plan.playNow?.spot.id).toBe("here");
  });
  test("a large radius ETA uses the actual path intersection", () => {
    const s = new SpotScheduler();
    expect(s.opensInS(spotAt("offset", 150, { northM: 80, radiusM: 100 }), ctx({ courseDeg: 90, speed: 1.4, narrationS: 1 }))!).toBeCloseTo((150 - 60) / 1.4, -1);
  });
  test("turning toward an off-path spot makes it a target", () => {
    const s = new SpotScheduler();
    const side = spotAt("side", 0, { northM: 200 });
    expect(s.plan([side], ctx({ courseDeg: 90, speed: 1.4 })).target).toBeNull();
    expect(s.plan([side], ctx({ courseDeg: 0, speed: 1.4 })).target?.spot.id).toBe("side");
  });
});

describe("eligibility and ranking", () => {
  test("content that disappeared, cooldowns, and the current story", () => {
    const s = new SpotScheduler();
    expect(s.plan([spotAt("gone", 50, { hasContent: false })], ctx({ courseDeg: 90, speed: 1.4 })).target).toBeNull();
    expect(s.plan([spotAt("recent", 50)], ctx({ courseDeg: 90, speed: 1.4, playedAgoS: { recent: 3600 } })).target).toBeNull();
    expect(s.plan([spotAt("stale", 50)], ctx({ courseDeg: 90, speed: 1.4, playedAgoS: { stale: 7 * 3600 } })).playNow?.spot.id).toBe("stale");
    expect(s.plan([spotAt("current", 20)], ctx({ courseDeg: 90, speed: 1.4, busyForS: 30, nowPlayingId: "current" })).target).toBeNull();
  });
  test("track preference beats distance; freshness beats both; play count breaks same-day ties", () => {
    const s = new SpotScheduler();
    const order = { trackOrder: ["preferred"], trackIdToSlug: { "t-a": "preferred", "t-b": "other" } };
    expect(s.plan([spotAt("near-other", 60, { trackId: "t-b", trackSlug: "other" }), spotAt("far-preferred", 200, { trackId: "t-a", trackSlug: "preferred" })],
      ctx({ courseDeg: 90, speed: 1.4, ...order })).target?.spot.id).toBe("far-preferred");
    expect(s.plan([spotAt("heard-near", 40), spotAt("fresh-far", 150)], ctx({ courseDeg: 90, speed: 1.4, playedAgoS: { "heard-near": 24 * 3600 } })).target?.spot.id).toBe("fresh-far");
    expect(s.plan([spotAt("heard-recently", 40), spotAt("heard-long-ago", 150)], ctx({ courseDeg: 90, speed: 1.4, playedAgoS: { "heard-recently": 2 * 86400, "heard-long-ago": 8 * 86400 } })).target?.spot.id).toBe("heard-long-ago");
    expect(s.plan([spotAt("worn-near", 40), spotAt("rare-far", 150)], ctx({ courseDeg: 90, speed: 1.4, playedAgoS: { "worn-near": 3 * 86400, "rare-far": 3 * 86400 + 1800 }, playCounts: { "worn-near": 5, "rare-far": 1 } })).target?.spot.id).toBe("rare-far");
    const nearby = [spotAt("fresh-other", 40, { trackId: "t-b", trackSlug: "other" }), spotAt("heard-preferred", 150, { trackId: "t-a", trackSlug: "preferred" })];
    expect(s.plan(nearby, ctx({ courseDeg: 90, speed: 1.4, ...order, playedAgoS: { "heard-preferred": 24 * 3600 } })).target?.spot.id).toBe("fresh-other");
    expect(s.plan(nearby, ctx({ courseDeg: 90, speed: 1.4, ...order })).target?.spot.id).toBe("heard-preferred");
  });
});

describe("prediction", () => {
  test("the target is ahead of where the story ends", () => {
    const plan = new SpotScheduler().plan([spotAt("under", 40), spotAt("beyond", 150)], ctx({ courseDeg: 90, speed: 1.4, busyForS: 60, nowPlayingId: "x" }));
    expect(plan.target?.spot.id).toBe("beyond");
    expect(plan.playNow).toBeNull();
    expect(localDistanceM(base, plan.prediction!.coordinate)).toBeCloseTo(84, -1);
  });
  test("a journey route follows the turn; dead reckoning does not", () => {
    const corner = fixtures.offset(base, 300, 0);
    const route = [base, corner, fixtures.offset(base, 300, 900)];
    const pos = fixtures.offset(base, 250, 0);
    const nearby = [["dead-ahead", fixtures.offset(base, 900, 0)], ["around-corner", fixtures.offset(base, 300, 600)]].map(([id, c]) =>
      fixtures.nearbySpot({ id: id as string, title: id as string, center: c as typeof base, radiusM: 60, distanceM: localDistanceM(pos, c as typeof base), triggered: false }));
    const s = new SpotScheduler();
    const c = (withRoute: boolean) => schedulerContext({ location: { ...pos, speedMps: 12 }, courseDeg: 90, mode: "driving", journeyRoute: withRoute ? route : [], busyForS: 45, nowPlayingId: "x", nowS: now });
    expect(s.plan(nearby, c(true)).target?.spot.id).toBe("around-corner");
    expect(s.plan(nearby, c(false)).target?.spot.id).toBe("dead-ahead");
  });
  test("route projection snaps to the nearest segment", () => {
    const r = SpotScheduler.pointAlongRoute(fixtures.offset(base, 500, 5), 100, [base, fixtures.offset(base, 1000, 0)])!;
    expect(localDistanceM(base, r.coordinate)).toBeCloseTo(600, -1);
    expect(r.bearingDeg).toBeCloseTo(90, 0);
  });
  test("along-course signs", () => {
    const s = new SpotScheduler();
    expect(s.alongCourseM(spotAt("ahead", 100), ctx({ courseDeg: 90, speed: 1.4 }))!).toBeCloseTo(100, -1);
    expect(s.alongCourseM(spotAt("behind", -100), ctx({ courseDeg: 90, speed: 1.4 }))!).toBeCloseTo(-100, -1);
    expect(s.alongCourseM(spotAt("ahead", 100), ctx({ courseDeg: null, speed: 0 }))).toBeNull();
  });
  test("narration duration estimate", () => {
    expect(narrationSecondsForText("")).toBe(0);
    expect(narrationSecondsForText("one two three four five")).toBeCloseTo(2, 2);
    expect(narrationSecondsForText("one two… three")).toBeCloseTo(1.2 + 2.5, 2);
    expect(narrationDurationS(spotAt("s", 10))).toBeCloseTo(4 / 2.5 + 4, 2);
  });
});

// ─── Journeys, ported from JourneySimulationTests ───────────────────────────

const sim = (spots: SimSpot[], path: typeof base[], config: ConstructorParameters<typeof JourneySimulator>[2], extraIdleS = 60) => {
  const s = new JourneySimulator(spots, path, config);
  s.run(extraIdleS);
  return s;
};
const spot = (id: string, eastM: number, o: Partial<SimSpot> & { northM?: number } = {}): SimSpot =>
  ({ id, title: o.title ?? `Spot ${id}`, coordinate: fixtures.offset(base, eastM, o.northM ?? 0), radiusM: o.radiusM ?? 35, narrationS: o.narrationS ?? 30, trackId: o.trackId, trackSlug: o.trackSlug });
const east = (m: number) => fixtures.offset(base, m, 0);

describe("journeys", () => {
  test("spaced walking spots all start ahead within the lead", () => {
    const spots = [250, 500, 750].map((x, i) => spot(`s${i}`, x));
    const s = sim(spots, [base, east(1000)], { speedMps: 1.4, mode: "walking" });
    expect(s.events).toHaveLength(3);
    for (const e of s.events) {
      expect(e.alongM!).toBeGreaterThan(35);
      expect(e.alongM!).toBeLessThanOrEqual((30 + SCHEDULER.arriveMarginS) * 1.4 + 3);
      expect(e.locator.startsWith("Coming up in")).toBe(true);
    }
  });
  test("driving dense spots skips what was passed mid-story", () => {
    const spots = Array.from({ length: 5 }, (_, i) => spot(`s${i}`, 300 + i * 400, { radiusM: 60, narrationS: 45 }));
    const s = sim(spots, [base, east(2500)], { speedMps: 13.4, mode: "driving" });
    expect(s.events.map((e) => e.spotId)).toEqual(["s0", "s1", "s3", "s4"]);
    expect(s.skippedSpotIds).toEqual(["s2"]);
  });
  test("standing still with jitter plays once; a loop back within the cooldown does not replay", () => {
    const centre = east(50);
    const still = sim([{ id: "s0", title: "Here", coordinate: centre, radiusM: 35, narrationS: 30 }], [centre], { speedMps: 1.4, mode: "walking", jitterM: 8 }, 600);
    expect(still.events).toHaveLength(1);
    const loop = sim([spot("s0", 100)], [base, east(300), base], { speedMps: 1.4, mode: "walking" });
    expect(loop.events).toHaveLength(1);
  });
  test("a spot heard yesterday plays again; one heard an hour ago stays silent", () => {
    expect(sim([spot("s0", 100)], [base, east(300)], { speedMps: 1.4, mode: "walking", preplayed: { s0: 24 * 3600 } }).events).toHaveLength(1);
    expect(sim([spot("s0", 100)], [base, east(300)], { speedMps: 1.4, mode: "walking", preplayed: { s0: 3600 } }).events).toHaveLength(0);
  });
  test("the fresh story wins the gap; a heard one fills only when it fits", () => {
    const flank = sim([spot("heard", 100, { northM: 20, narrationS: 90 }), spot("fresh", 100, { northM: -20, narrationS: 90 })], [base, east(400)],
      { speedMps: 1.4, mode: "walking", preplayed: { heard: 24 * 3600 } }, 120);
    expect(flank.events.map((e) => e.spotId)).toEqual(["fresh"]);
    const fits = sim([spot("heard", 100), spot("fresh", 400)], [base, east(600)], { speedMps: 1.4, mode: "walking", preplayed: { heard: 24 * 3600 } });
    expect(fits.events.map((e) => e.spotId)).toEqual(["heard", "fresh"]);
    expect(fits.targetLog[0]?.spotId).toBe("fresh");
    const blanket = sim([spot("heard", 100, { narrationS: 90 }), spot("fresh", 160)], [base, east(400)], { speedMps: 1.4, mode: "walking", preplayed: { heard: 24 * 3600 } });
    expect(blanket.events.map((e) => e.spotId)).toEqual(["fresh"]);
  });
  test("up next while playing looks past the current story", () => {
    const s = sim([spot("first", 60, { narrationS: 90 }), spot("under", 100), spot("beyond", 300)], [base, east(500)], { speedMps: 1.4, mode: "walking" });
    expect(s.events.map((e) => e.spotId)).toEqual(["first", "under", "beyond"]);
    const firstStart = s.events[0]!.timeS;
    const during = s.targetLog.filter((t) => t.timeS > firstStart && t.timeS < firstStart + 90);
    expect(during.some((t) => t.spotId === "under")).toBe(false);
    expect(during.some((t) => t.spotId === "beyond")).toBe(true);
  });
});
