import type { LngLat, PolygonRing } from "./geo";
import { localDistanceM, pointInRing } from "./geo";
import type { NearbySpot } from "./api";
import { narrationDurationS } from "./narration";

/**
 * The wander-mode decision core: given where the traveler is, where they're
 * heading, and how long the player stays busy, name the ONE spot the tour is
 * heading for (`Plan.target` — what "Up next" shows) and, when the player is
 * idle, what to start right now (`Plan.playNow`).
 *
 * A line-for-line port of `ios/Sources/SpotScheduler.swift`, which stays the
 * canonical version; the two are pinned together by
 * scripts/scheduler-parity, which replays the phone's golden decisions and
 * simulated journeys through this file. Distances are `localDistanceM`,
 * the phone's `Geo.localDistanceM` in the same arithmetic.
 *
 * There is no queue and no pool. Every decision is recomputed from scratch
 * against a *predicted* position — where the traveler will be when the
 * player is next free — so a spot they will have passed by then is never
 * promised after leaving its trigger. Two rules shape everything:
 *
 * 1. **Arrival takes priority.** An unheard point inside its authored trigger
 *    plays before a farther target. Passing its center does not discard it
 *    while the traveler is still inside. Outside the trigger, early starts
 *    still require an approach toward the spot.
 * 2. **Unheard beats everything.** The target is the least-played eligible
 *    spot ahead — a never-heard story on a lower-ranked track beats a heard
 *    one on a preferred track; track preference orders equally-fresh spots,
 *    and distance only breaks ties. Played spots still get their turn as
 *    *fillers* — but only when their narration fits before the target's
 *    start window opens, so they never cost an unheard story.
 *
 * Pure: no clocks, no audio, no networking.
 */

/** The fix a decision runs on. `speedMps` negative = no figure (CoreLocation's -1). */
export interface SchedulerLocation {
  lat: number;
  lng: number;
  speedMps: number;
}

/** Everything a decision depends on, snapshotted by the caller. Times are seconds on one clock. */
export interface SchedulerContext {
  location: SchedulerLocation | null;
  courseDeg: number | null;
  mode: string;
  journeyRoute: LngLat[];
  /** Preferred track slugs in order (Tracks sheet, drag to reorder). */
  trackOrder: string[];
  trackIdToSlug: Record<string, string>;
  /** The decision's "now" — injected, so simulated journeys can advance a virtual clock. */
  nowS: number;
  /** Play-history lookups; the scheduler only ever reads. Defaults say "never played". */
  lastPlayedAtS: (spotId: string) => number | null;
  playCount: (spotId: string) => number;
  /** Sequence gate: false while earlier parts of the spot's story are unheard. */
  isEligible: (spotId: string) => boolean;
  /** Series-track membership: a played unit never auto-replays. */
  neverReplays: (spotId: string) => boolean;
  /** Seconds until the player is free — 0 when idle. The prediction horizon. */
  busyForS: number;
  /** What's playing, so it never competes with itself. */
  nowPlayingId: string | null;
  /** How long a spot's narration runs (intro included). */
  durationS: (item: NearbySpot) => number;
}

/** A context with the phone's defaults for anything not given. */
export function schedulerContext(partial: Partial<SchedulerContext> = {}): SchedulerContext {
  return {
    location: null,
    courseDeg: null,
    mode: "walking",
    journeyRoute: [],
    trackOrder: [],
    trackIdToSlug: {},
    nowS: Date.now() / 1000,
    lastPlayedAtS: () => null,
    playCount: () => 0,
    isEligible: () => true,
    neverReplays: () => false,
    busyForS: 0,
    nowPlayingId: null,
    durationS: narrationDurationS,
    ...partial,
  };
}

/** Where the traveler will be when the player is next free. */
export interface Prediction {
  coordinate: LngLat;
  /** Heading at that point (route bearing on a journey, else the current course); null when unknown. */
  courseDeg: number | null;
  /** null = stationary (or no usable fix): nothing is dead-reckoned and no lead window opens early. */
  speedMps: number | null;
}

