/**
 * Import researched NPS park-tour slates into real Track/Spot/ContentPiece
 * rows: uploads each stop's downloaded audio via putAudio, builds a filo
 * document from the tour's own verbatim transcript (no TTS, no rewriting),
 * and writes provenance.origin with a licence/clearance record instead of
 * inferring rights from content_pieces.source.
 *
 *   cd server && bun run scripts/import-park-tours.ts [--draft]
 *
 * Reads every *.slate.json in research/open-audio-tours/_import-staging/.
 * Each slate's audioUrl is a local file:// path (a placeholder written by
 * the research pass) — this script uploads that file and replaces it with
 * a real hosted URL before writing the content piece. Idempotent: re-running
 * updates existing spots (matched by title within the track) and re-uploads
 * audio (putAudio dedupes identical bytes to the same key).
 *
 * Per-tour licence/clearance is looked up from the tour's own
 * research/open-audio-tours/usa/national-parks/<slug>/manifest.json rather
 * than hand-copied here, so the DB record and the research record can't
 * drift apart silently.
 */
import { readdir } from "node:fs/promises";
import { z } from "zod";
import { FiloDocument, annotateSentences, annotateWords } from "filo";
import { GeoTrigger, Locating, TIER, type FiloDocumentJson, type SpotInput } from "@grandtour/shared";
import { sql } from "../src/db";
import {
  createSpot,
  createTrack,
  listContentForSpot,
  listSpots,
  listTracks,
  setTrackVisibility,
  updateSpot,
  upsertContent,
} from "../src/content/repo";
import { putAudio, contentVersion } from "../src/ai/storage";
import { verifyImportedAudio } from "../src/content/imported-audio";

const STAGING_DIR = new URL(
  "../../research/open-audio-tours/_import-staging/",
  import.meta.url,
);
const RESEARCH_DIR = new URL(
  "../../research/open-audio-tours/usa/national-parks/",
  import.meta.url,
);

const SlateSpot = z.object({
  slug: z.string(),
  title: z.string().min(1),
  subtitle: z.string().default(""),
  trigger: GeoTrigger,
  sequence: z
    .object({ key: z.string().regex(/^[a-z0-9-]+$/), index: z.number().int().nonnegative() })
    .optional(),
  modes: z.array(z.string()).default([]),
  locating: Locating.pick({ mode: true, anchor: true }).partial({ anchor: true }),
  narration: z.string().min(1),
  sources: z.array(z.string().url()).default([]),
  // Slates from the research pass hold a local file:// URI here; real hosted
  // audio comes back from putAudio during import.
  audioUrl: z.string().min(1),
  // Hash the recording attached to this stop on the source page, not a
  // position in a separately sorted list of download URLs.
  audioSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  durationMs: z.number().nonnegative().nullable().optional(),
});

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

const ManifestClearanceEntry = z.object({
  scope: z.enum(["all", "text", "audio"]).default("all"),
  status: z.enum(["confirmed", "probable", "unclear", "not-cleared"]),
  license: z.string().optional(),
  note: z.string().optional(),
});
const Manifest = z.object({
  tour_name: z.string(),
  publisher: z.string(),
  license: z.object({
    type: z.string(),
    source_url: z.string(),
    confidence: z.string(),
  }),
  clearance: z.array(ManifestClearanceEntry).optional(),
});

/** Map a local file:// audio path to its MIME type by extension. */
function mimeTypeFor(path: string): string {
  if (path.endsWith(".mp3")) return "audio/mpeg";
  if (path.endsWith(".m4a")) return "audio/mp4";
  if (path.endsWith(".wav")) return "audio/wav";
  throw new Error(`unrecognized audio extension: ${path}`);
}

