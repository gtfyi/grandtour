import { useEffect, useRef, useState } from "react";
import type { NearbySpot } from "@grandtour/shared";
import { canNarrate } from "./TourPlayback";
import { Transcript } from "./Transcript";
import { formatDistance, type Units } from "./units";

interface Props {
  stories: NearbySpot[];
  initialId: string;
  selectedId: string | null;
  playing: boolean;
  currentMs: number;
  source: "device" | "recording" | null;
  error: string | null;
  units: Units;
  onPlay: (item: NearbySpot) => void;
  onToggle: () => void;
  onClose: () => void;
}

export function StoryReader({ stories, initialId, selectedId, playing, currentMs, source, error, units, onPlay, onToggle, onClose }: Props) {
  const dialog = useRef<HTMLDivElement>(null);
  const pages = useRef<HTMLDivElement>(null);
  const index = useRef(Math.max(0, stories.findIndex((story) => story.spot.id === initialId)));
  const [page, setPage] = useState(index.current);
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const scroller = pages.current!;
    const place = () => { scroller.scrollLeft = index.current * scroller.clientWidth; };
    place();
    const resize = new ResizeObserver(place);
    resize.observe(scroller);
    dialog.current?.focus();
    return () => { resize.disconnect(); previousFocus?.focus(); };
  }, []);
  const turn = (direction: number) => {
    const scroller = pages.current!;
    const next = Math.max(0, Math.min(stories.length - 1, Math.round(scroller.scrollLeft / scroller.clientWidth) + direction));
    scroller.scrollTo({ left: next * scroller.clientWidth, behavior: "smooth" });
  };
  return <div className="story-reader" role="dialog" aria-modal="true" aria-label="Tour stories" tabIndex={-1} ref={dialog}
    onKeyDown={(event) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowLeft") { event.preventDefault(); turn(-1); }
      if (event.key === "ArrowRight") { event.preventDefault(); turn(1); }
      if (event.key === "Tab") {
        const controls = [
          ...dialog.current!.querySelectorAll<HTMLElement>('.reader-header button:not(:disabled)'),
          ...pages.current!.children[index.current]!.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]'),
        ];
        const current = controls.indexOf(document.activeElement as HTMLElement);
        event.preventDefault();
        const next = current < 0 ? (event.shiftKey ? controls.length - 1 : 0)
          : (current + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
        controls[next]?.focus();
      }
    }}>
    <header className="reader-header">
      <button className="ghost" onClick={() => turn(-1)} aria-label="Previous story" disabled={page === 0}>←</button>
      <span>Story {page + 1} / {stories.length}</span>
      <button className="ghost" onClick={() => turn(1)} aria-label="Next story" disabled={page === stories.length - 1}>→</button>
      <button className="ghost" onClick={onClose} aria-label="Close stories">✕</button>
    </header>
    <div className="story-pages" ref={pages} onScroll={() => {
      const scroller = pages.current!;
      index.current = Math.round(scroller.scrollLeft / scroller.clientWidth);
      setPage(index.current);
    }}>
      {stories.map((item, i) => {
        const active = item.spot.id === selectedId;
        return <article className="story-page" key={item.spot.id} aria-label={item.spot.title} aria-hidden={i !== page}>
          <div className="story-page-heading">
            <h2>{item.spot.title}</h2>
            <p className="muted">{formatDistance(item.distanceM, units)} away</p>
            {canNarrate(item) && <button onClick={() => active ? onToggle() : onPlay(item)}>
              {active && playing ? "Pause narration" : "Play narration"}
            </button>}
          </div>
          <div className="story-text" tabIndex={0} aria-label={`Story text: ${item.spot.title}`}>
            {item.content?.document ? <Transcript document={item.content.document} currentMs={active && source === "recording" ? currentMs : -1} />
              : <p>{item.spot.subtitle ?? "No story has been published yet."}</p>}
            {active && error && <p className="warn" role="alert">{error}</p>}
          </div>
        </article>;
      })}
    </div>
  </div>;
}
