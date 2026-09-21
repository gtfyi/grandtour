import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FiloDocument, annotateSentences, annotateWords } from "filo";
import { TIER, type FiloDocumentJson, type GenerationProvenance } from "@grandtour/shared";
import { synthesize } from "./tts";
import { alignAudioToSentences, charTimesByStringIndex } from "./generate";
import { contentVersion, putAudio } from "./storage";
import { env } from "../env";

/**
 * Multi-voice voiceover for authored scripts (no LLM drafting): a narration
 * written as segments, where quote segments carry a speaker and are voiced by
 * a different ElevenLabs voice than the narrator. Segments are synthesized
 * separately (each with char-level timestamps), stitched with ffmpeg, and
 * aligned as ONE audio tier over the combined display text — so spoken-text
 * highlighting works straight across voice changes.
 *
 * The display text wraps quotes in curly quotes; the spoken text does not
 * include them. Alignment is validated per segment and the whole build throws
 * on any mismatch — misaligned audio is never saved (CLAUDE.md invariant).
 */

export interface VoiceoverSpeaker {
  name: string;
  /** Casting hint: which pool the voice comes from. */
  kind: "man" | "woman" | "publication";
}

export interface VoiceoverSegment {
  text: string;
  /** null = the narrator's voice. */
  speaker: VoiceoverSpeaker | null;
}

export interface VoiceoverInput {
  spotId: string;
  locale: string;
  variant: string;
  segments: VoiceoverSegment[];
  narratorVoiceId?: string | undefined;
}

export interface VoiceoverOutput {
  document: FiloDocumentJson;
  audioUrl: string;
  durationMs: number;
  provenance: GenerationProvenance;
}

const OPEN_Q = "“";
const CLOSE_Q = "”";
/** Beat of silence between narrator and quote segments, seconds. */
const GAP_S = 0.3;

// ─── Voice casting ──────────────────────────────────────────────────────────

interface CastVoice {
  id: string;
  name: string;
}

let voicePools: { man: CastVoice[]; woman: CastVoice[] } | null = null;

/** Available premade voices from the account, split by labeled gender. */
async function loadVoicePools(excludeId: string): Promise<{ man: CastVoice[]; woman: CastVoice[] }> {
  if (voicePools) return voicePools;
  const res = await fetch("https://api.elevenlabs.io/v1/voices", {
    headers: { "xi-api-key": env.requireElevenLabsKey() },
  });
  if (!res.ok) throw new Error(`ElevenLabs voices list failed: ${res.status}`);
  const data = (await res.json()) as {
    voices: { voice_id: string; name: string; labels?: Record<string, string> }[];
  };
  const man: CastVoice[] = [];
  const woman: CastVoice[] = [];
  for (const v of data.voices) {
    if (v.voice_id === excludeId) continue;
    const g = (v.labels?.gender ?? "").toLowerCase();
    if (g === "male") man.push({ id: v.voice_id, name: v.name });
    else if (g === "female") woman.push({ id: v.voice_id, name: v.name });
  }
  // Deterministic casting across runs.
  man.sort((a, b) => a.name.localeCompare(b.name));
  woman.sort((a, b) => a.name.localeCompare(b.name));
  if (man.length === 0 || woman.length === 0) {
    throw new Error("ElevenLabs account has no labeled male/female voices to cast from.");
  }
  voicePools = { man, woman };
  return voicePools;
}

/**
 * Assign one voice per distinct speaker name, round-robin within the pool for
 * the speaker's kind. Publications cast from the male pool's tail so they
 * don't collide with the first human castings.
 */
export async function castVoices(
  segments: VoiceoverSegment[],
  narratorVoiceId: string,
): Promise<Map<string, CastVoice>> {
  const pools = await loadVoicePools(narratorVoiceId);
  const cast = new Map<string, CastVoice>();
  let manI = 0;
  let womanI = 0;
  let pubI = 0;
  for (const seg of segments) {
    if (!seg.speaker || cast.has(seg.speaker.name)) continue;
    const { kind } = seg.speaker;
    if (kind === "woman") {
      cast.set(seg.speaker.name, pools.woman[womanI++ % pools.woman.length]!);
    } else if (kind === "man") {
      cast.set(seg.speaker.name, pools.man[manI++ % pools.man.length]!);
    } else {
      const pool = pools.man;
      cast.set(seg.speaker.name, pool[(pool.length - 1 - (pubI++ % pool.length))]!);
    }
  }
  return cast;
}

// ─── Audio stitching ────────────────────────────────────────────────────────

async function ffprobeDurationMs(path: string): Promise<number> {
  const p = Bun.spawnSync([
    "ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path,
  ]);
  const s = parseFloat(p.stdout.toString().trim());
  if (!Number.isFinite(s)) throw new Error(`ffprobe failed for ${path}`);
  return Math.round(s * 1000);
}