async function readStopAudio(fileUrl: string, expectedSha256?: string) {
  const localPath = fileUrl.startsWith("file://") ? fileUrl.slice("file://".length) : fileUrl;
  const file = Bun.file(localPath);
  if (!(await file.exists())) throw new Error(`audio file not found: ${localPath}`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  verifyImportedAudio(bytes, expectedSha256);
  const mimeType = mimeTypeFor(localPath);
  const ext = localPath.slice(localPath.lastIndexOf("."));
  return { bytes, mimeType, ext };
}

/** Upload the exact bytes checked during preflight, without re-reading the file. */
async function uploadStopAudio(trackSlug: string, spotSlug: string, audio: Awaited<ReturnType<typeof readStopAudio>>): Promise<string> {
  const { bytes, mimeType, ext } = audio;
  const key = `imported/${trackSlug}/${spotSlug}-${contentVersion(bytes)}${ext}`;
  return putAudio(key, bytes, mimeType);
}

/** Per-track hold reason for tours whose audio isn't cleared for redistribution. */
const HOLD_REASONS: Record<string, string> = {
  "everglades-by-car":
    "Audio blends confirmed-PD NPS ranger narration (Larry Perez) with nature " +
    "recordings credited to third-party recordist Lang Elliott. No public " +
    "documentation of NPS's licence terms from Elliott was found (no contract, " +
    "procurement record, or blanket free-use policy on his own site, which runs " +
    "a standard case-by-case paid licensing business). Narration text is public " +
    "domain; audio redistribution is not established as authorized. Held pending " +
    "confirmation from NPS Everglades or Lang Elliott/Music of Nature directly. " +
    "See research/open-audio-tours/usa/national-parks/everglades-by-car/license.md.",
};

const draftMode = process.argv.includes("--draft");
const status = draftMode ? ("draft" as const) : ("published" as const);

const files = (await readdir(STAGING_DIR)).filter((f) => f.endsWith(".slate.json"));
if (files.length === 0) {
  console.error(`no *.slate.json files found in ${STAGING_DIR}`);
  process.exit(1);
}
console.log(`found ${files.length} slate(s): ${files.join(", ")}`);

let totalCreated = 0;
let totalUpdated = 0;

for (const file of files) {
  const slatePath = new URL(file, STAGING_DIR);
  const parsed = Slate.safeParse(await Bun.file(slatePath).json());
  if (!parsed.success) {
    console.error(`! ${file} failed validation:`, parsed.error.message);
    continue;
  }
  const slate = parsed.data;
  console.log(`\n=== ${slate.track.slug} (${slate.spots.length} stops) ===`);

  // Validate the entire slate before modifying any track, spot, or content.
  const audioByStop = new Map(await Promise.all(slate.spots.map(async (s) =>
    [s, await readStopAudio(s.audioUrl, s.audioSha256)] as const,
  )));

  // Look up this tour's own research manifest for licence/clearance —
  // written once by the research pass, read here rather than re-typed.
  const manifestPath = new URL(`${slate.track.slug}/manifest.json`, RESEARCH_DIR);
  let manifest: z.infer<typeof Manifest> | null = null;
  if (await Bun.file(manifestPath).exists()) {
    const manifestParsed = Manifest.safeParse(await Bun.file(manifestPath).json());
    if (manifestParsed.success) manifest = manifestParsed.data;
    else console.warn(`  ! manifest.json for ${slate.track.slug} failed validation, importing without origin clearance detail`);
  } else {
    console.warn(`  ! no manifest.json found at ${manifestPath.pathname}`);
  }

  // ── Track ──────────────────────────────────────────────────────────────
  const tracks = await listTracks(sql, true);
  let track = tracks.find((t) => t.slug === slate.track.slug);
  if (track) {
    console.log(`  track exists (${track.id})`);
  } else {
    track = await createTrack(sql, slate.track);
    console.log(`  track created (${track.id})`);
  }

  // ── Spots + content ────────────────────────────────────────────────────
  const existing = await listSpots(sql, { limit: 1000, trackId: track.id });

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
      console.error(`  ! failed to write spot "${s.title}"`);
      continue;
    }
    prior ? totalUpdated++ : totalCreated++;

    const hostedAudioUrl = await uploadStopAudio(slate.track.slug, s.slug, audioByStop.get(s)!);

    // Verbatim transcript, word/sentence tiers only — no audio-time alignment
    // (the research pass did not produce per-word timestamps for pre-existing
    // audio; the on-device highlighter falls back to whole-piece playback).
    const doc = FiloDocument.fromText(s.narration, { metadata: { locale: "en" } });
    annotateWords(doc, { tierId: TIER.words, language: "en" });
    annotateSentences(doc, { tierId: TIER.sentences, language: "en" });

    const origin = manifest
      ? {
          name: manifest.tour_name,
          url: manifest.license.source_url,
          publisher: manifest.publisher,
          license: manifest.license.type,
          clearance: manifest.clearance,
        }
      : undefined;

    const priorContent = prior ? await listContentForSpot(sql, spot.id) : [];
    const priorDefault = priorContent.find((cp) => cp.variant === "default");
    await upsertContent(sql, {
      spotId: spot.id,
      locale: "en",
      variant: "default",
      document: doc.toJSON() as FiloDocumentJson,
      audioUrl: hostedAudioUrl,
      durationMs: s.durationMs ?? priorDefault?.durationMs ?? null,
      source: "imported",
      provenance: {
        sources: s.sources.map((url) => ({ name: new URL(url).hostname, url })),
        ...(origin ? { origin } : {}),
        generatedAt: new Date().toISOString(),
        warnings: [],
      },
      status,
    });
    console.log(`  ${prior ? "updated" : "created"} "${s.title}" (${spot.slug}) -> ${hostedAudioUrl}`);
  }

  // ── Visibility hold, if this tour's audio isn't cleared ───────────────
  const holdReason = HOLD_REASONS[slate.track.slug];
  if (holdReason) {
    await setTrackVisibility(sql, track.id, "private", holdReason);
    console.log(`  held: track set to private — ${holdReason.slice(0, 80)}...`);
  } else if (track.visibility === "private" && !HOLD_REASONS[slate.track.slug]) {
    // Nothing to do — a track not in HOLD_REASONS is left as whatever it
    // already is; this script only ever adds holds, never lifts them.
  }
}

console.log(`\ndone: ${totalCreated} spots created, ${totalUpdated} updated, status=${status}`);
await sql.end();
