import type { NearbySpot } from "@grandtour/shared";
import { canNarrate } from "./TourPlayback";
import { Transcript } from "./Transcript";

interface Props {
  item: NearbySpot | null;
  label: string;
  playing: boolean;
  selected: boolean;
  currentMs: number;
  source: "device" | "recording" | null;
  error: string | null;
  onOpen: () => void;
  onToggle: () => void;
}

/** Current-story controls and a compact, synchronized transcript. */
export function NowPlayingCard({ item, label, playing, selected, currentMs, source, error, onOpen, onToggle }: Props) {
  const document = selected ? item?.content?.document : null;
  return <section className={`now-playing-card${document ? " has-transcript" : ""}`} aria-label={label}>
    <div className="now-playing-header">
      <button className="story-summary" onClick={onOpen} disabled={!item} aria-label={item ? `Open story: ${item.spot.title}` : label}>
        <span className="story-label">{error ? "Playback needs attention" : label}</span>
        <span className="now-playing-title">{item?.spot.title ?? "No more stops"}</span>
      </button>
      {item && selected && canNarrate(item) && <button className="icon-btn" onClick={onToggle}
        aria-label={playing ? "Pause narration" : "Play narration"}>{playing ? "⏸" : "▶"}</button>}
    </div>
    {document && <div className="now-playing-transcript" tabIndex={0} aria-label={`Transcript: ${item?.spot.title ?? "Selected story"}`}>
      <Transcript document={document} currentMs={source === "recording" ? currentMs : -1} followActive />
    </div>}
  </section>;
}
