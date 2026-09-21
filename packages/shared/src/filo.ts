import { z } from "zod";

/**
 * Zod mirrors of the filo serialization shapes (filo's FiloDocumentJson etc).
 *
 * filo is the alignment substrate: a document owns immutable text indexed by
 * UTF-8 byte offset, with named tiers of annotations (byte range + payload).
 * GrandTour stores narration as a filo document so that text and audio share
 * one coordinate system — every audio segment is a byte range into the text.
 *
 * We validate the wire shape here (loose on payloads) and hand the JSON to
 * `FiloDocument.fromJSON` for the real, strict reconstruction.
 */

export const ByteRange = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
});

export const FiloAnnotationJson = ByteRange.extend({
  id: z.string(),
  tierId: z.string(),
  kind: z.string(),
  payload: z.record(z.string(), z.unknown()),
  confidence: z.number().optional(),
  source: z.string().optional(),
  sourceInfo: z.record(z.string(), z.unknown()).optional(),
});

export const FiloTierJson = z.object({
  id: z.string(),
  kind: z.string(),
  description: z.string().optional(),
  source: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  annotations: z.array(FiloAnnotationJson),
});

export const FiloDocumentJson = z.object({
  id: z.string(),
  text: z.string(),
  byteLength: z.number().int().nonnegative(),
  metadata: z.record(z.string(), z.unknown()),
  tiers: z.array(FiloTierJson),
});
export type FiloDocumentJson = z.infer<typeof FiloDocumentJson>;

/**
 * The payload shape we put on the `audio` tier. One annotation per spoken
 * segment (typically a sentence), giving the player exact start/end times to
 * line up with the highlighted text byte range.
 */
export const AudioSegmentPayload = z.object({
  url: z.string().url().optional(), // omitted when the whole piece shares one audio file
  mimeType: z.string().optional(),
  startMs: z.number().nonnegative(),
  endMs: z.number().nonnegative(),
  source: z.string().optional(),
});
export type AudioSegmentPayload = z.infer<typeof AudioSegmentPayload>;

/** Conventional tier ids GrandTour relies on. */
export const TIER = {
  words: "words",
  sentences: "sentences",
  audio: "audio",
} as const;
