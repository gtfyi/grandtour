import { FiloDocument, annotateSentences, annotateWords } from "filo";
import type { FiloDocumentJson, GenerationProvenance, VocabPayload } from "@grandtour/shared";
import { TIER } from "@grandtour/shared";
import { synthesize } from "../tts";
import { contentVersion, putAudio } from "../storage";
import { env } from "../../env";

/**
 * Vocab fill-in narration (plans/014-fillin-content.md).
 *
 * Deliberate divergence from generate.ts's location pipeline: there is NO
 * reverse-geocode / source-vetting / refusal step here, because a vocab item
 * makes no claim about a place — its factual guard is the vetted word list in
 * `payload.source`, checked at admin review time. Do not route this through
 * the location pipeline, and do not weaken that pipeline to accommodate it.
 *
 * The script is assembled deterministically from the payload (no LLM call):
 * word → think-time pause → definition → example sentence → spelling. The
 * pause is baked into the audio as an SSML-style break tag, which means the
 * TTS input differs from the display text — so the provider's character
 * alignment cannot honestly map onto the document, and we deliberately save
 * the document WITHOUT an audio tier rather than save a misaligned one
 * (CLAUDE.md: misaligned TTS output must throw, not save; unaligned-on-purpose
 * is the honest alternative here). No audio tier just means no karaoke
 * highlighting for vocab items.
 */

export interface VocabScript {
  /** Clean text for the filo document (and the on-device voice fallback). */
  displayText: string;
  /** Same script with the pauses as provider break tags; TTS input only. */
  ttsText: string;
  /** The script as spoken units — what a segment-capable voice should say,
   * with the silence to leave after each unit. The iOS on-device path
   * mirrors this structure (VocabSpeech.swift); keep them in sync. */
  beats: VocabBeat[];
}

export interface VocabBeat {
  text: string;
  /** Seconds of silence after this beat. */
  pauseAfter: number;
}

/** End a fragment with terminal punctuation so beats read as sentences. */
function sentenceCase(s: string): string {
  const t = s.trim();
  return /[.!?…]$/.test(t) ? t : `${t}.`;
}

const ORDINALS = ["First", "Second", "Third", "Fourth", "Fifth"];

/** "loquacious" → "L, O, Q, U, A, C, I, O, U, S" (hyphens etc. named aloud). */
export function spellOut(word: string): string {
  return [...word]
    .map((ch) => {
      if (/[a-zA-Z]/.test(ch)) return ch.toUpperCase();
      if (ch === "-") return "hyphen";
      if (ch === "'" || ch === "’") return "apostrophe";
      if (ch === " ") return null;
      return ch;
    })
    .filter((c): c is string => c !== null)
    .join(", ");
}

/**
 * The full spoken structure, `thinkPauseSeconds` being the recall gap after
 * "Can you define X?":
 *
 *   The word is: X. · Can you define X? ····· (think)
 *   [single sense]  X, adjective, means: … · In a sentence: … ··
 *   [multi sense]   X has N meanings. · First, as an adjective: … ·
 *                   In a sentence: … ·· Second, as a noun: … ··
 *   X is spelled: … · X. ··
 */
