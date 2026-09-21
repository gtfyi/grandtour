import type { NearbySpot } from "@grandtour/shared";

interface Props {
  item: NearbySpot;
  onTap: () => void;
}

/** Meters under a kilometer, otherwise one decimal of km — matches
 * ios/Sources/ContentView.swift's formatDistance. */
export function formatDistance(m: number): string {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

/** Modeled on ios/Sources/ContentView.swift's SpotCard. */
export function SpotCard({ item, onTap }: Props) {
  return (
    <button className="spot-card" onClick={onTap}>
      <div className="spot-card-track">
        <span className="dot" style={{ background: item.track.color ?? "#3c8b9b" }} />
        {item.track.name}
      </div>
      <div className="spot-card-title">{item.spot.title}</div>
      <div className="spot-card-meta">
        <span>{formatDistance(item.distanceM)}</span>
        {item.content?.audioUrl && <span title="Has narration">〰</span>}
        {item.triggered && <span className="here">• here</span>}
      </div>
    </button>
  );
}