/** One decision. Recomputed at every poll and every player-idle moment. */
export interface Plan {
  /** The spot the tour is heading for. What "Up next" displays. Null: nothing eligible ahead. */
  target: NearbySpot | null;
  /** Seconds until the target's start window opens; 0 = open now. Null when unknowable. */
  targetOpensInS: number | null;
  /** What to start now, if the player is idle: the target when its window is open, else a fitting filler. */
  playNow: NearbySpot | null;
  /** How long gap content may run without delaying the target. Null = unbounded. */
  gapBudgetS: number | null;
  prediction: Prediction | null;
}

export const SCHEDULER = {
  /** A spot heard this recently doesn't auto-play again. */
  replayCooldownS: 6 * 3600,
  /** "Right here": within this of the spot's coordinates, ahead/behind is meaningless. */
  hereM: 15,
  /** Narration may start this long before the traveler reaches the spot. */
  maxLeadS: 60,
  /** Slack on the lead so the closing words land a beat after arrival. */
  arriveMarginS: 5,
  /** An early start also requires the straight path to pass through the trigger, within this lateral slack. */
  laneSlackM: 10,
  /** A filler must end this long before the target's window opens. */
  fillerMarginS: 8,
  /** A valid GPS speed under this counts as standing still. */
  stationaryBelowMps: 0.3,
} as const;

/** Typical speeds when GPS reports none (poor fix, simulator). */
export function assumedSpeedMps(mode: string): number {
  switch (mode) {
    case "driving": return 12;
    case "cycling": return 4.5;
    case "transit": return 10;
    case "boating": return 5;
    case "aviation": return 60;
    case "museum": return 0.5;
    default: return 1.4; // walking, hiking
  }
}

const center = (s: NearbySpot): LngLat => s.spot.trigger.center as LngLat;
const narratable = (s: NearbySpot): boolean =>
  !!s.content && (s.content.audioUrl != null || (s.content.document?.text ?? "") !== "");

export class SpotScheduler {
  /** Diagnostics hook; the app routes this into its field log. */
  log: (event: string, fields: Record<string, unknown>) => void = () => {};
  /** For change-only logging of the target. */
  private lastTargetId: string | null = null;

  // ─── The decision ─────────────────────────────────────────────────────────

  plan(nearby: NearbySpot[], ctx: SchedulerContext): Plan {
    const eligible = nearby.filter((s) => this.isEligible(s, ctx));
    const pred = this.prediction(ctx);
    const from = pred?.coordinate ?? null;
    const ahead = from
      ? eligible.filter((s) => this.isAhead(s, from, pred!.courseDeg) && this.isOnApproach(s, from, pred!.courseDeg))
      : eligible;
    // Do not reserve silence for a preferred story farther away while an
    // unheard story at the current location is about to be missed. While
    // busy, retain prediction instead of promising today's trigger at a
    // future position where it may no longer be relevant.
    const arrived = ctx.busyForS <= 0
      ? eligible.filter((s) => s.triggered && ctx.playCount(s.spot.id) === 0)
      : [];
    const target = this.ranked(arrived, from, ctx)[0] ?? this.ranked(ahead, from, ctx)[0] ?? null;
    this.logTargetChange(target, nearby, ctx);

    const opens = target ? this.opensInS(target, ctx) : null;
    let playNow: NearbySpot | null = null;
    let budget: number | null = opens;
    if (ctx.busyForS <= 0) {
      if (target && this.isStartable(target, ctx)) {
        playNow = target;
        budget = 0;
      } else {
        const fillers = eligible.filter((s) => this.isStartable(s, ctx) && this.fits(ctx.durationS(s), budget));
        playNow = this.ranked(fillers, from, ctx)[0] ?? null;
      }
    }
    return { target, targetOpensInS: opens, playNow, gapBudgetS: budget, prediction: pred };
  }

  /** Does something `duration` long fit in the gap before the target opens? */
  fits(duration: number, budget: number | null): boolean {
    if (budget == null) return true;
    return duration + SCHEDULER.fillerMarginS <= budget;
  }

  // ─── Eligibility ──────────────────────────────────────────────────────────

