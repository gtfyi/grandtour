import { FiloDocument, annotateSentences, annotateWords } from "filo";
import type { FiloDocumentJson, GenerationProvenance, Locating, Spot } from "@grandtour/shared";
import { SIDES, SIDE_TOKEN, TIER, triggerAnchor } from "@grandtour/shared";
import { exaSearch, reverseGeocode, wikipediaNearby, type SourceDoc } from "./search";
import { draftNarration, vetSources } from "./script";
import { synthesize } from "./tts";
import { contentVersion, putAudio } from "./storage";
import { env } from "../env";

export interface GenerateInput {
  spot: Spot;
  trackName: string;
  brief?: string;
  locale: string;
  variant: string;
  voiceId?: string;
  targetSeconds: number;
  useSearch: boolean;
  useWikipedia: boolean;
  synthesizeAudio: boolean;
}

export interface GeneratedPiece {
  variant: string;
  document: FiloDocumentJson;
  audioUrl: string | null;
  durationMs: number | null;
}

export interface GenerateOutput {
  /** Currently always a single piece under the requested variant. */
  pieces: GeneratedPiece[];
  provenance: GenerationProvenance;
}

/**
 * End-to-end AI narration:
 *   gather sources (exa.ai + Wikipedia)
 *     -> draft script (Claude)
 *       -> build filo document (words + sentences tiers)
 *         -> synthesize audio with char timestamps (ElevenLabs)
 *           -> align audio tier to sentence byte ranges
 *             -> upload audio, return aligned FiloDocumentJson.
 */
export async function generateNarration(input: GenerateInput): Promise<GenerateOutput> {
  // The spot's representative coordinate: the trigger center, or an area
  // fence's centroid — generation stays location-anchored for every kind.
  const center = triggerAnchor(input.spot.trigger);
  if (!center) {
    throw new Error("Refusing to generate: this spot has no location to anchor sources to.");
  }

  // 0. Anchor to the real-world location of the spot. Without this, a generic
  //    title like "Spot Clinic" searches the whole web and can return a
  //    completely wrong place (e.g. a clinic in Lisbon for a spot in Maine).
  const place = await reverseGeocode(center.lat, center.lng);
  const placeLabel = place?.label ?? `${center.lat.toFixed(4)}, ${center.lng.toFixed(4)}`;

  // 1. Gather sources, all anchored to this location. Channel failures are
  //    non-fatal but must leave a trace: logged here, recorded in provenance
  //    warnings so the admin reviewer can see generation ran source-starved.
  //    Keep messages generic (provider + short reason) — provenance rides
  //    along on public /nearby responses.
  const warnings: string[] = [];
  const noteFailure = (channel: string, err: unknown) => {
    const reason = err instanceof Error ? err.message.split("\n")[0]!.slice(0, 200) : "unknown error";
    const msg = `${channel} failed: ${reason}`;
    console.warn(`[generate] spot ${input.spot.id}: ${msg}`);
    warnings.push(msg);
  };

  const sources: SourceDoc[] = [];
  if (input.useWikipedia) {
    try {
      // GeoSearch is already coordinate-based, so it's inherently local.
      sources.push(...(await wikipediaNearby(center.lat, center.lng, { limit: 3 })));
    } catch (err) {
      noteFailure("wikipedia geosearch", err);
    }
  }
  if (input.useSearch) {
    try {
      // Bake the place name into the query so exa stays in the right city/region.
      const queries = [
        [input.spot.title, input.spot.subtitle, "in", placeLabel, input.trackName]
          .filter(Boolean)
          .join(" ")
          .trim(),
      ];
      // The brief names the story the creator wants told; search for it too,
      // still anchored to the place so exa can't wander off-location.
      if (input.brief) queries.push(`${input.brief} ${placeLabel}`.trim());
      const results = await Promise.all(queries.map((q) => exaSearch(q)));
      const seen = new Set(sources.map((s) => s.url));
      for (const doc of results.flat()) {
        if (seen.has(doc.url)) continue;
        seen.add(doc.url);
        sources.push(doc);
      }
    } catch (err) {
      noteFailure("exa search", err);
    }
  }

  // 2. Verify the gathered sources are actually about THIS place, and drop
  //    mismatches. If nothing credible remains, refuse rather than narrate a
  //    wrong-location article.
  const vetted = await vetSources({
    spotTitle: input.spot.title,
    spotSubtitle: input.spot.subtitle,
    brief: input.brief,
    placeLabel,
    lat: center.lat,
    lng: center.lng,
    sources,
  });
  if (vetted.length === 0 && sources.length > 0) {
    throw new Error(
      `No gathered sources could be confirmed to be about "${input.spot.title}" near ${placeLabel}. ` +
        `Refusing to generate to avoid wrong-location narration. Add a brief or refine the spot title/subtitle.`,
    );
  }

  // 3. Draft the spoken script, anchored to the verified place and sources.
  const script = await draftNarration({
    spotTitle: input.spot.title,
    spotSubtitle: input.spot.subtitle,
    trackName: input.trackName,
    placeLabel,
    brief: input.brief,
    targetSeconds: input.targetSeconds,
    sources: vetted,
  });

  // 3. Build the filo document with words + sentences. (Where-to-look
  //    direction lives in the spot's separate locating instructions — see
  //    generateLocatingClips — so the narration itself is side-free.)
  const doc = FiloDocument.fromText(script.text, { metadata: { locale: input.locale } });
  annotateWords(doc, { tierId: TIER.words, language: input.locale });
  const sentenceTier = annotateSentences(doc, { tierId: TIER.sentences, language: input.locale });

  let audioUrl: string | null = null;
  let durationMs: number | null = null;

  // 4. Synthesize + align audio.
  if (input.synthesizeAudio) {
    const tts = await synthesize(script.text, { voiceId: input.voiceId });

    // Validate the provider's character segmentation against our text and
    // expand timings to string-index space BEFORE uploading anything —
    // misaligned audio must never be saved.
    const times = charTimesByStringIndex(script.text, tts.chars, tts.charEndMs);
    if (!times) {
      throw new Error(
        `TTS alignment mismatch: ElevenLabs returned ${tts.chars.length} characters ` +
          `for a ${script.text.length}-unit script. Refusing to save misaligned audio.`,
      );
    }

    const key = `narration/${input.spot.id}/${input.locale}-${input.variant}-${contentVersion(tts.audio)}.mp3`;
    audioUrl = await putAudio(key, tts.audio, tts.mimeType);
    durationMs = tts.durationMs;

    // Align: each sentence annotation owns a byte range AND a string-index span.
    alignAudioToSentences(doc, sentenceTier, times, audioUrl, tts.mimeType);
  }

  const pieces: GeneratedPiece[] = [
    {
      variant: input.variant,
      document: doc.toJSON() as FiloDocumentJson,
      audioUrl,
      durationMs,
    },
  ];

  const provenance: GenerationProvenance = {
    model: "claude-opus-4-8",
    ttsProvider: input.synthesizeAudio ? "elevenlabs" : undefined,
    voiceId: input.synthesizeAudio ? input.voiceId || env.elevenLabsVoiceId() : undefined,
    sources: script.usedSources.map((s) => ({ name: s.title, url: s.url })),
    prompt: input.brief,
    generatedAt: new Date().toISOString(),
    warnings,
  };

  return { pieces, provenance };
}

