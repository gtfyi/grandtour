import type { LngLat } from "@grandtour/shared";

/** A relaxed response hides small target timing variations without feeling detached. */
export const TRAVELER_RESPONSE_MS = 260;

/** Never turn one delayed animation frame into a large, visible marker jump. */
export const MAX_TRAVELER_FRAME_MS = 34;

export function travelerFrameElapsed(elapsedMs: number): number {
  return Math.max(0, Math.min(elapsedMs, MAX_TRAVELER_FRAME_MS));
}

/**
 * Ease the traveler marker toward its newest target without tying the result to
 * a particular display refresh rate. The exponential step composes cleanly:
 * ten 16 ms frames produce the same position as one 160 ms frame.
 */
export function smoothTravelerPosition(
  current: LngLat,
  target: LngLat,
  elapsedMs: number,
  responseMs = TRAVELER_RESPONSE_MS,
): LngLat {
  if (elapsedMs <= 0) return current;
  const alpha = 1 - Math.exp(-elapsedMs / responseMs);
  return {
    lat: current.lat + (target.lat - current.lat) * alpha,
    lng: current.lng + (target.lng - current.lng) * alpha,
  };
}

/** Ease across the shortest arc so headings never spin the long way around 0°. */
export function smoothHeading(
  currentDeg: number,
  targetDeg: number,
  elapsedMs: number,
  responseMs = TRAVELER_RESPONSE_MS,
): number {
  if (elapsedMs <= 0) return currentDeg;
  const alpha = 1 - Math.exp(-elapsedMs / responseMs);
  const delta = ((targetDeg - currentDeg + 540) % 360) - 180;
  return (currentDeg + delta * alpha + 360) % 360;
}