  /** Could this spot honestly auto-play at all (geometry aside)? */
  isEligible(s: NearbySpot, ctx: SchedulerContext): boolean {
    if (s.spot.trigger.kind === "area" || !s.content || !narratable(s)
      || s.spot.id === ctx.nowPlayingId || !ctx.isEligible(s.spot.id)) return false;
    const last = ctx.lastPlayedAtS(s.spot.id);
    if (last != null) {
      if (ctx.neverReplays(s.spot.id)) return false;
      if (ctx.nowS - last < SCHEDULER.replayCooldownS) return false;
    }
    return true;
  }

  /** In front of the traveler: the spot lies ahead along the course, or within `hereM`. Unknown course: yes. */
  isAhead(s: NearbySpot, from: LngLat, courseDeg: number | null): boolean {
    if (courseDeg == null) return true;
    if (SpotScheduler.distanceM(s, from) <= SCHEDULER.hereM) return true;
    return SpotScheduler.alongCross(s, from, courseDeg).along > 0;
  }

  /** Don't reserve airtime for a place on a parallel street. */
  isOnApproach(s: NearbySpot, from: LngLat, courseDeg: number | null): boolean {
    const region = s.spot.trigger.region as PolygonRing | undefined;
    if (region && region.length >= 3 && pointInRing(from, region)) return true;
    if (courseDeg == null) return true;
    return Math.abs(SpotScheduler.alongCross(s, from, courseDeg).cross) <= s.spot.trigger.radiusM + SCHEDULER.laneSlackM;
  }

  /** Lead window in seconds: start when the spot is this far ahead in time. */
  leadS(s: NearbySpot, ctx: SchedulerContext): number {
    return Math.min(ctx.durationS(s), SCHEDULER.maxLeadS) + SCHEDULER.arriveMarginS;
  }

  /** Arrival remains valid throughout the authored trigger; an early start needs an approach. */
  isStartable(s: NearbySpot, ctx: SchedulerContext): boolean {
    if (s.triggered) return true;
    const loc = ctx.location;
    if (!loc) return false;
    if (!this.isAhead(s, loc, ctx.courseDeg)) return false;
    const speed = this.movingSpeed(ctx);
    if (ctx.courseDeg == null || speed == null) return false;
    const { along, cross } = SpotScheduler.alongCross(s, loc, ctx.courseDeg);
    if (!(along > 0) || Math.abs(cross) > s.spot.trigger.radiusM + SCHEDULER.laneSlackM) return false;
    return along / speed <= this.leadS(s, ctx);
  }

  /** Seconds until `isStartable` would turn true on the current heading; null when unknowable. */
  opensInS(s: NearbySpot, ctx: SchedulerContext): number | null {
    if (this.isStartable(s, ctx)) return 0;
    const loc = ctx.location;
    const speed = this.movingSpeed(ctx);
    if (!loc || ctx.courseDeg == null || speed == null) return null;
    const { along, cross } = SpotScheduler.alongCross(s, loc, ctx.courseDeg);
    if (!(along > 0) || Math.abs(cross) > s.spot.trigger.radiusM + SCHEDULER.laneSlackM) return null;
    // The circle opens at its intersection with the travel line.
    const radiusEntryM = Math.sqrt(Math.max(0, s.spot.trigger.radiusM ** 2 - cross ** 2));
    const startAlongM = Math.max(radiusEntryM, speed * this.leadS(s, ctx));
    return Math.max(0, (along - startAlongM) / speed);
  }

  // ─── Ranking ──────────────────────────────────────────────────────────────

  /** Best-first: freshness, then preferred track, then play count, then distance from the predicted position. */
  ranked(spots: NearbySpot[], from: LngLat | null, ctx: SchedulerContext): NearbySpot[] {
    return [...spots].sort((a, b) =>
      this.freshnessRank(a, ctx) - this.freshnessRank(b, ctx)
      || this.trackRank(a, ctx) - this.trackRank(b, ctx)
      || ctx.playCount(a.spot.id) - ctx.playCount(b.spot.id)
      || this.distanceM(a, from) - this.distanceM(b, from));
  }

