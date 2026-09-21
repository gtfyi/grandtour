/**
 * Deterministic journey simulation for the scheduler — a port of
 * ios/Tests/JourneySimulator.swift: a traveler moves along a waypoint path
 * at constant speed while the harness replays the app's real cadence (a
 * poll every 1.5 s, trigger evaluation against each spot's radius, a fresh
 * plan at every poll and at every narration end). A plan's `playNow` starts
 * against an idle player only; narration occupies the player for its
 * scripted duration and the scheduler predicts across the remainder.
 * Nothing preempts, exactly like the app.
 */
import type { LngLat, NearbySpot } from "../src";
import { SpotScheduler, describeSpotLocation, localDistanceM, schedulerContext } from "../src";

export interface SimSpot {
  id: string;
  title: string;
  coordinate: LngLat;
  radiusM: number;
  narrationS: number;
  trackId?: string | undefined;
  trackSlug?: string | undefined;
  narratable?: boolean | undefined;
}

export interface PlayEvent {
  spotId: string;
  title: string;
  /** Simulation clock when narration started. */
  timeS: number;
  /** Traveler→spot distance at start (measured fix, like the app sees). */
  distanceM: number;
  /** Signed along-course distance at start; null without a course. */
  alongM: number | null;
  /** The locator sentence the traveler would hear at this moment. */
  locator: string;
}

export interface SimConfig {
  speedMps: number;
  mode: string;
  pollIntervalS?: number;
  tickS?: number;
  /** GPS noise amplitude; 0 = perfect fixes. Deterministic (seeded). */
  jitterM?: number;
  seed?: bigint;
  trackOrder?: string[];
  journeyRoute?: LngLat[];
  /** spotId → how many seconds BEFORE the simulation starts the spot last played. Counts as one prior play. */
  preplayed?: Record<string, number>;
  /** Absolute start time (seconds) when carrying real history between visits. */
  startS?: number;
}

export interface PlayedRecord { count: number; atS: number }

/** Persisted history carried between visits, keyed by spot id, on absolute seconds. */
export interface SimHistory {
  playCount(id: string): number;
  lastPlayedAtS(id: string): number | null;
  recordPlay(id: string, atS: number): void;
}

export function memoryHistory(): SimHistory {
  const records = new Map<string, PlayedRecord>();
  return {
    playCount: (id) => records.get(id)?.count ?? 0,
    lastPlayedAtS: (id) => records.get(id)?.atS ?? null,
    recordPlay(id, atS) {
      const r = records.get(id) ?? { count: 0, atS };
      r.count += 1;
      r.atS = atS;
      records.set(id, r);
    },
  };
}

/** Tiny deterministic RNG (SplitMix64), bit-for-bit the Swift one. */
export class SplitMix64 {
  private state: bigint;
  constructor(seed: bigint) { this.state = BigInt.asUintN(64, seed); }
  next(): bigint {
    this.state = BigInt.asUintN(64, this.state + 0x9E3779B97F4A7C15n);
    let z = this.state;
    z = BigInt.asUintN(64, (z ^ (z >> 30n)) * 0xBF58476D1CE4E5B9n);
    z = BigInt.asUintN(64, (z ^ (z >> 27n)) * 0x94D049BB133111EBn);
    return z ^ (z >> 31n);
  }
  nextUnit(): number { return Number(this.next() >> 11n) / 2 ** 53; }
}

