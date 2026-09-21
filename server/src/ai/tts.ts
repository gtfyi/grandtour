import { env } from "../env";

export interface TtsResult {
  /** Raw audio bytes (mp3). */
  audio: Uint8Array;
  mimeType: string;
  /** Total duration in ms (derived from the last character end time). */
  durationMs: number;
  /**
   * Per-character end timestamps as reported by the TTS provider. Entry i is
   * the time (ms) at which chars[i] finishes. Used with `chars` to build a
   * validated text-index → time mapping (see charTimesByStringIndex).
   */
  charEndMs: number[];
  /** The provider's own per-character segmentation of the input text. */
  chars: string[];
  text: string;
}

/**
 * Synthesize narration with ElevenLabs, requesting character-level timing so
 * the result can be aligned to filo byte ranges.
 *
 * Uses the `with-timestamps` endpoint which returns base64 audio plus a
 * normalized character alignment.
 * https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps
 */
export async function synthesize(
  text: string,
  opts: { voiceId?: string; modelId?: string } = {},
): Promise<TtsResult> {
  const key = env.requireElevenLabsKey();
  const voiceId = opts.voiceId || env.elevenLabsVoiceId();
  const modelId = opts.modelId || "eleven_multilingual_v2";

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/with-timestamps`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "xi-api-key": key,
      },
      body: JSON.stringify({
        text,
        model_id: modelId,
        output_format: "mp3_44100_128",
      }),
    },
  );
  if (!res.ok) {
    throw new Error(`ElevenLabs TTS failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as {
    audio_base64: string;
    alignment?: {
      characters: string[];
      character_start_times_seconds: number[];
      character_end_times_seconds: number[];
    };
  };

  const audio = Uint8Array.from(Buffer.from(data.audio_base64, "base64"));
  const endSecs = data.alignment?.character_end_times_seconds ?? [];
  const charEndMs = endSecs.map((s) => Math.round(s * 1000));
  const chars = data.alignment?.characters ?? [];
  const durationMs = charEndMs.length ? charEndMs[charEndMs.length - 1]! : 0;

  return { audio, mimeType: "audio/mpeg", durationMs, charEndMs, chars, text };
}