/** Concat mp3 segments with a short silence between, re-encoded once. */
async function stitch(dir: string, files: string[]): Promise<Uint8Array> {
  const silence = join(dir, "silence.mp3");
  let r = Bun.spawnSync([
    "ffmpeg", "-y", "-v", "error", "-f", "lavfi",
    "-i", `anullsrc=r=44100:cl=mono`, "-t", String(GAP_S), "-b:a", "128k", silence,
  ]);
  if (r.exitCode !== 0) throw new Error(`ffmpeg silence failed: ${r.stderr.toString()}`);

  const listPath = join(dir, "list.txt");
  const entries = files.flatMap((f, i) => (i === 0 ? [f] : [silence, f]));
  await writeFile(listPath, entries.map((f) => `file '${f}'`).join("\n"));

  const out = join(dir, "out.mp3");
  r = Bun.spawnSync([
    "ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0",
    "-i", listPath, "-c:a", "libmp3lame", "-b:a", "128k", out,
  ]);
  if (r.exitCode !== 0) throw new Error(`ffmpeg concat failed: ${r.stderr.toString()}`);
  return new Uint8Array(await Bun.file(out).arrayBuffer());
}

// ─── Voiceover build ────────────────────────────────────────────────────────

export async function generateVoiceover(input: VoiceoverInput): Promise<VoiceoverOutput> {
  const narratorVoiceId = input.narratorVoiceId || env.elevenLabsVoiceId();
  const cast = await castVoices(input.segments, narratorVoiceId);

  // Display text: quotes wrapped in curly quotes, segments joined by spaces.
  const displayParts = input.segments.map((s) =>
    s.speaker ? `${OPEN_Q}${s.text}${CLOSE_Q}` : s.text,
  );
  const displayText = displayParts.join(" ");

  const dir = await mkdtemp(join(tmpdir(), "voiceover-"));
  try {
    // Synthesize each segment and validate its alignment before anything else.
    const perSegment: { file: string; durationMs: number; times: number[] }[] = [];
    for (const [i, seg] of input.segments.entries()) {
      const voiceId = seg.speaker ? cast.get(seg.speaker.name)!.id : narratorVoiceId;
      const tts = await synthesize(seg.text, { voiceId });
      const times = charTimesByStringIndex(seg.text, tts.chars, tts.charEndMs);
      if (!times) {
        throw new Error(
          `TTS alignment mismatch on segment ${i} (${seg.speaker?.name ?? "narrator"}): ` +
            `${tts.chars.length} chars for ${seg.text.length} units. Refusing to save.`,
        );
      }
      const file = join(dir, `seg-${i}.mp3`);
      await writeFile(file, tts.audio);
      perSegment.push({ file, durationMs: await ffprobeDurationMs(file), times });
    }

    // Global char-end times over the display text: each segment's times
    // shifted by its measured start offset; quote marks and joining spaces
    // inherit the running clock so the array stays monotonic.
    const globalTimes: number[] = [];
    let clockMs = 0;
    let cursorMs = 0;
    for (const [i, seg] of input.segments.entries()) {
      if (i > 0) {
        // The joining space before this segment, plus the stitched gap.
        clockMs = cursorMs + GAP_S * 1000;
        globalTimes.push(clockMs); // the " " between parts
      }
      const part = displayParts[i]!;
      const inner = perSegment[i]!;
      const quoted = Boolean(input.segments[i]!.speaker);
      for (let j = 0; j < part.length; j++) {
        const innerIdx = quoted ? j - 1 : j;
        if (innerIdx < 0 || innerIdx >= seg.text.length) {
          globalTimes.push(Math.max(clockMs, globalTimes.at(-1) ?? 0)); // quote mark
        } else {
          globalTimes.push(clockMs + inner.times[innerIdx]!);
        }
      }
      cursorMs = clockMs + inner.durationMs;
    }
    if (globalTimes.length !== displayText.length) {
      throw new Error(
        `Voiceover time map is ${globalTimes.length} entries for ${displayText.length} chars. Refusing to save.`,
      );
    }

    const combined = await stitch(dir, perSegment.map((s) => s.file));
    const durationMs = await (async () => {
      const f = join(dir, "combined-probe.mp3");
      await writeFile(f, combined);
      return ffprobeDurationMs(f);
    })();

    const doc = FiloDocument.fromText(displayText, { metadata: { locale: input.locale } });
    annotateWords(doc, { tierId: TIER.words, language: "en" });
    const sentences = annotateSentences(doc, { tierId: TIER.sentences, language: "en" });

    const key = `narration/${input.spotId}/${input.locale}-${input.variant}-${contentVersion(combined)}.mp3`;
    const audioUrl = await putAudio(key, combined, "audio/mpeg");
    alignAudioToSentences(doc, sentences, globalTimes, audioUrl, "audio/mpeg");

    const voices = [
      `narrator:${narratorVoiceId}`,
      ...[...cast.entries()].map(([name, v]) => `${name}:${v.name}`),
    ];
    const provenance: GenerationProvenance = {
      ttsProvider: "elevenlabs",
      voiceId: narratorVoiceId,
      sources: [],
      generatedAt: new Date().toISOString(),
      warnings: [],
      prompt: `multi-voice cast: ${voices.join(", ")}`,
    };

    return { document: doc.toJSON() as FiloDocumentJson, audioUrl, durationMs, provenance };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