export const fixtures = {
  /** Flat-ish test neighbourhood; offsets are equirectangular around it. */
  base: { lat: 34.078, lng: -118.361 } as LngLat,
  offset(c: LngLat, eastM: number, northM: number): LngLat {
    const mPerDegLat = 111_320;
    const mPerDegLng = 111_320 * Math.cos((c.lat * Math.PI) / 180);
    return { lat: c.lat + northM / mPerDegLat, lng: c.lng + eastM / mPerDegLng };
  },
  nearbySpot(o: {
    id: string; title: string; center: LngLat; radiusM: number; distanceM: number; triggered: boolean;
    trackId?: string | undefined; trackSlug?: string | undefined; narratable?: boolean | undefined; hasContent?: boolean | undefined; region?: LngLat[] | undefined;
  }): NearbySpot {
    const at = "2026-01-01T00:00:00.000Z";
    const trackId = o.trackId ?? "track-1";
    const narratable = o.narratable ?? true;
    const text = narratable ? `A story about ${o.title}.` : "";
    return {
      spot: {
        id: o.id, trackId, slug: o.id, title: o.title, subtitle: "",
        trigger: { kind: "point", center: o.center, radiusM: o.radiusM, ...(o.region ? { region: o.region } : {}) },
        modes: ["walking", "driving"], locating: { mode: "auto", clips: {} }, status: "published",
        createdAt: at, updatedAt: at,
      },
      track: {
        id: trackId, slug: o.trackSlug ?? "test-track", name: "Test Track", description: "", kind: "tour",
        lifecycle: "evergreen", official: true, visibility: "public", holdReason: null, heldAt: null, createdAt: at,
      },
      locating: null,
      distanceM: o.distanceM,
      triggered: o.triggered,
      content: (o.hasContent ?? true) ? {
        id: `content-${o.id}`, spotId: o.id, locale: "en", variant: "default",
        document: { id: `doc-${o.id}`, text, byteLength: 24, metadata: {}, tiers: [] },
        audioUrl: null, durationMs: null, source: "human", provenance: null, status: "published", createdAt: at, updatedAt: at,
      } : null,
      guide: null,
    };
  },
};

export class JourneySimulator {
  readonly scheduler = new SpotScheduler();
  readonly targetLog: Array<{ timeS: number; spotId: string | null }> = [];
  readonly events: PlayEvent[] = [];
  nowPlayingId: string | null = null;
  private busyUntilS = -1;
  readonly playHistory = new Map<string, PlayedRecord>();
  private rng: SplitMix64;
  private readonly cfg: Required<Omit<SimConfig, "journeyRoute" | "trackOrder" | "preplayed">> & { journeyRoute: LngLat[]; trackOrder: string[]; preplayed: Record<string, number> };

  constructor(readonly spots: SimSpot[], readonly path: LngLat[], config: SimConfig, private readonly persistent?: SimHistory) {
    this.cfg = {
      speedMps: config.speedMps, mode: config.mode,
      pollIntervalS: config.pollIntervalS ?? 1.5, tickS: config.tickS ?? 0.5,
      jitterM: config.jitterM ?? 0, seed: config.seed ?? 42n,
      trackOrder: config.trackOrder ?? [], journeyRoute: config.journeyRoute ?? [],
      preplayed: config.preplayed ?? {}, startS: config.startS ?? 1_000_000_000,
    };
    if (persistent) {
      for (const spot of spots) {
        const last = persistent.lastPlayedAtS(spot.id);
        if (last != null) this.playHistory.set(spot.id, { count: persistent.playCount(spot.id), atS: last - this.cfg.startS });
      }
    }
    this.rng = new SplitMix64(this.cfg.seed);
    for (const [id, agoS] of Object.entries(this.cfg.preplayed)) this.playHistory.set(id, { count: 1, atS: -agoS });
  }

  get skippedSpotIds(): string[] {
    const played = new Set(this.events.map((e) => e.spotId));
    return this.spots.map((s) => s.id).filter((id) => !played.has(id));
  }

  /** Run the whole path, then idle long enough to drain any narration still going. */
  run(extraIdleS = 0): void {
    const total = this.pathLengthM() / this.cfg.speedMps;
    let t = 0;
    let nextPollAt = 0;
    while (t <= total + extraIdleS) {
      const truePos = this.position(Math.min(t, total));
      const course = t < total ? this.courseDeg(t) : null;
      const speed = t < total ? this.cfg.speedMps : 0;
      if (this.nowPlayingId != null && t >= this.busyUntilS) {
        this.nowPlayingId = null;
        this.decide(t, this.measured(truePos), course, speed);
      }
      if (t >= nextPollAt) {
        nextPollAt = t + this.cfg.pollIntervalS;
        this.decide(t, this.measured(truePos), course, speed);
      }
      t += this.cfg.tickS;
    }
  }

