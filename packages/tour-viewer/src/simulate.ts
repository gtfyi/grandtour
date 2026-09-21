import { useEffect, useState } from "react";
import type { IndexTrack, LngLat, NearbySpot, TrackExport } from "@grandtour/shared";
import { buildRoute, mphToMps, triggerAnchor } from "@grandtour/shared";
import type { NarrationStop } from "./narrationRoute";

/**
 * A demo: one track's route travelled as a simulated trip instead of
 * reading GPS, the same scheduler playing the stories as the car reaches
 * them. The Tracks sheet's Demo buttons start one in place; `?simulate=<slug>`
 * opens the page in one (`&mph=` sets the pace) — the landing page's phone
 * frame embeds `/app/?simulate=<demo track>` so a visitor anywhere can hear
 * the stories start as the car reaches them.
 */
export interface Simulation {
  slug: string;
  /** Miles per hour, or null for the track's own pace (`demoPace`). */
  mph: number | null;
}

export function parseSimulation(params: URLSearchParams): Simulation | null {
  const slug = params.get("simulate")?.trim();
  if (!slug) return null;
  const mph = Number(params.get("mph"));
  return { slug, mph: Number.isFinite(mph) && mph > 0 ? mph : null };
}

/**
 * The pace a demo travels at: the explicit mode's, else by the track's size —
 * a village tour is walked, a park road is driven. Mirrors `demoPace` in
 * ios/Sources/DemoDrive.swift.
 */
export function demoPace(track: Pick<IndexTrack, "spanKm"> | null, preference: string): number {
  if (preference === "walking" || preference === "hiking") return 3;
  if (preference === "cycling") return 10;
  if (preference === "driving" || preference === "transit") return 25;
  return track && track.spanKm < 3 ? 3 : 25;
}

/**
 * The activity mode a pace implies. The detector's own line
 * (`ActivityModeDetector`, 7 m/s sustained) — a declared pace needs no
 * window to infer it over.
 */
export function simulatedMode(mph: number): "driving" | "walking" {
  return mphToMps(mph) >= 7 ? "driving" : "walking";
}

export interface SimulatedRoute {
  /** The polyline the car follows; empty until the bundle is here and the route is ready. */
  path: LngLat[];
  preparing: boolean;
  error: string | null;
}

const EMPTY_PATH: LngLat[] = [];
const IDLE: SimulatedRoute = { path: EMPTY_PATH, preparing: false, error: null };

/** The route a demo follows: the bundle's authored `routePath`, else roads through its spots. */
export function useSimulatedRoute(bundle: TrackExport | undefined): SimulatedRoute {
  const [route, setRoute] = useState<SimulatedRoute>(IDLE);
  useEffect(() => {
    if (!bundle) { setRoute(IDLE); return; }
    if (bundle.routePath) { setRoute({ path: bundle.routePath, preparing: false, error: null }); return; }
    let alive = true;
    setRoute({ path: EMPTY_PATH, preparing: true, error: null });
    const anchors = bundle.spots.map((s) => triggerAnchor(s.spot.trigger)).filter((p): p is LngLat => p !== null);
    buildRoute(anchors)
      .then((built) => {
        if (!alive) return;
        if (built.path.length >= 2) setRoute({ path: built.path, preparing: false, error: null });
        else setRoute({ path: EMPTY_PATH, preparing: false, error: "This track has no route to follow." });
      })
      .catch(() => { if (alive) setRoute({ path: EMPTY_PATH, preparing: false, error: "Could not prepare the route." }); });
    return () => { alive = false; };
  }, [bundle]);
  return route;
}

/** Keep `?simulate=` in step with the demo, so a reload lands where the visitor was. */
export function syncDemoUrl(slug: string | null): void {
  try {
    const url = new URL(window.location.href);
    if (slug) url.searchParams.set("simulate", slug);
    else { url.searchParams.delete("simulate"); url.searchParams.delete("mph"); }
    window.history.replaceState(null, "", url);
  } catch { /* not a browser, or a frame that may not touch its history */ }
}

// ─── The driver: story to story along the route ─────────────────────────────

/** Seconds of travel the car is put before a stop, so it is seen arriving. */
export const DEMO_LEAD_S = 8;
export function demoLeadM(mph: number): number {
  return Math.max(15, mphToMps(mph) * DEMO_LEAD_S);
}

/**
 * Keep each unheard stop until it plays, even after a frame carries the
 * traveler past it. Filtering by current distance would discard arrivals
 * before `demoStep` can play them or park at them, especially off-road
 * stops that the location scheduler cannot trigger.
 */
export function nextDemoStops(stops: readonly NarrationStop[], available: (item: NearbySpot) => boolean): NarrationStop[] {
  const next: NarrationStop[] = [];
  const seen = new Set<string>();
  for (const stop of stops) {
    if (seen.has(stop.item.spot.id) || !available(stop.item)) continue;
    seen.add(stop.item.spot.id);
    next.push(stop);
    if (next.length === 2) break;
  }
  return next;
}

export interface DemoStepInput {
  /** A story is loaded — playing, or paused by the listener. */
  item: boolean;
  playing: boolean;
  /** The car is moving. */
  moving: boolean;
  distM: number;
  totalM: number;
  /** The next unheard stop ahead, by route distance, or null when none is left. */
  nextM: number | null;
  /** How long the player has been idle, or null while a story is loaded. */
  idleMs: number | null;
  /** The story spacing: the pause after a story before the next. */
  gapMs: number;
  leadM: number;
}
export type DemoStep =
  | { kind: "none" } | { kind: "park" } | { kind: "resume" }
  | { kind: "seek"; distM: number } | { kind: "play" } | { kind: "finish" };

/**
 * What the demo's car does next. A demo is the stories, not the miles
 * between them: while a story plays the car keeps its pace but never drives
 * past the next stop — it waits there; once the player is idle for the story
 * spacing, the car jumps to just before the next unheard stop, drives in, and
 * the stop is played if the scheduler did not start it on the way; after the
 * last stop it parks at the end of the route. The same function drives the
 * phone's demo (`DemoRoute.step` in ios/Sources/DemoDrive.swift).
 */
export function demoStep(s: DemoStepInput): DemoStep {
  if (s.item) {
    if (s.nextM !== null && s.distM >= s.nextM) return s.moving ? { kind: "park" } : { kind: "none" };
    if (s.playing && !s.moving && s.distM < s.totalM) return { kind: "resume" };
    return { kind: "none" };
  }
  if (s.idleMs === null || s.idleMs < s.gapMs) return { kind: "none" };
  if (s.nextM === null) return s.distM < s.totalM ? { kind: "finish" } : { kind: "none" };
  const approach = s.nextM - s.leadM;
  if (s.distM < approach) return { kind: "seek", distM: approach };
  if (s.distM < s.nextM) return s.moving ? { kind: "none" } : { kind: "resume" };
  return { kind: "play" };
}
