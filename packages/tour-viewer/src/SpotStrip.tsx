import type { NearbySpot } from "@grandtour/shared";
import { SpotCard } from "./SpotCard";

interface Props {
  spots: NearbySpot[];
  onSelect: (id: string) => void;
}

/** Modeled on ios/Sources/ContentView.swift's spotStrip: a horizontal rail
 * of what's on the map right now. */
export function SpotStrip({ spots, onSelect }: Props) {
  if (spots.length === 0) {
    return <div className="spot-strip-empty">No stories here yet.</div>;
  }
  return (
    <div className="spot-strip">
      {spots.map((item) => (
        <SpotCard key={item.spot.id} item={item} onTap={() => onSelect(item.spot.id)} />
      ))}
    </div>
  );
}
