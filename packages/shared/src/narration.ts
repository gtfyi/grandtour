import type { ContentPiece } from "./content";
import type { NearbySpot } from "./api";

/**
 * How long a piece of narration runs — the scheduler's lead window and the
 * "does this filler fit" test need it. Exact when the server measured the
 * recorded clip; otherwise estimated from the text at on-device speaking
 * pace, with scripted "…" pauses counted. Mirrors `NarrationDuration` on
 * the phone.
 */
export const NARRATION = {
  /** AVSpeechSynthesizer at default rate, roughly. */
  wordsPerSecond: 2.5,
  /** A spoken locator intro ("Coming up in 90 meters on your left."). */
  introS: 4,
  /** Think-time rendered for each "…" in a script. */
  ellipsisPauseS: 2.5,
} as const;

export function narrationSecondsForText(text: string): number {
  if (!text) return 0;
  const words = text.split(/\s+/).filter(Boolean).length;
  const pauses = Math.max(0, text.split("…").length - 1) * NARRATION.ellipsisPauseS;
  return words / NARRATION.wordsPerSecond + pauses;
}

export function narrationSecondsForContent(content: ContentPiece | null | undefined): number {
  if (!content) return 0;
  if (content.durationMs != null && content.durationMs > 0) return content.durationMs / 1000;
  return narrationSecondsForText(content.document?.text ?? "");
}

/** A spot's narration as the tour plays it: locator intro, then the story. */
export function narrationDurationS(item: NearbySpot): number {
  return narrationSecondsForContent(item.content) + NARRATION.introS;
}
