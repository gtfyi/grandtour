import { z } from "zod";
import { GeoTrigger } from "./geo";
import { FiloDocumentJson } from "./filo";

/**
 * GrandTour content model.
 *
 *   Track  ──<  Spot  ──<  ContentPiece
 *
 * - A **Track** is a thematic channel the user opts into (History, Nature…).
 * - A **Spot** is a place with a geo trigger, belonging to one track.
 * - A **ContentPiece** is one narration (text + aligned audio) at a spot,
 *   in a given locale/voice. A spot can have several (e.g. EN and ES, or a
 *   short "drive-by" vs a long "stop and look" cut, selectable by mode).
 */

// ─── Activity modes (PRD) ───────────────────────────────────────────────────

export const ActivityMode = z.enum([
  "walking",
  "driving",
  "cycling",
  "hiking",
  "museum",
  "transit",
  "boating",
  "aviation",
]);
export type ActivityMode = z.infer<typeof ActivityMode>;

// ─── Directional narration ──────────────────────────────────────────────────

/**
 * Locating instructions — the "where to look" part of a spot, kept separate
 * from the narration so it can be regenerated cheaply and resolved per
 * traveler. Templates may contain the literal token `{{side}}`, replaced by
 * left/right from the traveler's direction of travel; TTS renders one tiny
 * clip per side (or a single fixed clip), never the whole narration.
 */
export const SIDE_TOKEN = "{{side}}";
export const SIDES = ["left", "right"] as const;
export type Side = (typeof SIDES)[number];

export const DEFAULT_LOCATING_TEMPLATE = "Look to your {{side}}.";

export const LocatingClip = z.object({
  text: z.string(),
  audioUrl: z.string().url(),
  durationMs: z.number().nonnegative(),
});
export type LocatingClip = z.infer<typeof LocatingClip>;

export const Locating = z.object({
  /** auto = default template; custom = author template; none = skip. */
  mode: z.enum(["auto", "custom", "none"]).default("auto"),
  /**
   * Authored anchor appended to the deterministic locator sentence
   * (see locate.ts): an address, corner, or visual description — e.g.
   * "at the corner of Bolinas and Broadway" or "a large black building".
   */
  anchor: z.string().max(200).optional(),
  /** Custom template; {{side}} becomes left/right from the traveler's course. */
  template: z.string().optional(),
  /** TTS clips rendered from the template: left/right when directional, fixed otherwise. */
  clips: z
    .object({
      left: LocatingClip.optional(),
      right: LocatingClip.optional(),
      fixed: LocatingClip.optional(),
    })
    .default({}),
});
export type Locating = z.infer<typeof Locating>;

/** The template a spot's locating mode currently implies; null = disabled. */
export function locatingTemplate(l: Locating): string | null {
  if (l.mode === "none") return null;
  if (l.mode === "custom") return l.template?.trim() || null;
  return DEFAULT_LOCATING_TEMPLATE;
}

// ─── Tracks ─────────────────────────────────────────────────────────────────

/**
 * What a track contains and how it plays:
 * - `tour`   — Spots with geo triggers; narration about places (the default).
 * - `fillin` — FillInItems with no geometry at all; content the app inserts
 *   into narration gaps (see plans/014-fillin-content.md). Never appears in
 *   /nearby or /route-nearby.
 */
export const TrackKind = z.enum(["tour", "fillin"]);
export type TrackKind = z.infer<typeof TrackKind>;

/**
 * How a track wears with listening:
 * - `evergreen` — replayable forever (the default, the original behavior):
 *   played spots come back after a cooldown, ranked behind fresher ones, and
 *   the track may keep growing new content.
 * - `series` — the podcast model: each unit is meant to be heard once. Played
 *   units never auto-replay (manual taps always work), and when every unit
 *   has been heard the app auto-disables the track — re-enableable, with a
 *   "start over" that clears its play history.
 */
export const TrackLifecycle = z.enum(["evergreen", "series"]);
export type TrackLifecycle = z.infer<typeof TrackLifecycle>;

/**
 * Release gating, orthogonal to editorial status. `private` withholds a track
 * from every public surface while leaving its spots and content exactly as
 * they are, so holding a finished track back never means unpublishing it —
 * and releasing it later is one flip, not a reconstruction.
 */
export const TrackVisibility = z.enum(["public", "private"]);
export type TrackVisibility = z.infer<typeof TrackVisibility>;

