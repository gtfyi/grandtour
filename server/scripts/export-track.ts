/**
 * Export a track's published content as a static JSON bundle for the
 * offline tour viewer (packages/tour-viewer).
 *
 *   bun run scripts/export-track.ts <track-slug-or-id> [--out path]
 *
 * Writes <slug>.grandtour.json to cwd by default. Audio stays
 * URL-referenced (not inlined) — the bundle drives the viewer's map, spot
 * triggers, and transcript entirely offline, but playback still needs
 * whatever host served those audioUrls to be reachable.
 */
import { sql } from "../src/db";
import { exportTrack, listTracks } from "../src/content/repo";

const [ref] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const outFlagIdx = process.argv.indexOf("--out");
const outArg = outFlagIdx >= 0 ? process.argv[outFlagIdx + 1] : undefined;

if (!ref) {
  console.error("Usage: bun run scripts/export-track.ts <track-slug-or-id> [--out path]");
  process.exit(1);
}

const tracks = await listTracks(sql);
const track = tracks.find((t) => t.id === ref || t.slug === ref);
if (!track) {
  console.error(`No track matching "${ref}". Known slugs: ${tracks.map((t) => t.slug).join(", ")}`);
  process.exit(1);
}

const bundle = await exportTrack(sql, track.id);
if (!bundle) {
  console.error(`Track "${track.slug}" disappeared mid-export.`);
  process.exit(1);
}

const outPath = outArg ?? `${track.slug}.grandtour.json`;
await Bun.write(outPath, JSON.stringify(bundle, null, 2));
console.log(
  `Wrote ${outPath} — ${bundle.spots.length} published spot(s) from "${track.name}".`,
);

await sql.end();