  /** Coarse recency tier, lower = fresher: 0 never played; else 31 (today) down to 1 (a month or more ago). */
  freshnessRank(s: NearbySpot, ctx: SchedulerContext): number {
    const last = ctx.lastPlayedAtS(s.spot.id);
    if (last == null) return 0;
    const days = Math.trunc((ctx.nowS - last) / 86_400);
    return Math.max(1, 31 - Math.min(days, 30));
  }

  /** Position in the user's optional track ordering; unlisted tracks rank equal (last). */
  trackRank(s: NearbySpot, ctx: SchedulerContext): number {
    if (ctx.trackOrder.length === 0) return Number.MAX_SAFE_INTEGER;
    const slug = ctx.trackIdToSlug[s.spot.trackId];
    if (slug === undefined) return Number.MAX_SAFE_INTEGER;
    const i = ctx.trackOrder.indexOf(slug);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  }

  // ─── Prediction ───────────────────────────────────────────────────────────

  /** Where the traveler will be when the player is free. Idle player ⇒ here, now. */
  prediction(ctx: SchedulerContext): Prediction | null {
    const loc = ctx.location;
    if (!loc) return null;
    const speed = this.movingSpeed(ctx);
    if (!(ctx.busyForS > 0) || speed == null) {
      return { coordinate: { lat: loc.lat, lng: loc.lng }, courseDeg: ctx.courseDeg, speedMps: speed };
    }
    const aheadM = speed * ctx.busyForS;
    if (ctx.journeyRoute.length > 1) {
      const onRoute = SpotScheduler.pointAlongRoute(loc, aheadM, ctx.journeyRoute);
      if (onRoute) return { coordinate: onRoute.coordinate, courseDeg: onRoute.bearingDeg, speedMps: speed };
    }
    if (ctx.courseDeg == null) return { coordinate: { lat: loc.lat, lng: loc.lng }, courseDeg: null, speedMps: speed };
    return { coordinate: SpotScheduler.project(loc, aheadM, ctx.courseDeg), courseDeg: ctx.courseDeg, speedMps: speed };
  }

  /** Speed to reckon with: the GPS speed when real; the mode's typical speed when the fix has none; null when standing still. */
  movingSpeed(ctx: SchedulerContext): number | null {
    const loc = ctx.location;
    if (!loc) return null;
    if (loc.speedMps < 0) return assumedSpeedMps(ctx.mode);
    return loc.speedMps >= SCHEDULER.stationaryBelowMps ? loc.speedMps : null;
  }

  // ─── Geometry ─────────────────────────────────────────────────────────────

  distanceM(s: NearbySpot, from: LngLat | null): number {
    if (!from) return s.distanceM;
    return SpotScheduler.distanceM(s, from);
  }

  static distanceM(s: NearbySpot, from: LngLat): number {
    return localDistanceM(from, center(s));
  }

  /** The traveler→spot vector on the course: `along` positive = ahead; `cross` positive = right of the line of travel. */
  static alongCross(s: NearbySpot, from: LngLat, courseDeg: number): { along: number; cross: number } {
    const d = SpotScheduler.distanceM(s, from);
    const bearing = SpotScheduler.bearingDeg(from, center(s));
    const delta = ((bearing - courseDeg) * Math.PI) / 180;
    return { along: d * Math.cos(delta), cross: d * Math.sin(delta) };
  }

  /** Signed along-course distance from the current fix; null without a course. */
  alongCourseM(s: NearbySpot, ctx: SchedulerContext): number | null {
    if (!ctx.location || ctx.courseDeg == null) return null;
    return SpotScheduler.alongCross(s, ctx.location, ctx.courseDeg).along;
  }

  /** Advance along the journey polyline from the nearest segment; null when more than 500 m off the route. */
  static pointAlongRoute(pos: LngLat, aheadM: number, route: LngLat[]): { coordinate: LngLat; bearingDeg: number } | null {
    if (route.length <= 1) return null;
    let bestIdx = 0, bestDist = Number.MAX_VALUE, bestPoint = route[0]!;
    for (let i = 0; i < route.length - 1; i++) {
      const { point, distance } = SpotScheduler.projectOntoSegment(pos, route[i]!, route[i + 1]!);
      if (distance < bestDist) { bestDist = distance; bestIdx = i; bestPoint = point; }
    }
    if (!(bestDist < 500)) return null;
    let remaining = aheadM;
    let i = bestIdx;
    let a = bestPoint;
    while (i + 1 < route.length) {
      const b = route[i + 1]!;
      const seg = localDistanceM(a, b);
      if (seg >= remaining && seg > 0) {
        const f = remaining / seg;
        return {
          coordinate: { lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f },
          bearingDeg: SpotScheduler.bearingDeg(a, b),
        };
      }
      remaining -= seg;
      a = b;
      i += 1;
    }
    const last = route[route.length - 1]!;
    return { coordinate: last, bearingDeg: SpotScheduler.bearingDeg(route[route.length - 2]!, last) };
  }

