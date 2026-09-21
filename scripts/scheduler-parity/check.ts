/**
 * Replays the phone's golden scheduler decisions and journeys (main.swift)
 * through the TypeScript port and reports every difference.
 */
import type { LngLat } from "../../packages/shared/src";
import { SpotScheduler, schedulerContext } from "../../packages/shared/src";
import { JourneySimulator, fixtures, memoryHistory, type SimConfig, type SimSpot } from "../../packages/shared/tests/journeySimulator";

interface Offset { e: number; n: number }
interface SpotSpec { id: string; title: string; e: number; n: number; radiusM: number; triggered?: boolean | null; trackId: string; trackSlug: string; narratable: boolean; hasContent: boolean; region?: Offset[] | null; narrationS: number }
interface CtxSpec { atE: number; atN: number; courseDeg: number | null; speed: number; mode: string; journeyRoute: Offset[]; trackOrder: string[]; trackIdToSlug: Record<string, string>; playedAgoS: Record<string, number>; playCounts: Record<string, number>; busyForS: number; nowPlayingId: string | null; narrationS: number }
interface PlanOut { targetId: string | null; targetOpensInS: number | null; playNowId: string | null; gapBudgetS: number | null; prediction: { lat: number; lng: number; courseDeg: number | null; speedMps: number | null } | null }
interface ConfigSpec { speedMps: number; mode: string; pollIntervalS: number; tickS: number; jitterM: number; seed: number; trackOrder: string[]; journeyRoute: Offset[]; preplayed: Record<string, number>; startS: number }
interface EventOut { spotId: string; timeS: number; distanceM: number; alongM: number | null; locator: string }
interface RunOut { events: EventOut[]; targets: Array<{ timeS: number; spotId: string | null }>; skipped: string[] }
interface Golden {
  plans: Array<{ name: string; spots: SpotSpec[]; ctx: CtxSpec; expect: PlanOut }>;
  journeys: Array<{ name: string; spots: SpotSpec[]; path: Offset[]; config: ConfigSpec; extraIdleS: number; expect: RunOut }>;
  visits: Array<{ name: string; spots: SpotSpec[]; runs: Array<{ path: Offset[]; config: ConfigSpec; extraIdleS: number; expect: RunOut }> }>;
}

const golden = (await Bun.file(process.argv[2]!).json()) as Golden;
const base = fixtures.base;
const now = 1_000_000_000;
const coord = (o: Offset): LngLat => fixtures.offset(base, o.e, o.n);
const near = (a: number | null | undefined, b: number | null | undefined, tol: number) =>
  (a == null && b == null) || (a != null && b != null && Math.abs(a - b) <= tol);

let failures = 0;
const fail = (what: string, detail: string) => { failures++; if (failures <= 15) console.log(`MISMATCH ${what}\n  ${detail}`); };

import { localDistanceM, pointInRing } from "../../packages/shared/src";
function nearby(specs: SpotSpec[], at: LngLat) {
  return specs.map((s) => {
    const c = coord({ e: s.e, n: s.n });
    const d = localDistanceM(at, c);
    const region = s.region ? s.region.map(coord) : undefined;
    const inside = region && region.length >= 3 ? pointInRing(at, region) : false;
    return fixtures.nearbySpot({ id: s.id, title: s.id, center: c, radiusM: s.radiusM, distanceM: d,
      triggered: s.triggered ?? (d <= s.radiusM || inside), trackId: s.trackId, trackSlug: s.trackSlug,
      narratable: s.narratable, hasContent: s.hasContent, region });
  });
}

