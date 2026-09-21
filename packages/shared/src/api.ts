import { z } from "zod";
import {
  ActivityMode,
  ContentPiece,
  FillInItem,
  Guide,
  Track,
  TrackLifecycle,
  Spot,
  VocabPayload,
  SourceRef,
  TrackVisibility,
} from "./content";
import { LngLat } from "./geo";

/**
 * Public API DTOs. The `/nearby` query is the hot path of the whole product —
 * the iOS app calls it continuously as the user moves.
 */

// ─── GET /nearby ─────────────────────────────────────────────────────────────

export const NearbyQuery = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  /** Search radius cap in meters; the server still honors each spot's own trigger. */
  radiusM: z.coerce.number().positive().max(50_000).default(2_000),
  /** Restrict to these track slugs (the user's enabled tracks). Empty = all. */
  tracks: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(",").filter(Boolean) : []))
    .pipe(z.array(z.string())),
  /** Current activity mode, to pick the right variant and filter spots. */
  mode: ActivityMode.optional(),
  /** Preferred content locale; server falls back to any published piece. */
  locale: z.string().min(1).max(35).default("en"),
  /**
   * Per-track locale overrides, serialized as `slug:locale` pairs joined by
   * commas (e.g. `nrw-forest-trails:cy,history:es`). A track not listed here
   * uses `locale`. Lets a traveler hear one track in Welsh while everything
   * else stays in their default language.
   */
  trackLocales: z
    .string()
    .optional()
    .transform((s) => {
      if (!s) return {};
      const out: Record<string, string> = {};
      for (const pair of s.split(",")) {
        const [slug, loc] = pair.split(":");
        if (slug && loc) out[slug] = loc;
      }
      return out;
    })
    .pipe(z.record(z.string(), z.string())),
  /**
   * Direction of travel in compass degrees (0 = north, 90 = east), from GPS
   * course. Used to pick left/right directional narration variants.
   */
  courseDeg: z.coerce.number().min(0).max(360).optional(),
  /**
   * Freshness check for background polling. When set to the `dataVersion` of
   * a previous response for the SAME query point and filters, the server
   * replies `{ spots: [], dataVersion, unchanged: true }` if nothing in range
   * has been published or edited since — so a stationary device polling every
   * few seconds costs one cheap query and an empty body.
   */
  changedSince: z.string().datetime().optional(),
  /** Max results. Use the supported cap for clients that omit the limit;
   * regional listening tracks can contain more than fifty co-located stories. */
  limit: z.coerce.number().int().positive().max(200).default(200),
});
export type NearbyQuery = z.infer<typeof NearbyQuery>;

/** Locating instruction resolved for THIS traveler (side already chosen). */
export const LocatingResolved = z.object({
  text: z.string(),
  audioUrl: z.string().url().nullable(),
  durationMs: z.number().nonnegative().nullable(),
});
export type LocatingResolved = z.infer<typeof LocatingResolved>;

/** A spot returned by /nearby, enriched with distance and the chosen content. */
export const NearbySpot = z.object({
  spot: Spot,
  track: Track,
  /**
   * Where-to-look instruction for this traveler, or null (locating disabled,
   * or direction needed but the traveler's course is unknown). Played/shown
   * before the narration.
   */
  locating: LocatingResolved.nullable(),
  /** Meters from the query point to the spot center. */
  distanceM: z.number().nonnegative(),
  /** True if the user is *inside* the trigger right now (should start playing). */
  triggered: z.boolean(),
  /** The best content piece for this user's locale/mode, if any. */
  content: ContentPiece.nullable(),
  /** Promoted human guide, if the spot has one. */
  guide: Guide.nullable(),
});
export type NearbySpot = z.infer<typeof NearbySpot>;

// ─── POST /route-nearby (journey prefetch) ──────────────────────────────────

/**
 * A planned journey: an ordered polyline of route points. The server returns
 * every published spot within `corridorM` of the line so the app can cache
 * spots and audio before setting out — the tour then works with no signal.
 */
