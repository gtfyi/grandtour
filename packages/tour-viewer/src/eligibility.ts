import type { NearbySpot, SchedulerContext, TrackExport } from "@grandtour/shared";
import { ringAreaM2 } from "@grandtour/shared";

/**
 * Whole-track rules a nearby snapshot cannot see — the web counterparts of
 * `PlaybackEligibility` and the gap planner's ambient choice on the phone.
 */

export const isArea = (item: NearbySpot): boolean => item.spot.trigger.kind === "area";

/**
 * A story with a `sequence` waits until every earlier part of the same
 * sequence in its track has been heard. Parts the bundle does not list pass,
 * as on the phone before its manifest arrives.
 */
export function sequenceReleased(
  item: NearbySpot,
  bundle: TrackExport | undefined,
  heard: (spotId: string) => boolean,
): boolean {
  const sequence = item.spot.sequence;
  if (!sequence || !bundle) return true;
  return bundle.spots.every(({ spot }) =>
    spot.sequence?.key !== sequence.key || spot.sequence.index >= sequence.index || heard(spot.id));
}

/**
 * The phone's `pickAmbientSpot` choice for a gap: unheard first, then the
 * longest-forgotten, then the most specific fence — a neighbourhood
 * collection beats a county-wide one. The first candidate wins a tie, as
 * Swift's `min(by:)` does.
 */
export function pickAmbient(
  candidates: NearbySpot[],
  history: Pick<SchedulerContext, "playCount" | "lastPlayedAtS">,
): NearbySpot | null {
  let best: NearbySpot | null = null;
  for (const s of candidates) if (!best || ambientBefore(s, best, history)) best = s;
  return best;
}

function ambientBefore(a: NearbySpot, b: NearbySpot, history: Pick<SchedulerContext, "playCount" | "lastPlayedAtS">): boolean {
  const pa = history.playCount(a.spot.id) === 0 ? 0 : 1;
  const pb = history.playCount(b.spot.id) === 0 ? 0 : 1;
  if (pa !== pb) return pa < pb;
  const la = history.lastPlayedAtS(a.spot.id) ?? -Infinity;
  const lb = history.lastPlayedAtS(b.spot.id) ?? -Infinity;
  if (la !== lb) return la < lb;
  return ringAreaM2(a.spot.trigger.region) < ringAreaM2(b.spot.trigger.region);
}
