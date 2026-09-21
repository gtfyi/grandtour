/**
 * The traveler's activity mode — walking, driving, … — as the phone infers
 * it (`ActivityModeDetector` in ios/Sources/ActivityMode.swift, ported
 * here line for line so the web app moves the same way).
 *
 * Hysteresis by design: the median speed over the last window must be
 * clearly fast (≥ 7 m/s ≈ 16 mph, sustained) to become `driving`, or
 * clearly slow (≤ 2.5 m/s, a brisk walk) to become `walking`; anything in
 * between keeps the current answer. Cycling sits in that band and is never
 * inferred — pick it explicitly. Traffic stops don't flip a driver back to
 * walking: a red light is shorter than the window, and the median resists it.
 */

import { ActivityMode } from "./content";

/** Every mode a traveler can pick explicitly, in the phone's picker order (`ActivityModePreference.explicit`). */
export const ACTIVITY_MODES: readonly ActivityMode[] = ActivityMode.options;

export class ActivityModeDetector {
  current: string;
  private samples: Array<{ atS: number; speed: number }> = [];

  constructor(
    initial: string = "walking",
    private readonly windowS = 20,
    private readonly minSamples = 5,
    private readonly drivingMps = 7,
    private readonly walkingMps = 2.5,
  ) {
    this.current = initial;
  }

  /** Feed one fix. Negative speeds ("unknown") are ignored. Returns the new mode when the inference changes, else null. */
  observe(speedMps: number, atS: number): string | null {
    if (!(speedMps >= 0)) return null;
    this.samples.push({ atS, speed: speedMps });
    this.samples = this.samples.filter((s) => atS - s.atS <= this.windowS);
    const first = this.samples[0];
    if (this.samples.length < this.minSamples || !first || atS - first.atS < this.windowS / 2) return null;
    const sorted = this.samples.map((s) => s.speed).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    let next: string;
    if (median >= this.drivingMps) next = "driving";
    else if (median <= this.walkingMps) next = "walking";
    else return null;
    if (next === this.current) return null;
    this.current = next;
    return next;
  }
}