/**
 * TTS just a spot's locating instructions — tiny targeted clips, never the
 * narration. A directional template ({{side}}) yields left + right clips; a
 * fixed template yields one. Returns the clips object to store on the spot.
 */
export async function generateLocatingClips(input: {
  spotId: string;
  template: string;
  locale: string;
  voiceId?: string;
}): Promise<NonNullable<Locating["clips"]>> {
  const renditions = input.template.includes(SIDE_TOKEN)
    ? SIDES.map((side) => ({ key: side as "left" | "right" | "fixed", text: input.template.replaceAll(SIDE_TOKEN, side) }))
    : [{ key: "fixed" as const, text: input.template }];

  const clips: Locating["clips"] = {};
  for (const r of renditions) {
    const tts = await synthesize(r.text, { voiceId: input.voiceId });
    const key = `locating/${input.spotId}/${input.locale}-${r.key}-${contentVersion(tts.audio)}.mp3`;
    const audioUrl = await putAudio(key, tts.audio, tts.mimeType);
    clips[r.key] = { text: r.text, audioUrl, durationMs: tts.durationMs };
  }
  return clips;
}

/**
 * ElevenLabs reports timings per character (its own segmentation). Expand
 * them into an array indexed by JS string index (UTF-16 units) of the text
 * those characters concatenate to, so sentence string-index spans can look
 * up end times directly. Returns null when the characters don't
 * reconstruct `text` — callers must treat that as an alignment failure.
 */
export function charTimesByStringIndex(
  text: string,
  chars: string[],
  charEndMs: number[],
): number[] | null {
  if (chars.length !== charEndMs.length) return null;
  if (chars.join("") !== text) return null;
  const out = new Array<number>(text.length);
  let i = 0;
  for (let k = 0; k < chars.length; k++) {
    for (let u = 0; u < chars[k]!.length; u++) out[i++] = charEndMs[k]!;
  }
  return out;
}

/**
 * Attach one audio annotation per sentence, with start/end ms derived from the
 * per-character end times (already expanded to string-index space). The
 * sentence annotation's byte range is reused so text-highlighting and audio
 * scrubbing share one coordinate system.
 */
export function alignAudioToSentences(
  doc: FiloDocument,
  sentences: ReturnType<typeof annotateSentences>,
  charEndMs: number[],
  audioUrl: string,
  mimeType: string,
): void {
  if (charEndMs.length === 0) return;
  doc.ensureTier({
    id: TIER.audio,
    kind: "audio",
    description: "Per-sentence audio timing aligned to text byte ranges",
    source: "grandtour.tts",
  });

  for (const s of sentences) {
    // Convert the sentence's byte range back to string indices for char timing.
    const startStr = doc.stringIndexForByteOffset(s.start);
    const endStr = doc.stringIndexForByteOffset(s.end);
    const startMs = startStr > 0 ? charEndMs[Math.min(startStr - 1, charEndMs.length - 1)]! : 0;
    const endMs = charEndMs[Math.min(endStr - 1, charEndMs.length - 1)]!;

    doc.addAnnotation(TIER.audio, {
      start: s.start,
      end: s.end,
      kind: "audio",
      payload: { url: audioUrl, mimeType, startMs, endMs, source: "grandtour.tts" },
    });
  }
}
