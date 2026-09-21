/** Move the existing sheriff recordings without recreating spots or content.
 * Run at repo root: bun --env-file=.env server/scripts/separate-point-reyes-sheriff-track.ts [--apply]
 * The default is a read-only preview. The move is atomic and safe to repeat.
 */
import { createHash } from "node:crypto";
import { TrackInput } from "@grandtour/shared";
import { sql } from "../../src/db";

const apply = process.argv.includes("--apply");
const sourceSlug = "fairfax-point-reyes-archive-drive";
// The dated slate is the fixed migration membership. The canonical track
// slate can grow after separation without changing this repeatable move.
const slate = await Bun.file(new URL("../data/sheriff-calls-plain-2026-09-12.spots.json", import.meta.url)).json();
const target = TrackInput.parse(slate.track);
const titles: string[] = slate.spots.map((s: any) => s.title);
if (titles.length !== 18 || new Set(titles).size !== titles.length) throw new Error("Expected the 18 existing sheriff recordings");
for (const s of slate.spots) {
  const exact = s.reportEntries.map((e: any) => `${e.date}. ${e.town}. ${e.report}`).join(" ");
  if (s.narration !== exact) throw new Error(`Unexpected narration: ${s.title}`);
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

try {
  const result = await sql.begin(async tx => {
    const [source] = await tx`SELECT * FROM tracks WHERE slug = ${sourceSlug} FOR UPDATE`;
    if (!source) throw new Error("Point Reyes drive is missing");
    let [destination] = await tx`SELECT * FROM tracks WHERE slug = ${target.slug} FOR UPDATE`;
    const rows = await tx`
      SELECT s.id, s.title, s.slug, s.track_id,
        to_jsonb(s) - 'track_id' - 'updated_at' AS preserved_spot,
        (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM content_pieces c WHERE c.spot_id = s.id) AS content
      FROM spots s
      WHERE s.title = ANY(${titles}) AND (s.track_id = ${source.id} OR s.track_id = ${destination?.id ?? source.id})
      ORDER BY s.id FOR UPDATE OF s
    `;
    if (rows.length !== titles.length || new Set(rows.map(r => r.title)).size !== titles.length) {
      throw new Error("Missing or duplicated sheriff spots; no changes made");
    }
    for (const row of rows) {
      const authored = slate.spots.find((s: any) => s.title === row.title);
      const content = row.content?.find((c: any) => c.locale === "en" && c.variant === "default");
      if (row.preserved_spot.status !== "published" || content?.status !== "published" ||
          !content?.audio_url || content.document?.text !== authored.narration) {
        throw new Error(`Recording or transcript mismatch: ${row.title}`);
      }
    }
    const moving = rows.filter(r => r.track_id === source.id);
    const before = {
      verifiedAt: new Date().toISOString(), sourceTrackId: source.id,
      sourceSlug, targetSlug: target.slug,
      spots: rows.map(r => ({
        id: r.id, title: r.title, slug: r.slug, priorTrackId: r.track_id,
        preservedSpotHash: hash(r.preserved_spot), contentHash: hash(r.content),
        content: r.content.map((c: any) => ({ id: c.id, audioUrl: c.audio_url, durationMs: c.duration_ms })),
      })),
    };
    if (!apply) return { preview: true, sourceSlug, targetSlug: target.slug, recordings: rows.length, toMove: moving.length };

    const backup = new URL("../../docs/sheriff-track-separation-before-2026-09-13.json", import.meta.url);
    if (!await Bun.file(backup).exists()) await Bun.write(backup, JSON.stringify(before, null, 2) + "\n");
    if (!destination) {
      [destination] = await tx`
        INSERT INTO tracks (slug, name, description, kind, lifecycle, icon, color, official)
        VALUES (${target.slug}, ${target.name}, ${target.description}, ${target.kind}, ${target.lifecycle},
                ${target.icon}, ${target.color}, ${target.official}) RETURNING *
      `;
    }
    if (!destination || destination.kind !== "tour") throw new Error("Destination must be a tour track");
    if (moving.length) {
      await tx`UPDATE spots SET track_id = ${destination.id}, updated_at = now() WHERE id = ANY(${moving.map(r => r.id)})`;
      // Advance the old drive's nearby freshness version so cached clients
      // fetch its reduced membership even without changing their location.
      await tx`UPDATE spots SET updated_at = now() WHERE track_id = ${source.id}`;
      await tx`UPDATE tracks SET description = replace(description,
        'dated Point Reyes Light reporting and sheriff-call excerpts', 'dated Point Reyes Light reporting')
        WHERE id = ${source.id}`;
    }
    const after = await tx`
      SELECT s.id, s.track_id, to_jsonb(s) - 'track_id' - 'updated_at' AS preserved_spot,
        (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM content_pieces c WHERE c.spot_id = s.id) AS content
      FROM spots s WHERE s.id = ANY(${rows.map(r => r.id)}) ORDER BY s.id
    `;
    for (const [i, row] of after.entries()) {
      if (row.track_id !== destination.id || hash(row.content) !== hash(rows[i]!.content) ||
          hash(row.preserved_spot) !== hash(rows[i]!.preserved_spot)) {
        throw new Error("Preservation check failed; rolling back the move");
      }
    }
    return { preview: false, sourceSlug, targetSlug: target.slug, targetTrackId: destination.id,
      recordings: rows.length, moved: moving.length, spotIdsPreserved: true, contentAndAudioPreserved: true };
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await sql.end();
}
