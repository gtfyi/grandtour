import { useEffect, useMemo, useRef } from "react";
import type { FiloDocumentJson } from "@grandtour/shared";
import { TIER, byteToStringIndex } from "@grandtour/shared";

interface Props {
  document: FiloDocumentJson;
  currentMs: number;
  followActive?: boolean;
}

interface AudioSegment {
  byteStart: number;
  byteEnd: number;
  startMs: number;
  endMs: number;
}

/**
 * Port of ios/Sources/TranscriptView.swift: finds the audio-tier segment
 * containing `currentMs` and highlights only its text, byte range mapped to
 * a JS string index via `byteToStringIndex` — never by UTF-16 code units,
 * per the repo's UTF-8 invariant (emoji broke this once already).
 */
export function Transcript({ document, currentMs, followActive = false }: Props) {
  const activeRef = useRef<HTMLSpanElement>(null);
  const segments = useMemo<AudioSegment[]>(() => {
    const tier = document.tiers.find((t) => t.id === TIER.audio);
    if (!tier) return [];
    return tier.annotations
      .map((a) => {
        const payload = a.payload as { startMs?: number; endMs?: number };
        if (typeof payload.startMs !== "number" || typeof payload.endMs !== "number") return null;
        return { byteStart: a.start, byteEnd: a.end, startMs: payload.startMs, endMs: payload.endMs };
      })
      .filter((s): s is AudioSegment => s !== null);
  }, [document]);

  const active = segments.find((s) => currentMs >= s.startMs && currentMs < s.endMs) ?? null;

  useEffect(() => {
    const activeElement = activeRef.current;
    if (!followActive || !activeElement) return;
    const scroller = activeElement.closest<HTMLElement>(".now-playing-transcript");
    if (!scroller) return;
    const scrollerRect = scroller.getBoundingClientRect();
    const activeRect = activeElement.getBoundingClientRect();
    scroller.scrollTo({
      top: scroller.scrollTop + activeRect.top - scrollerRect.top
        - (scroller.clientHeight - activeRect.height) / 2,
      behavior: "smooth",
    });
  }, [followActive, active?.byteStart, active?.byteEnd]);

  if (!active) {
    return (
      <p className="transcript">{document.text}</p>
    );
  }

  const lo = byteToStringIndex(document.text, active.byteStart);
  const hi = byteToStringIndex(document.text, active.byteEnd);

  return (
    <p className="transcript">
      {document.text.slice(0, lo)}
      <span className="transcript-active" ref={activeRef}>{document.text.slice(lo, hi)}</span>
      {document.text.slice(hi)}
    </p>
  );
}
