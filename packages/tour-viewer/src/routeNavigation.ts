import type { NearbySpot, RoutedTrack } from "@grandtour/shared";
import type { NarrationStop } from "./narrationRoute";

/** The forward button and Up next must point to the same future entrance. */
export function nextRouteStop(stops: NarrationStop[], distanceM: number, available: (item: NearbySpot) => boolean) {
  return stops.find((stop) => stop.distM >= distanceM && available(stop.item));
}

export function previousRouteStop(stops: NarrationStop[], distanceM: number, currentId: string | null) {
  // Do not merely restart the story currently playing. Revisit the previous
  // distinct stop, including stops sharing an entrance at the start of a route.
  let currentIndex = -1;
  for (let i = stops.length - 1; i >= 0; i--) {
    if (stops[i]!.distM <= distanceM && stops[i]!.item.spot.id === currentId) { currentIndex = i; break; }
  }
  for (let i = (currentIndex >= 0 ? currentIndex : stops.length) - 1; i >= 0; i--) {
    const stop = stops[i]!;
    if (stop.item.spot.id !== currentId && (stop.distM < distanceM || (currentIndex >= 0 && stop.distM === distanceM))) return stop;
  }
}

export function reverseRoute(route: RoutedTrack): RoutedTrack {
  return { ...route, path: [...route.path].reverse(), order: [...route.order].reverse() };
}
