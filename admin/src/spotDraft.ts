import type { LngLat, PolygonRing } from "@grandtour/shared";

/** Keep the area map pin independent from its playback fence when saving. */
export function triggerFromDraft(d: {
  kind: "point" | "area";
  center: LngLat;
  radiusM: number;
  region?: PolygonRing;
}) {
  return {
    kind: d.kind,
    center: d.center,
    radiusM: d.radiusM,
    region: d.kind === "area" ? d.region ?? [] : d.region,
  };
}