export const RouteNearbyBody = z.object({
  /** Route polyline, ordered. Decimate client-side; 500 points caps a query. */
  points: z
    .array(z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }))
    .min(2)
    .max(500),
  /** Corridor half-width in meters around the route line. */
  corridorM: z.number().positive().max(2_000).default(300),
  tracks: z.array(z.string()).default([]),
  mode: ActivityMode.optional(),
  locale: z.string().min(1).max(35).default("en"),
  /** Per-track locale overrides, keyed by track slug. See NearbyQuery.trackLocales. */
  trackLocales: z.record(z.string(), z.string()).default({}),
  limit: z.number().int().positive().max(500).default(200),
});
export type RouteNearbyBody = z.infer<typeof RouteNearbyBody>;

export const NearbyResponse = z.object({
  spots: z.array(NearbySpot),
  /**
   * Newest `updatedAt` across the spots and content in range (null when the
   * area is empty). Echo it back as `changedSince` on the next poll.
   */
  dataVersion: z.string().datetime().nullable().default(null),
  /**
   * True when `changedSince` was supplied and nothing changed — `spots` is
   * empty because there is nothing new, NOT because the area is empty. The
   * client must keep showing what it already has.
   */
  unchanged: z.boolean().default(false),
});
export type NearbyResponse = z.infer<typeof NearbyResponse>;

// ─── GET /fillin-items (fill-in content for enabled fill-in tracks) ─────────

/**
 * A rotating sample of published fill-in items for the given track slugs.
 * No geo parameters. Complete offline downloads use /tracks/:id/bundle,
 * since large vocabulary tracks exceed this endpoint's sample limit.
 */
export const FillInItemsQuery = z.object({
  /** Fill-in track slugs to fetch. Required: there is no "all" fallback. */
  tracks: z
    .string()
    .transform((s) => s.split(",").filter(Boolean))
    .pipe(z.array(z.string()).min(1)),
  // Generous: a quiz track alone holds hundreds of items, and the client
  // fetches all enabled fill-in tracks in one call.
  limit: z.coerce.number().int().positive().max(2000).default(2000),
});
export type FillInItemsQuery = z.infer<typeof FillInItemsQuery>;

export const FillInItemsResponse = z.object({
  items: z.array(FillInItem),
});
export type FillInItemsResponse = z.infer<typeof FillInItemsResponse>;

// ─── GET /track-manifest (per-track unit index) ─────────────────────────────

/**
 * A lightweight index of each track's published, narratable units — spot ids
 * for tour tracks, item ids for fill-in tracks. Two client jobs need it, and
 * neither can be served by /nearby (which only sees what's in range):
 * sequence eligibility (is every earlier part of this story heard, even the
 * parts miles away?) and track completion (played ∩ manifest, computed
 * client-side because play history lives on the device).
 */
export const TrackManifestQuery = z.object({
  /** Track slugs to include; empty = all. */
  tracks: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(",").filter(Boolean) : []))
    .pipe(z.array(z.string())),
});
export type TrackManifestQuery = z.infer<typeof TrackManifestQuery>;

export const TrackManifestUnit = z.object({
  id: z.string().uuid(),
  sequenceKey: z.string().nullable().default(null),
  sequenceIndex: z.number().int().nullable().default(null),
});
export type TrackManifestUnit = z.infer<typeof TrackManifestUnit>;

export const TrackManifest = z.object({
  trackId: z.string().uuid(),
  slug: z.string(),
  lifecycle: TrackLifecycle,
  /**
   * Newest change across the track's published units and content. A stored
   * completion older than this (or a smaller unit count) means new content
   * arrived since the user finished the track.
   */
  contentUpdatedAt: z.string().datetime().nullable(),
  units: z.array(TrackManifestUnit),
});
export type TrackManifest = z.infer<typeof TrackManifest>;

export const TrackManifestResponse = z.object({
  tracks: z.array(TrackManifest),
});
export type TrackManifestResponse = z.infer<typeof TrackManifestResponse>;

// ─── POST /admin/fillin-items/import (bulk vocab import) ────────────────────

/** One pasted word row: flat single-sense; enrichment adds senses later. */
export const VocabImportWord = z.object({
  word: z.string().min(1),
  pronunciation: z.string().optional(),
  partOfSpeech: z.string().optional(),
  definition: z.string().min(1),
  exampleSentence: z.string().min(1),
});
export type VocabImportWord = z.infer<typeof VocabImportWord>;

// ─── PATCH /admin/tracks/:id/visibility ─────────────────────────────────────

/**
 * Hold a finished track back from the public API, or release it. A hold must
 * carry a reason; releasing clears it. Nothing inside the track is touched.
 */