export const Track = z.object({
  id: z.string().uuid(),
  slug: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  description: z.string().default(""),
  kind: TrackKind.default("tour"),
  lifecycle: TrackLifecycle.default("evergreen"),
  /** SF Symbol / icon name for the iOS toggle list. */
  icon: z.string().optional(),
  /** Hex color for map pins and UI accents. */
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  /** Curated/official vs community/AI tracks can be ranked differently. */
  official: z.boolean().default(false),
  /** `private` tracks are invisible to the public API; admin still sees them. */
  visibility: TrackVisibility.default("public"),
  /** Why the track is held, and since when. Set together, only when private. */
  holdReason: z.string().nullable().default(null),
  heldAt: z.string().datetime().nullable().default(null),
  /** Catalog totals: published content publicly, all statuses in the admin. */
  spotCount: z.number().int().nonnegative().optional(),
  itemCount: z.number().int().nonnegative().optional(),
  createdAt: z.string().datetime(),
});
export type Track = z.infer<typeof Track>;

/** Older servers and cached bundles may not include counts yet. */
export function trackCountLabel(track: Track): string {
  const count = track.kind === "fillin" ? track.itemCount : track.spotCount;
  const unit = track.kind === "fillin" ? "item" : "spot";
  return count === undefined ? `${unit[0]!.toUpperCase()}${unit.slice(1)} count unavailable` : `${count.toLocaleString("en-US")} ${unit}${count === 1 ? "" : "s"}`;
}

export const TrackInput = Track.pick({
  slug: true,
  name: true,
  description: true,
  kind: true,
  lifecycle: true,
  icon: true,
  color: true,
  official: true,
}).partial({
  description: true,
  kind: true,
  lifecycle: true,
  icon: true,
  color: true,
  official: true,
});
export type TrackInput = z.infer<typeof TrackInput>;

// ─── Guides (human-guide-first philosophy) ──────────────────────────────────

export const Guide = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  bio: z.string().default(""),
  avatarUrl: z.string().url().optional(),
  /** Where to send a booking / contact lead. */
  bookingUrl: z.string().url().optional(),
  contactEmail: z.string().email().optional(),
  createdAt: z.string().datetime(),
});
export type Guide = z.infer<typeof Guide>;

// ─── Spots ──────────────────────────────────────────────────────────────────

export const ContentSource = z.enum(["human", "ai", "imported"]);
export type ContentSource = z.infer<typeof ContentSource>;

export const PublishStatus = z.enum(["draft", "review", "published", "archived"]);
export type PublishStatus = z.infer<typeof PublishStatus>;