for (const c of golden.plans) {
  const at = coord({ e: c.ctx.atE, n: c.ctx.atN });
  const ctx = schedulerContext({
    location: { ...at, speedMps: c.ctx.speed }, courseDeg: c.ctx.courseDeg, mode: c.ctx.mode,
    journeyRoute: c.ctx.journeyRoute.map(coord), trackOrder: c.ctx.trackOrder, trackIdToSlug: c.ctx.trackIdToSlug, nowS: now,
    lastPlayedAtS: (id) => (c.ctx.playedAgoS[id] != null ? now - c.ctx.playedAgoS[id]! : null),
    playCount: (id) => c.ctx.playCounts[id] ?? (c.ctx.playedAgoS[id] != null ? 1 : 0),
    busyForS: c.ctx.busyForS, nowPlayingId: c.ctx.nowPlayingId, durationS: () => c.ctx.narrationS,
  });
  const plan = new SpotScheduler().plan(nearby(c.spots, at), ctx);
  const got: PlanOut = {
    targetId: plan.target?.spot.id ?? null, targetOpensInS: plan.targetOpensInS, playNowId: plan.playNow?.spot.id ?? null,
    gapBudgetS: plan.gapBudgetS,
    prediction: plan.prediction ? { lat: plan.prediction.coordinate.lat, lng: plan.prediction.coordinate.lng, courseDeg: plan.prediction.courseDeg, speedMps: plan.prediction.speedMps } : null,
  };
  const e = c.expect;
  const ok = got.targetId === (e.targetId ?? null) && got.playNowId === (e.playNowId ?? null)
    && near(got.targetOpensInS, e.targetOpensInS, 1e-6) && near(got.gapBudgetS, e.gapBudgetS, 1e-6)
    && ((got.prediction == null && e.prediction == null) || (got.prediction != null && e.prediction != null
      && near(got.prediction.lat, e.prediction.lat, 1e-10) && near(got.prediction.lng, e.prediction.lng, 1e-10)
      && near(got.prediction.courseDeg, e.prediction.courseDeg, 1e-6) && near(got.prediction.speedMps, e.prediction.speedMps, 1e-9)));
  if (!ok) fail(`plan ${c.name}`, `swift ${JSON.stringify(e)}\n  ts    ${JSON.stringify(got)}`);
}

function toSim(specs: SpotSpec[]): SimSpot[] {
  return specs.map((s) => ({ id: s.id, title: s.title, coordinate: coord({ e: s.e, n: s.n }), radiusM: s.radiusM, narrationS: s.narrationS, trackId: s.trackId, trackSlug: s.trackSlug, narratable: s.narratable }));
}
function toConfig(c: ConfigSpec): SimConfig {
  return { speedMps: c.speedMps, mode: c.mode, pollIntervalS: c.pollIntervalS, tickS: c.tickS, jitterM: c.jitterM, seed: BigInt(c.seed), trackOrder: c.trackOrder, journeyRoute: c.journeyRoute.map(coord), preplayed: c.preplayed, startS: c.startS };
}
function compareRun(name: string, sim: JourneySimulator, e: RunOut) {
  const got = sim.events;
  if (got.length !== e.events.length || got.some((g, i) => g.spotId !== e.events[i]!.spotId || g.timeS !== e.events[i]!.timeS
      || !near(g.distanceM, e.events[i]!.distanceM, 1e-6) || !near(g.alongM, e.events[i]!.alongM, 1e-6) || g.locator !== e.events[i]!.locator)) {
    fail(`journey ${name} events`, `swift ${JSON.stringify(e.events.map((x) => [x.spotId, x.timeS, +x.distanceM.toFixed(2), x.alongM == null ? null : +x.alongM.toFixed(2), x.locator]))}\n  ts    ${JSON.stringify(got.map((x) => [x.spotId, x.timeS, +x.distanceM.toFixed(2), x.alongM == null ? null : +x.alongM.toFixed(2), x.locator]))}`);
  }
  const targets = sim.targetLog;
  if (targets.length !== e.targets.length || targets.some((t, i) => t.timeS !== e.targets[i]!.timeS || (t.spotId ?? null) !== (e.targets[i]!.spotId ?? null))) {
    fail(`journey ${name} targets`, `swift ${JSON.stringify(e.targets)}\n  ts    ${JSON.stringify(targets)}`);
  }
  if (JSON.stringify(sim.skippedSpotIds) !== JSON.stringify(e.skipped)) fail(`journey ${name} skipped`, `swift ${JSON.stringify(e.skipped)} ts ${JSON.stringify(sim.skippedSpotIds)}`);
}
for (const j of golden.journeys) {
  const sim = new JourneySimulator(toSim(j.spots), j.path.map(coord), toConfig(j.config));
  sim.run(j.extraIdleS);
  compareRun(j.name, sim, j.expect);
}
for (const v of golden.visits) {
  const history = memoryHistory();
  v.runs.forEach((run, i) => {
    const withFourth = i === 3;
    const spots = v.spots.filter((s) => withFourth || !s.id.endsWith("-3"));
    const sim = new JourneySimulator(toSim(spots), run.path.map(coord), toConfig(run.config), history);
    sim.run(run.extraIdleS);
    compareRun(`${v.name} visit ${i}`, sim, run.expect);
  });
}
const total = golden.plans.length + golden.journeys.length + golden.visits.reduce((n, v) => n + v.runs.length, 0);
console.log(`${total - failures}/${total} cases match (${golden.plans.length} decisions, ${golden.journeys.length} journeys, ${golden.visits.reduce((n, v) => n + v.runs.length, 0)} visits)`);
process.exit(failures === 0 ? 0 : 1);