export function buildVocabScript(p: VocabPayload, thinkPauseSeconds: number): VocabScript {
  const word = p.word.trim();
  const beats: VocabBeat[] = [
    { text: `The word is: ${word}.`, pauseAfter: 0.5 },
    { text: `Can you define ${word}?`, pauseAfter: thinkPauseSeconds },
  ];

  const posPhrase = (pos: string | undefined) =>
    pos ? `as a${/^[aeiou]/i.test(pos.trim()) ? "n" : ""} ${pos.trim()}` : "";

  if (p.senses.length === 1) {
    const s = p.senses[0]!;
    beats.push({
      text: `${word}${s.partOfSpeech ? `, ${s.partOfSpeech.trim()},` : ""} means: ${sentenceCase(s.definition)}`,
      pauseAfter: 0.8,
    });
    if (s.exampleSentence) {
      beats.push({ text: `In a sentence: ${sentenceCase(s.exampleSentence)}`, pauseAfter: 1.2 });
    }
  } else {
    beats.push({
      text: `${word} has ${p.senses.length} meanings.`,
      pauseAfter: 0.8,
    });
    p.senses.forEach((s, i) => {
      const ordinal = ORDINALS[i] ?? `Number ${i + 1}`;
      const pos = posPhrase(s.partOfSpeech);
      beats.push({
        text: `${ordinal}${pos ? `, ${pos}` : ""}: ${sentenceCase(s.definition)}`,
        pauseAfter: s.exampleSentence ? 0.6 : 1.0,
      });
      if (s.exampleSentence) {
        beats.push({ text: `In a sentence: ${sentenceCase(s.exampleSentence)}`, pauseAfter: 1.2 });
      }
    });
  }

  beats.push({ text: `${word} is spelled: ${spellOut(word)}.`, pauseAfter: 0.8 });
  beats.push({ text: `${word}.`, pauseAfter: 0 });

  return {
    // Long (think-length) pauses read as an ellipsis in the transcript.
    displayText: beats.map((b) => (b.pauseAfter >= 2 ? `${b.text} …` : b.text)).join(" "),
    ttsText: beats
      .map((b) =>
        b.pauseAfter > 0 ? `${b.text} <break time="${b.pauseAfter}s" />` : b.text,
      )
      .join(" "),
    beats,
  };
}

export const DEFAULT_PAUSE_SECONDS = 3;

/**
 * The item's script as a minimal filo document (text only, no tiers) —
 * attached at import/create time so the item is speakable by the iOS
 * on-device voice immediately, with zero TTS cost. `generateVocabAudio`
 * later replaces it with the tiered document + recorded audio. Same minimal
 * shape the admin uses when saving hand-written spot text.
 */
export function vocabScriptDocument(itemId: string, payload: VocabPayload): FiloDocumentJson {
  const text = buildVocabScript(payload, DEFAULT_PAUSE_SECONDS).displayText;
  return {
    id: `doc_${itemId}`,
    text,
    byteLength: new TextEncoder().encode(text).length,
    metadata: { locale: "en" },
    tiers: [],
  };
}

export interface VocabGenerateInput {
  itemId: string;
  payload: VocabPayload;
  voiceId?: string | undefined;
  pauseSeconds: number;
}

export interface VocabGenerateOutput {
  document: FiloDocumentJson;
  audioUrl: string;
  durationMs: number | null;
  provenance: GenerationProvenance;
}

/** Script → filo document (words + sentences, no audio tier) → TTS → upload. */
export async function generateVocabAudio(input: VocabGenerateInput): Promise<VocabGenerateOutput> {
  const script = buildVocabScript(input.payload, input.pauseSeconds);

  const doc = FiloDocument.fromText(script.displayText, { metadata: { locale: "en" } });
  annotateWords(doc, { tierId: TIER.words, language: "en" });
  annotateSentences(doc, { tierId: TIER.sentences, language: "en" });

  const tts = await synthesize(script.ttsText, { voiceId: input.voiceId });
  const key = `fillin/${input.itemId}/en-default-${contentVersion(tts.audio)}.mp3`;
  const audioUrl = await putAudio(key, tts.audio, tts.mimeType);

  const provenance: GenerationProvenance = {
    // No LLM involved: the script is a deterministic template over the payload.
    ttsProvider: "elevenlabs",
    voiceId: input.voiceId || env.elevenLabsVoiceId(),
    sources: [input.payload.source],
    generatedAt: new Date().toISOString(),
    warnings: [],
  };

  return {
    document: doc.toJSON() as FiloDocumentJson,
    audioUrl,
    durationMs: tts.durationMs > 0 ? tts.durationMs : null,
    provenance,
  };
}
