import { FiloDocument, annotateSentences, annotateWords } from "filo";
import type { FiloDocumentJson, GenerationProvenance, QuizPayload } from "@grandtour/shared";
import { TIER } from "@grandtour/shared";
import { synthesize } from "../tts";
import { contentVersion, putAudio } from "../storage";
import { env } from "../../env";

/**
 * Quiz fill-in narration — sibling of vocab.ts (plans/014-fillin-content.md).
 *
 * Same deliberate divergence from generate.ts's location pipeline as vocab:
 * NO reverse-geocode / source-vetting / refusal step, because a quiz item
 * makes no claim about the traveler's location — its factual guard is the
 * structured data source in `payload.source` (e.g. a Wikidata query),
 * checked at import/review time. Do not route this through the location
 * pipeline, and do not weaken that pipeline to accommodate it.
 *
 * The script is assembled deterministically from the payload (no LLM call):
 * category → question → recall pause → answers in order → optional note.
 * As with vocab, the pause makes provider char timing unmappable to the
 * display text, so the document is saved WITHOUT an audio tier on purpose.
 */

export interface QuizScript {
  /** Clean text for the filo document (and the on-device voice fallback). */
  displayText: string;
  /** Same script with the pauses as provider break tags; TTS input only. */
  ttsText: string;
  /** Spoken units + trailing silence; mirrored by QuizSpeech.swift on iOS —
   * keep them in sync. */
  beats: QuizBeat[];
}

export interface QuizBeat {
  text: string;
  /** Seconds of silence after this beat. */
  pauseAfter: number;
}

const NUMBER_WORDS = ["One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];

/** End a fragment with terminal punctuation so beats read as sentences. */
function sentenceCase(s: string): string {
  const t = s.trim();
  return /[.!?…]$/.test(t) ? t : `${t}.`;
}

/** A question beat should actually ask — default to "?" when unpunctuated. */
function questionCase(s: string): string {
  const t = s.trim();
  return /[.!?…]$/.test(t) ? t : `${t}?`;
}

/** More answers to recall → more think time. Capped so a ten-item list
 * doesn't leave the traveler in dead air the feature exists to fill. */
export function quizThinkPause(baseSeconds: number, answerCount: number): number {
  return Math.min(baseSeconds + 1.5 * (answerCount - 1), 10);
}

/**
 * The full spoken structure, `thinkPauseSeconds` being the base recall gap
 * after the question (scaled up per extra answer by `quizThinkPause`):
 *
 *   {Category} quiz. · {question} ····· (think)
 *   [one answer]   The answer: X. ·
 *   [many answers] There are N. · One: X. · Two: Y. … ·
 *   [note]         {note}
 */
export function buildQuizScript(p: QuizPayload, thinkPauseSeconds: number): QuizScript {
  const beats: QuizBeat[] = [
    { text: `${p.category.trim()} quiz.`, pauseAfter: 0.5 },
    {
      text: questionCase(p.question),
      pauseAfter: quizThinkPause(thinkPauseSeconds, p.answers.length),
    },
  ];

  if (p.answers.length === 1) {
    beats.push({ text: `The answer: ${sentenceCase(p.answers[0]!)}`, pauseAfter: 0.8 });
  } else {
    beats.push({ text: `There are ${p.answers.length}.`, pauseAfter: 0.6 });
    p.answers.forEach((a, i) => {
      const num = NUMBER_WORDS[i] ?? `Number ${i + 1}`;
      beats.push({
        text: `${num}: ${sentenceCase(a)}`,
        pauseAfter: i === p.answers.length - 1 ? 0.8 : 0.6,
      });
    });
  }

  if (p.note) beats.push({ text: sentenceCase(p.note), pauseAfter: 0 });
  const last = beats[beats.length - 1]!;
  last.pauseAfter = 0;

  return {
    // Long (think-length) pauses read as an ellipsis in the transcript.
    displayText: beats.map((b) => (b.pauseAfter >= 2 ? `${b.text} …` : b.text)).join(" "),
    ttsText: beats
      .map((b) =>
        b.pauseAfter > 0
          ? // Provider break tags top out at 3s; the on-device voice (which
            // most quiz items use until audio is generated) takes the full
            // computed pause from `beats`.
            `${b.text} <break time="${Math.min(b.pauseAfter, 3)}s" />`
          : b.text,
      )
      .join(" "),
    beats,
  };
}

export const DEFAULT_QUIZ_PAUSE_SECONDS = 3;

/**
 * The item's script as a minimal filo document (text only, no tiers) —
 * attached at import/create time so the item is speakable by the iOS
 * on-device voice immediately, with zero TTS cost. `generateQuizAudio`
 * later replaces it with the tiered document + recorded audio.
 */
export function quizScriptDocument(itemId: string, payload: QuizPayload): FiloDocumentJson {
  const text = buildQuizScript(payload, DEFAULT_QUIZ_PAUSE_SECONDS).displayText;
  return {
    id: `doc_${itemId}`,
    text,
    byteLength: new TextEncoder().encode(text).length,
    metadata: { locale: "en" },
    tiers: [],
  };
}

export interface QuizGenerateInput {
  itemId: string;
  payload: QuizPayload;
  voiceId?: string | undefined;
  pauseSeconds: number;
}

export interface QuizGenerateOutput {
  document: FiloDocumentJson;
  audioUrl: string;
  durationMs: number | null;
  provenance: GenerationProvenance;
}

/** Script → filo document (words + sentences, no audio tier) → TTS → upload. */
export async function generateQuizAudio(input: QuizGenerateInput): Promise<QuizGenerateOutput> {
  const script = buildQuizScript(input.payload, input.pauseSeconds);

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
