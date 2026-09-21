import { z } from "zod";
import { Latitude, Longitude } from "./geo";
import { ContentPiece, Spot, Track, TrackLifecycle } from "./content";

/**
 * Creator API DTOs — the phone's walk-and-record mode (PRD "Walk and
 * Record"): press record, narrate where you stand, and the spot goes onto a
 * track you own, published immediately so the same phone can play it back.
 *
 * These endpoints live under /api/creator and are UNAUTHENTICATED for now:
 * the server is assumed private (a dev box on a tailnet). Revisit before any
 * public deployment.
 */

// ─── POST /creator/tracks ────────────────────────────────────────────────────

/** The phone sends a name; the server slugifies it (unique) and fills defaults. */
export const CreatorTrackInput = z.object({
  /** Stable phone-generated ID; retries return the original track. */
  clientId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).default(""),
  lifecycle: TrackLifecycle.default("evergreen"),
});
export type CreatorTrackInput = z.infer<typeof CreatorTrackInput>;

export const CreatorTrackResponse = z.object({ track: Track });
export type CreatorTrackResponse = z.infer<typeof CreatorTrackResponse>;

// ─── POST /creator/spots (multipart: meta JSON + audio file) ────────────────

/**
 * The `meta` field of the multipart body. The audio file rides alongside as
 * the `audio` part (AAC in an .m4a container from AVAudioRecorder).
 *
 * Everything after `lng` is capture context per the PRD ("The system
 * records: Audio, GPS, Heading, Speed, Time") — stored in the content
 * piece's provenance, not used for triggering.
 */
export const CreatorSpotMeta = z.object({
  /** Stable phone-generated ID; retries return the original spot. */
  clientId: z.string().uuid().optional(),
  trackId: z.string().uuid(),
  title: z.string().trim().min(1).max(200),
  subtitle: z.string().max(500).default(""),
  lat: Latitude,
  lng: Longitude,
  /**
   * Trigger radius, meters. Walking-scale default — recorded on foot, the
   * spot should fire about where the creator stood, not a block away.
   */
  radiusM: z.number().positive().max(1_000).default(40),
  /** Spoken length of the recording, from the recorder's clock. */
  durationMs: z.number().nonnegative().optional(),
  locale: z.string().min(1).max(35).default("en"),
  recordedAt: z.string().datetime().optional(),
  /** GPS course at record time, compass degrees (0 = north). */
  courseDeg: z.number().min(0).max(360).optional(),
  speedMps: z.number().nonnegative().optional(),
  altitudeM: z.number().optional(),
  horizontalAccuracyM: z.number().nonnegative().optional(),
});
export type CreatorSpotMeta = z.infer<typeof CreatorSpotMeta>;

export const CreatorSpotResponse = z.object({
  spot: Spot,
  content: ContentPiece,
});
export type CreatorSpotResponse = z.infer<typeof CreatorSpotResponse>;

/** Audio containers the recorder may send; anything else is rejected. */
export const CREATOR_AUDIO_TYPES: Record<string, string> = {
  "audio/mp4": ".m4a",
  "audio/x-m4a": ".m4a",
  "audio/m4a": ".m4a",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
};

/** Recordings are capped well above any plausible narration. */
export const CREATOR_AUDIO_MAX_BYTES = 100 * 1024 * 1024;