export const TrackVisibilityInput = z
  .object({
    visibility: TrackVisibility,
    holdReason: z.string().min(1).max(500).optional(),
  })
  .refine((v) => v.visibility !== "private" || !!v.holdReason, {
    message: "holdReason is required when holding a track",
    path: ["holdReason"],
  });
export type TrackVisibilityInput = z.infer<typeof TrackVisibilityInput>;

/** One vocab list pasted/imported at once; `source` is stamped on every word. */
export const VocabImportRequest = z.object({
  trackId: z.string().uuid(),
  source: SourceRef,
  words: z.array(VocabImportWord).min(1).max(1000),
});
export type VocabImportRequest = z.infer<typeof VocabImportRequest>;

// ─── POST /admin/fillin-items/:id/generate (vocab TTS) ──────────────────────

export const FillInGenerateRequest = z.object({
  /** ElevenLabs voice id; falls back to the server default. */
  voiceId: z.string().optional(),
  /** Think-time pause baked into the audio, seconds (provider max is 3). */
  pauseSeconds: z.number().min(0.5).max(3).default(3),
});
export type FillInGenerateRequest = z.infer<typeof FillInGenerateRequest>;

// ─── POST /admin/spots/:id/generate (AI narration) ──────────────────────────

export const GenerateRequest = z.object({
  /** Free-form steer for the narration (tone, focus, length). */
  brief: z.string().optional(),
  locale: z.string().default("en"),
  variant: z.string().default("default"),
  /** ElevenLabs voice id; falls back to a server default. */
  voiceId: z.string().optional(),
  /** Target spoken length, seconds. Guides script length. */
  targetSeconds: z.number().positive().max(900).default(90),
  /** Use exa.ai web/local search to gather sources around the spot. */
  useSearch: z.boolean().default(true),
  /** Pull the matching Wikipedia article(s) for the location. */
  useWikipedia: z.boolean().default(true),
  /** If false, only draft the script + sources without synthesizing audio. */
  synthesizeAudio: z.boolean().default(true),
});
export type GenerateRequest = z.infer<typeof GenerateRequest>;

export const GenerateResponse = z.object({
  content: ContentPiece,
});
export type GenerateResponse = z.infer<typeof GenerateResponse>;

// ─── GET /admin/identify (name the entity at a coordinate) ──────────────────

export const IdentifyQuery = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
});
export type IdentifyQuery = z.infer<typeof IdentifyQuery>;

export const PlaceCandidate = z.object({
  title: z.string(),
  source: z.enum(["wikipedia", "geocodio"]),
  url: z.string().url().optional(),
  distanceM: z.number().nonnegative().optional(),
});
export type PlaceCandidate = z.infer<typeof PlaceCandidate>;

export const IdentifyResponse = z.object({
  /** Street-level address of the coordinate, if resolvable. */
  address: z.string().nullable(),
  /** Named entities near the coordinate, nearest first. */
  candidates: z.array(PlaceCandidate),
});
export type IdentifyResponse = z.infer<typeof IdentifyResponse>;

// ─── GET /admin/tracks/:id/export (static bundle for the offline viewer) ────

/**
 * A single track's published content, self-contained enough to drive the
 * static tour-viewer with no live API: every published spot plus every
 * published content piece for it, or every published fill-in item. Audio
 * stays URL-referenced (not inlined); offline clients must download every
 * referenced file before promising complete offline playback.
 */
export const TrackExport = z.object({
  /** Distribution format; absent in bundles written before it existed (= 1). */
  formatVersion: z.number().int().positive().optional(),
  exportedAt: z.string().datetime(),
  track: Track,
  /** Optional authored route geometry for tours where a live road router may
   * choose a seasonal detour or otherwise miss the intended journey. */
  routePath: z.array(LngLat).min(2).optional(),
  spots: z.array(
    z.object({
      spot: Spot,
      content: z.array(ContentPiece),
    }),
  ),
  /** Complete, unsampled fill-in inventory. Absent in older tour exports. */
  fillInItems: z.array(FillInItem).optional(),
});
export type TrackExport = z.infer<typeof TrackExport>;

// ─── Errors ──────────────────────────────────────────────────────────────────

export const ApiError = z.object({
  error: z.string(),
  detail: z.string().optional(),
});
export type ApiError = z.infer<typeof ApiError>;