  /** Nearest point on segment ab to p, and the distance to it (metres, equirectangular). */
  private static projectOntoSegment(p: LngLat, a: LngLat, b: LngLat): { point: LngLat; distance: number } {
    const mPerLat = 111_320;
    const mPerLng = 111_320 * Math.cos((a.lat * Math.PI) / 180);
    const ax = 0, ay = 0;
    const bx = (b.lng - a.lng) * mPerLng, by = (b.lat - a.lat) * mPerLat;
    const px = (p.lng - a.lng) * mPerLng, py = (p.lat - a.lat) * mPerLat;
    const len2 = (bx - ax) * (bx - ax) + (by - ay) * (by - ay);
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / len2)) : 0;
    const qx = ax + t * (bx - ax), qy = ay + t * (by - ay);
    return {
      point: { lat: a.lat + qy / mPerLat, lng: a.lng + qx / mPerLng },
      distance: Math.sqrt((px - qx) * (px - qx) + (py - qy) * (py - qy)),
    };
  }

  /** Great-circle destination point: `meters` from `c` along `bearingDeg`. */
  static project(c: LngLat, meters: number, bearingDeg: number): LngLat {
    const r = 6_371_000;
    const d = meters / r;
    const brg = (bearingDeg * Math.PI) / 180;
    const lat1 = (c.lat * Math.PI) / 180;
    const lon1 = (c.lng * Math.PI) / 180;
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brg));
    const lon2 = lon1 + Math.atan2(Math.sin(brg) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
    return { lat: (lat2 * 180) / Math.PI, lng: (lon2 * 180) / Math.PI };
  }

  /** Initial great-circle bearing from `a` to `b`, degrees clockwise from north. */
  static bearingDeg(a: LngLat, b: LngLat): number {
    const lat1 = (a.lat * Math.PI) / 180;
    const lat2 = (b.lat * Math.PI) / 180;
    const dLon = ((b.lng - a.lng) * Math.PI) / 180;
    const y = Math.sin(dLon) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    const deg = (Math.atan2(y, x) * 180) / Math.PI;
    return (deg + 360) % 360;
  }

  // ─── Diagnostics ──────────────────────────────────────────────────────────

  private logTargetChange(target: NearbySpot | null, nearby: NearbySpot[], ctx: SchedulerContext) {
    const targetId = target?.spot.id ?? null;
    if (targetId === this.lastTargetId) return;
    const prevId = this.lastTargetId;
    const prev = prevId ? nearby.find((s) => s.spot.id === prevId) : undefined;
    if (prevId && prev) {
      const along = this.alongCourseM(prev, ctx);
      const passed = along != null && along < 0 && this.distanceM(prev, ctx.location) > SCHEDULER.hereM;
      this.log(passed ? "spot_passed" : "target_replaced", {
        title: prev.spot.title,
        behindM: Math.round(-(along ?? 0)),
        played: ctx.lastPlayedAtS(prevId) != null,
      });
    }
    this.lastTargetId = targetId;
    if (target) {
      const opens = this.opensInS(target, ctx);
      this.log("up_next", {
        title: target.spot.title,
        distanceM: Math.round(this.distanceM(target, ctx.location)),
        opensInS: opens == null ? -1 : Math.round(opens),
        playCount: ctx.playCount(target.spot.id),
        busyForS: Math.round(ctx.busyForS),
      });
    } else {
      this.log("up_next_none", { eligibleNearby: nearby.filter((s) => this.isEligible(s, ctx)).length });
    }
  }
}
