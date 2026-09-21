/**
 * Synthesize multi-voice ElevenLabs audio for every spot in a slate file.
 *
 *   bun run scripts/generate-voiceovers.ts <slate.json> [--force] [--only slug] [--voices id1,id2,...]
 *
 * Reads the slate (the same file import-spots.ts consumed — narrations there
 * may be plain strings or segment arrays with quoted speakers), matches spots
 * by slug within the slate's track, and voices each narration through
 * src/ai/voiceover.ts: narrator voice for prose, a cast voice per quoted
 * speaker, one stitched mp3 with a single aligned audio tier.
 *
 * Skips spots that already have audio unless --force. Sequential on purpose:
 * one TTS request in flight is provider-friendly and mid-run failures are
 * resumable.
 *
 * --voices rotates the narrator across the given ElevenLabs voice ids by the
 * spot's position in the slate, so the assignment is deterministic across
 * resumed runs. Without it, every spot uses the env default narrator.
 */
import { z } from "zod";
import { sql } from "../src/db";
import { listContentForSpot, listSpots, listTracks, upsertContent, setContentStatus } from "../src/content/repo";
import { generateVoiceover, type VoiceoverSegment } from "../src/ai/voiceover";

const Segment = z.object({
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

const Slate = z.object({
  track: z.object({ slug: z.string() }),
  spots: z.array(
    z.object({
      slug: z.string(),
      title: z.string(),
      narration: z.union([z.string(), z.array(Segment).min(1)]),
      sources: z.array(z.string()).default([]),
    }),
  ),
});

const args = process.argv.slice(2);
const force = args.includes("--force");
const onlyIdx = args.indexOf("--only");
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null;
const voicesIdx = args.indexOf("--voices");
const voiceRotation =
  voicesIdx >= 0 ? (args[voicesIdx + 1] ?? "").split(",").filter(Boolean) : [];
const path = args.find(
  (a) => !a.startsWith("--") && a !== only && a !== args[voicesIdx + 1],
);
if (!path) {
  console.error("usage: bun run scripts/generate-voiceovers.ts <slate.json> [--force] [--only slug]");
  process.exit(1);
}

const slate = Slate.parse(await Bun.file(path).json());
const track = (await listTracks(sql)).find((t) => t.slug === slate.track.slug);
if (!track) {
  console.error(`No track "${slate.track.slug}" — run import-spots.ts first.`);
  process.exit(1);
}
const spots = await listSpots(sql, { trackId: track.id, limit: 500 });
// Spot slugs are server-generated from titles; the slate's own slugs may
// differ, so match by title within the track — and because deliberately
// overlapping spots may SHARE a title, consume same-titled spots in
// creation order (mirroring import-spots.ts, which creates them in slate
// order and suffixes the generated slugs).
const byTitle = new Map<string, (typeof spots)[number][]>();
for (const s of [...spots].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
  const list = byTitle.get(s.title) ?? [];
  list.push(s);
  byTitle.set(s.title, list);
}

let made = 0;
let skipped = 0;
let failed = 0;
for (const [slateIndex, slateSpot] of slate.spots.entries()) {
  if (only && slateSpot.slug !== only) continue;
  const spot = byTitle.get(slateSpot.title)?.shift();
  if (!spot) {
    console.warn(`  ? "${slateSpot.title}" not in DB — import the slate first; skipping`);
    failed++;
    continue;
  }
  const existing = (await listContentForSpot(sql, spot.id)).find(
    (c) => c.locale === "en" && c.variant === "default",
  );
  if (existing?.audioUrl && !force) {
    skipped++;
    continue;
  }

  const segments: VoiceoverSegment[] =
    typeof slateSpot.narration === "string"
      ? [{ text: slateSpot.narration, speaker: null }]
      : slateSpot.narration.map((s) => ({
          text: s.text,
          speaker: s.speaker ? { name: s.speaker.name, kind: s.speaker.kind } : null,
        }));

  const narratorVoiceId =
    voiceRotation.length > 0 ? voiceRotation[slateIndex % voiceRotation.length] : undefined;
  try {
    console.log(
      `  ♪ ${slateSpot.slug} (${segments.length} segments${narratorVoiceId ? `, narrator ${narratorVoiceId}` : ""})`,
    );
    const out = await generateVoiceover({
      spotId: spot.id,
      locale: "en",
      variant: "default",
      segments,
      narratorVoiceId,
    });
    const saved = await upsertContent(sql, {
      spotId: spot.id,
      locale: "en",
      variant: "default",
      document: out.document,
      audioUrl: out.audioUrl,
      durationMs: out.durationMs,
      source: "human",
      provenance: {
        ...out.provenance,
        sources: slateSpot.sources.map((url) => ({ title: url, url })),
      },
      status: "published",
    });
    await setContentStatus(sql, saved.id, "published");
    made++;
  } catch (err) {
    failed++;
    console.error(`  ✗ ${slateSpot.slug}: ${err instanceof Error ? err.message : err}`);
  }
}

console.log(`done: ${made} voiced, ${skipped} already had audio, ${failed} failed`);
await sql.end();