  decide(t: number, pos: LngLat, course: number | null, speed: number): void {
    const nearby = this.nearbyList(pos);
    const ctx = this.context(pos, course, speed, t);
    const plan = this.scheduler.plan(nearby, ctx);
    const targetId = plan.target?.spot.id ?? null;
    const previous = this.targetLog.length ? this.targetLog[this.targetLog.length - 1]!.spotId : null;
    if (previous !== targetId) {
      this.targetLog.push({ timeS: t, spotId: targetId });
    }
    if (this.nowPlayingId != null || !plan.playNow) return;
    const best = plan.playNow;
    this.events.push({
      spotId: best.spot.id,
      title: best.spot.title,
      timeS: t,
      distanceM: this.scheduler.distanceM(best, pos),
      alongM: this.scheduler.alongCourseM(best, ctx),
      locator: describeSpotLocation({
        spotLat: best.spot.trigger.center!.lat, spotLng: best.spot.trigger.center!.lng,
        userLat: pos.lat, userLng: pos.lng, courseDeg: course, anchor: null, metric: true,
      }),
    });
    const record = this.playHistory.get(best.spot.id) ?? { count: 0, atS: t };
    record.count += 1;
    record.atS = t;
    this.playHistory.set(best.spot.id, record);
    this.persistent?.recordPlay(best.spot.id, this.cfg.startS + t);
    this.nowPlayingId = best.spot.id;
    const dur = this.spots.find((s) => s.id === best.spot.id)?.narrationS ?? 30;
    this.busyUntilS = t + dur;
  }

  context(pos: LngLat, course: number | null, speed: number, atS = 0) {
    const startS = this.cfg.startS;
    const history = this.playHistory;
    const spots = this.spots;
    return schedulerContext({
      location: { lat: pos.lat, lng: pos.lng, speedMps: speed },
      courseDeg: course,
      mode: this.cfg.mode,
      journeyRoute: this.cfg.journeyRoute,
      trackOrder: this.cfg.trackOrder,
      trackIdToSlug: Object.fromEntries(spots.map((s) => [s.trackId ?? "track-1", s.trackSlug ?? "test-track"])),
      nowS: startS + atS,
      lastPlayedAtS: (id) => { const r = history.get(id); return r ? startS + r.atS : null; },
      playCount: (id) => history.get(id)?.count ?? 0,
      busyForS: Math.max(0, this.busyUntilS - atS),
      nowPlayingId: this.nowPlayingId,
      durationS: (s) => spots.find((x) => x.id === s.spot.id)?.narrationS ?? 30,
    });
  }

  nearbyList(pos: LngLat): NearbySpot[] {
    return this.spots.map((s) => {
      const d = localDistanceM(pos, s.coordinate);
      return fixtures.nearbySpot({
        id: s.id, title: s.title, center: s.coordinate, radiusM: s.radiusM,
        distanceM: d, triggered: d <= s.radiusM,
        trackId: s.trackId, trackSlug: s.trackSlug, narratable: s.narratable,
      });
    }).sort((a, b) => a.distanceM - b.distanceM);
  }

  private measured(pos: LngLat): LngLat {
    if (!(this.cfg.jitterM > 0)) return pos;
    const dx = (this.rng.nextUnit() * 2 - 1) * this.cfg.jitterM;
    const dy = (this.rng.nextUnit() * 2 - 1) * this.cfg.jitterM;
    return fixtures.offset(pos, dx, dy);
  }

  private pathLengthM(): number {
    let total = 0;
    for (let i = 0; i + 1 < this.path.length; i++) total += localDistanceM(this.path[i]!, this.path[i + 1]!);
    return total;
  }

  /** Constant-speed position along the waypoint path at time `t`. */
  position(t: number): LngLat {
    let remaining = this.cfg.speedMps * t;
    if (this.path.length <= 1) return this.path[0]!;
    for (let i = 0; i < this.path.length - 1; i++) {
      const a = this.path[i]!, b = this.path[i + 1]!;
      const seg = localDistanceM(a, b);
      if (remaining <= seg && seg > 0) {
        const f = remaining / seg;
        return { lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f };
      }
      remaining -= seg;
    }
    return this.path[this.path.length - 1]!;
  }

  /** Direction of travel = bearing of the current path segment. */
  private courseDeg(t: number): number | null {
    let remaining = this.cfg.speedMps * t;
    if (this.path.length <= 1) return null;
    for (let i = 0; i < this.path.length - 1; i++) {
      const a = this.path[i]!, b = this.path[i + 1]!;
      const seg = localDistanceM(a, b);
      if (remaining <= seg) return SpotScheduler.bearingDeg(a, b);
      remaining -= seg;
    }
    return SpotScheduler.bearingDeg(this.path[this.path.length - 2]!, this.path[this.path.length - 1]!);
  }
}