export const Spot = z.object({
  id: z.string().uuid(),
  trackId: z.string().uuid(),
  /** URL slug, unique within the track; stable once created. */
  slug: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string().min(1),
  /** Short subtitle shown on the pin / now-playing card. */
  subtitle: z.string().default(""),
  trigger: GeoTrigger,
  /**
   * Ordered-story membership: parts sharing a `key` (unique within the
   * track) auto-play strictly in `index` order — a part is eligible only
   * once every lower-index part has been heard. Works for point spots along
   * a route and for area collections told chapter by chapter.
   */
  sequence: z
    .object({
      key: z.string().regex(/^[a-z0-9-]+$/),
      index: z.number().int().nonnegative(),
    })
    .optional(),
  /** Which activity modes this spot is relevant to; empty = all. */
  modes: z.array(ActivityMode).default([]),
  /** Optional human guide this spot promotes (booking lead). */
  guideId: z.string().uuid().optional(),
  /** Where-to-look instructions, resolved per traveler by /nearby. */
  locating: Locating.default({ mode: "auto", clips: {} }),
  status: PublishStatus.default("draft"),
  createdBy: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Spot = z.infer<typeof Spot>;

export const SpotInput = Spot.pick({
  trackId: true,
  title: true,
  subtitle: true,
  trigger: true,
  sequence: true,
  modes: true,
  guideId: true,
  locating: true,
  status: true,
}).partial({
  subtitle: true,
  sequence: true,
  modes: true,
  guideId: true,
  locating: true,
  status: true,
});
export type SpotInput = z.infer<typeof SpotInput>;

// ─── Content pieces (text + aligned audio) ──────────────────────────────────

/**
 * A work this content came from, or one it drew on — enough to credit it and
 * to answer "may we reuse this?" without leaving the record.
 *
 * Entries written before this shape existed were `{ title, url }`. `title` is
 * still accepted and read as `name`, so those rows stay valid unmigrated.
 */
const SourceRefFields = z.object({
  /** Display name: "National Park Service", "Point Reyes Light", "en.wikipedia.org". */
  name: z.string().min(1),
  url: z.string().url().optional(),
  /** One line on what this source is, for a reviewer scanning a list. */
  description: z.string().optional(),
  /** Rights holder when it differs from `name` — NPS tours are often contractor-produced. */
  publisher: z.string().optional(),
  /** Licence label: "public-domain", "CC-BY-4.0", "OGL-3.0", "all-rights-reserved". */
  license: z.string().optional(),
  /** Credit line to reproduce verbatim, when the licence requires one. */
  attribution: z.string().optional(),
  /** When the source was published or recorded; free-form ("1998", "2024-06-01"). */
  date: z.string().optional(),
  /** When we fetched it. */
  retrievedAt: z.string().datetime().optional(),
  /**
   * Whether someone checked that we may reuse this. `license` records a
   * claim; this records that the claim was verified, by whom, and when. The
   * open-audio research archive is emphatic that a `.gov` domain does not
   * imply public domain, so "nobody has checked yet" has to be sayable — and
   * distinguishable from "checked, and it is clear".
   *
   * It is a list because rights can differ **per asset**. A National Park
   * Service tour can be federal work product in its script (17 U.S.C. §105,
   * clear) while the audio file blends in a named third party's field
   * recordings (not clear). One licence string cannot say that; two scoped
   * entries can:
   *
   * ```
   * clearance: [
   *   { scope: "text",  status: "confirmed",   license: "public-domain",
   *     note: "Federal work product, 17 U.S.C. §105" },
   *   { scope: "audio", status: "not-cleared",
   *     note: "Blends nature recordings by a named third party" },
   * ]
   * ```
   *
   * Absent any entry, nothing has been checked — treat as `unclear`.
   */
  clearance: z
    .array(
      z.object({
        /** Which asset this verdict covers. */
        scope: z.enum(["all", "text", "audio"]).default("all"),
        /**
         * `confirmed` verified from the source's own terms; `probable`
         * inferred from context; `unclear` looked at and unresolved;
         * `not-cleared` checked and we may not reuse it.
         */
        status: z.enum(["confirmed", "probable", "unclear", "not-cleared"]),
        /** Licence for this asset specifically, when it differs from the work's. */
        license: z.string().optional(),
        reviewedBy: z.string().optional(),
        reviewedAt: z.string().datetime().optional(),
        note: z.string().optional(),
      }),
    )
    .optional(),
});

/** Entries written before this shape existed: `{ title, url }`, read as `name`. */
const LegacySourceRef = z
  .object({ title: z.string().min(1), url: z.string().url().optional() })
  .transform(({ title, url }) => (url ? { name: title, url } : { name: title }))
  .pipe(SourceRefFields);

export const SourceRef = z.union([SourceRefFields, LegacySourceRef]);
export type SourceRef = z.infer<typeof SourceRef>;

/** Provenance for AI-generated narration, for review and attribution. */
export const GenerationProvenance = z.object({
  model: z.string().optional(),
  ttsProvider: z.string().optional(),
  voiceId: z.string().optional(),
  /** Works the script was drawn from (exa.ai results, Wikipedia, archives). */
  sources: z.array(SourceRef).default([]),
  /**
   * The work this content *is*, when it was imported rather than written here:
   * the NPS tour, the newspaper column. Distinct from `sources`, which lists
   * what a script consulted. This is the one that carries the licence we
   * publish under.
   */
  origin: SourceRef.optional(),
  prompt: z.string().optional(),
  generatedAt: z.string().datetime().optional(),
  /** Non-fatal problems during generation (e.g. a source channel failed). */
  warnings: z.array(z.string()).default([]),
  /**
   * Field-capture context for walk-and-record narration (source "human"):
   * the GPS fix the creator recorded from. Display/audit only — trigger geo
   * lives on the spot.
   */
  capture: z
    .object({
      recordedAt: z.string().datetime().optional(),
      courseDeg: z.number().min(0).max(360).optional(),
      speedMps: z.number().nonnegative().optional(),
      altitudeM: z.number().optional(),
      horizontalAccuracyM: z.number().nonnegative().optional(),
    })
    .optional(),
});
export type GenerationProvenance = z.infer<typeof GenerationProvenance>;

export const ContentPiece = z.object({
  id: z.string().uuid(),
  spotId: z.string().uuid(),
  locale: z.string().default("en"),
  /** Human label for selecting between variants ("Quick drive-by", "Deep dive"). */
  variant: z.string().default("default"),
  /**
   * The narration as a filo document: base text + tiers. The `audio` tier
   * carries per-segment timing aligned to text byte ranges. May be null while
   * only audio (no transcript) exists, or only text (no audio yet) exists.
   */
  document: FiloDocumentJson.nullable(),
  /** Canonical audio file for the whole piece (segments index into it). */
  audioUrl: z.string().url().nullable(),
  durationMs: z.number().nonnegative().nullable(),
  source: ContentSource,
  provenance: GenerationProvenance.nullable(),
  status: PublishStatus.default("draft"),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ContentPiece = z.infer<typeof ContentPiece>;

// ─── Fill-in items (non-location-anchored filler content) ───────────────────

/**
 * A fill-in track's unit of content. It has NO geometry — the iOS app plays
 * one when the tour planner sees a gap in narration (no spot triggered for a
 * while), not when the traveler is anywhere in particular.
 */
export const FillInModuleType = z.enum(["vocab", "quiz"]); // later: quotes, …
export type FillInModuleType = z.infer<typeof FillInModuleType>;

/** Structured data for a `vocab` fill-in item. */
/** One meaning of a vocab word. A word worth knowing often has several. */
export const VocabSense = z.object({
  partOfSpeech: z.string().optional(), // "noun", "adjective", …
  definition: z.string().min(1),
  /** Optional: secondary senses from a dictionary may lack a usable one. */
  exampleSentence: z.string().min(1).optional(),
});
export type VocabSense = z.infer<typeof VocabSense>;

export const VocabPayload = z.object({
  word: z.string().min(1),
  /** Phonetic respelling for the admin reviewer (not spoken by TTS). */
  pronunciation: z.string().optional(),
  /** Curated sense first; the script narrates all of them in order. */
  senses: z.array(VocabSense).min(1),
  /** Where the word/definitions came from (flashcard list, dictionary). */
  source: SourceRef,
});
export type VocabPayload = z.infer<typeof VocabPayload>;

/**
 * Structured data for a `quiz` fill-in item: a question, a recall pause, then
 * the answers spoken in payload order (for ranked questions, order = rank).
 */
export const QuizPayload = z.object({
  /** Spoken as the intro beat ("Geography quiz."); also an admin filter aid. */
  category: z.string().min(1),
  question: z.string().min(1),
  /** Spoken in order after the pause; a ranked list keeps its ranking here. */
  answers: z.array(z.string().min(1)).min(1),
  /** Optional extra fact spoken after the answers ("Bolivia lost its coast…"). */
  note: z.string().optional(),
  /** Where the underlying facts came from (e.g. Wikidata query). */
  source: SourceRef,
});
export type QuizPayload = z.infer<typeof QuizPayload>;

/**
 * Module payloads. Not a zod discriminated union because the discriminant
 * (`moduleType`) lives on the item, not in the payload — routes check the
 * pairing with `payloadSchemaFor(moduleType)`. The shapes are disjoint
 * (word/senses vs question/answers), so the union itself is unambiguous.
 */
export const FillInPayload = z.union([VocabPayload, QuizPayload]);
export type FillInPayload = z.infer<typeof FillInPayload>;

export function payloadSchemaFor(moduleType: FillInModuleType) {
  return moduleType === "vocab" ? VocabPayload : QuizPayload;
}

export function isVocabPayload(p: FillInPayload): p is VocabPayload {
  return "word" in p;
}

export function isQuizPayload(p: FillInPayload): p is QuizPayload {
  return "question" in p;
}

/** What an item is about, module-agnostic — list rows, now-playing, logs. */
export function fillInItemTitle(p: FillInPayload): string {
  return isVocabPayload(p) ? p.word : p.question;
}

export const FillInItem = z.object({
  id: z.string().uuid(),
  trackId: z.string().uuid(),
  moduleType: FillInModuleType,
  /** Module-specific data; must match `moduleType` (`payloadSchemaFor`). */
  payload: FillInPayload,
  /** Authoring/review order. Null = unordered; playback shuffles regardless. */
  order: z.number().int().nonnegative().nullable(),
  /**
   * The item's narration, reusing ContentPiece wholesale so every existing
   * consumer (players, transcript views) works unchanged. The think-time
   * pause is baked into the audio at TTS time; `document` carries the clean
   * display text. `spotId` here is the fill-in item's own id — there is no
   * spot. Null until audio/text has been generated.
   */
  content: ContentPiece.nullable(),
  status: PublishStatus.default("draft"),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type FillInItem = z.infer<typeof FillInItem>;

export const FillInItemInput = FillInItem.pick({
  trackId: true,
  moduleType: true,
  payload: true,
  order: true,
  status: true,
}).partial({ order: true, status: true });
export type FillInItemInput = z.infer<typeof FillInItemInput>;

export const ContentPieceInput = ContentPiece.pick({
  spotId: true,
  locale: true,
  variant: true,
  document: true,
  audioUrl: true,
  durationMs: true,
  source: true,
  provenance: true,
  status: true,
}).partial({
  locale: true,
  variant: true,
  document: true,
  audioUrl: true,
  durationMs: true,
  provenance: true,
  status: true,
});
export type ContentPieceInput = z.infer<typeof ContentPieceInput>;
