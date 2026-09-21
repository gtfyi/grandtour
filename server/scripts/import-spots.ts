/**
 * Import a slate of text-only spots (narration for the on-device voice) into
 * the database — track, spots, and content pieces in one pass.
 *
 *   bun run scripts/import-spots.ts [path] [--draft]
 *
 * Defaults to scripts/data/fairfax-to-berkeley.spots.json and publishes
 * everything (pass --draft to import for review instead). Idempotent:
 * re-running updates existing spots, matched by title within the track.
 *
 * The slate format is what the research pipeline emits: a `track`, and
 * `spots` each carrying a trigger, a `locating` block (mode + side-free
 * anchor), TTS-ready `narration` text, and `sources` URLs. Narration becomes
 * a filo document with word/sentence tiers but no audio — `/nearby` clients
 * speak it with the device voice until audio is generated in the admin UI.
 */
import { z } from "zod";
import { FiloDocument, annotateSentences, annotateWords } from "filo";
import {
  GeoTrigger,
  Locating,
  TIER,
  type FiloDocumentJson,
  type SpotInput,
} from "@grandtour/shared";
import { sql } from "../src/db";
import {
  createSpot,
  createTrack,
  listContentForSpot,
  listSpots,
  listTracks,
  updateSpot,
  upsertContent,
} from "../src/content/repo";

/** A narration segment: narrator prose, or a direct quote with a speaker
 * (voiced separately by generate-voiceovers.ts). */
const NarrationSegment = z.object({
  text: z.string().min(1),
  speaker: z
    .object({
      name: z.string().min(1),
      kind: z.enum(["man", "woman", "publication"]),
      year: z.string().nullish(),
    })
    .nullable()
    .default(null),
});

const SlateSpot = z.object({
  slug: z.string(),
  title: z.string().min(1),
  subtitle: z.string().default(""),
  trigger: GeoTrigger,
  /** Ordered-story membership; see Spot.sequence in @grandtour/shared. */
  sequence: z
    .object({ key: z.string().regex(/^[a-z0-9-]+$/), index: z.number().int().nonnegative() })
    .optional(),
  modes: z.array(z.string()).default([]),
  side: z.string().optional(), // authoring hint only; runtime uses courseDeg
  locating: Locating.pick({ mode: true, anchor: true }).partial({ anchor: true }),
  narration: z.union([z.string().min(1), z.array(NarrationSegment).min(1)]),
  sources: z.array(z.string().url()).default([]),
  /** Optional pre-existing narration. Used for licensed/public-domain imports;
   * this is not generated or copied by the importer. */
  audioUrl: z.string().url().optional(),
  durationMs: z.number().nonnegative().optional(),
});

/** Display text for a segmented narration: quotes in curly quotes, parts
 * joined by spaces — the same rendering src/ai/voiceover.ts produces. */
function narrationText(n: z.infer<typeof SlateSpot>["narration"]): string {
  if (typeof n === "string") return n;
  return n.map((s) => (s.speaker ? `\u201C${s.text}\u201D` : s.text)).join(" ");
}

const Slate = z.object({
  track: z.object({
    slug: z.string().regex(/^[a-z0-9-]+$/),
    name: z.string().min(1),
    description: z.string().default(""),
    kind: z.enum(["tour", "fillin"]).default("tour"),
    lifecycle: z.enum(["evergreen", "series"]).default("evergreen"),
    icon: z.string().optional(),
    color: z.string().optional(),
    official: z.boolean().default(false),
  }),
  spots: z.array(SlateSpot).min(1),
});

const args = process.argv.slice(2).filter((a) => a !== "--draft");
const status = process.argv.includes("--draft") ? ("draft" as const) : ("published" as const);
const path = args[0] ?? new URL("./data/fairfax-to-berkeley.spots.json", import.meta.url).pathname;

const parsed = Slate.safeParse(await Bun.file(path).json());
if (!parsed.success) {
  console.error("Slate file failed validation:", parsed.error.message);
  process.exit(1);
}
const slate = parsed.data;

// ── Track ────────────────────────────────────────────────────────────────────
const tracks = await listTracks(sql);
let track = tracks.find((t) => t.slug === slate.track.slug);
if (track) {
  console.log(`track "${track.slug}" exists (${track.id})`);
} else {
  track = await createTrack(sql, slate.track);
  console.log(`track "${track.slug}" created (${track.id})`);
}

// ── Spots + content ──────────────────────────────────────────────────────────
const existing = await listSpots(sql, { limit: 1000, trackId: track.id });
let created = 0;
let updated = 0;

for (const s of slate.spots) {
  const input: SpotInput = {
    trackId: track.id,
    title: s.title,
    subtitle: s.subtitle,
    trigger: s.trigger,
    ...(s.sequence ? { sequence: s.sequence } : {}),
    modes: s.modes as SpotInput["modes"],
    locating: { mode: s.locating.mode, anchor: s.locating.anchor, clips: {} },
    status,
  };

  const prior = existing.find((e) => e.title === s.title);
  const spot = prior ? await updateSpot(sql, prior.id, input) : await createSpot(sql, input);
  if (!spot) {
    console.error(`  ! failed to update "${s.title}"`);
    continue;
  }
  prior ? updated++ : created++;

  // Text-only narration document: same tiers the AI pipeline writes, minus
  // the audio alignment (added later if/when audio is generated).
  const doc = FiloDocument.fromText(narrationText(s.narration), { metadata: { locale: "en" } });
  annotateWords(doc, { tierId: TIER.words, language: "en" });
  annotateSentences(doc, { tierId: TIER.sentences, language: "en" });

  // upsertContent inserts by (spot, locale, variant) — safe to re-run.
  const priorContent = prior ? await listContentForSpot(sql, spot.id) : [];
  const priorDefault = priorContent.find((cp) => cp.variant === "default");
  const audioUrl = s.audioUrl ?? priorDefault?.audioUrl ?? null;
  await upsertContent(sql, {
    spotId: spot.id,
    locale: "en",
    variant: "default",
    document: doc.toJSON() as FiloDocumentJson,
    // Keep any audio a later generation attached; text import must not orphan it.
    audioUrl,
    durationMs: audioUrl ? s.durationMs ?? priorDefault?.durationMs ?? null : null,
    source: "imported",
    provenance: {
      sources: s.sources.map((url) => ({ title: new URL(url).hostname, url })),
      generatedAt: new Date().toISOString(),
      warnings: [],
    },
    status,
  });
  console.log(`  ${prior ? "updated" : "created"} "${s.title}" (${spot.slug}, ${status})`);
}

console.log(`done: ${created} created, ${updated} updated, status=${status}`);
await sql.end();
