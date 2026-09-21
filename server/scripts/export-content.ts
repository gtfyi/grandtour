/**
 * Export the tour inventory as a GrandTour server's files — the content
 * repository's layout, which is also what every server serves:
 *
 *   <out>/grandtour.json                Index of every tour track; held ones marked private
 *   <out>/tours/<slug>.grandtour.json   TrackExport, voiced spots only, formatVersion 1
 *   <out>/audio-manifest.json           private: the local recording behind each public audio URL
 *
 *   cd server && bun run content:export --out ../../content-private [options]
 *
 *   --extra <bundle.json>   add a pre-built bundle (repeatable)
 *   --prune                 delete bundles under <out>/tours that are no longer exported
 *   --allow-missing         warn instead of fail when a recording is missing locally
 *   --stamp                 record the exporting commit in the index
 *
 * No audio is copied. A bundle names each recording by its public URL,
 * `${AUDIO_PUBLIC_BASE_URL}/audio/<sha256>.<ext>`, computed from the local
 * file's content hash; the bytes reach that URL when `content:publish`
 * uploads them, and until a track is published its URLs simply do not
 * resolve. External recordings keep their own URLs. Output is deterministic:
 * an unchanged track exports byte-for-byte the same file.
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import {
  FORMAT_VERSION,
  INDEX_FILE,
  TOURS_DIR,
  TrackExport,
  audioRefsOf,
  buildIndex,
  mapAudioRefs,
  slimDocuments,
  stableExportedAt,
  summarizeTrack,
  voicedOnly,
  type IndexTrack,
} from "@grandtour/shared";
import { sql } from "../src/db";
import { env } from "../src/env";
import { localUploadsDir } from "../src/ai/storage";
import { exportTrack, listTracks } from "../src/content/repo";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const values = (name: string) => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]!] : []));
const outArg = values("--out")[0];
if (!outArg) {
  console.error("usage: bun run scripts/export-content.ts --out <dir> [--extra <bundle.json>]... [--prune] [--allow-missing] [--stamp]");
  process.exit(1);
}
const OUT = resolve(outArg);
const TOURS = join(OUT, TOURS_DIR);
await mkdir(TOURS, { recursive: true });
const AUDIO_BASE = env.audioPublicBaseUrl();

// ── Recordings: hosted by us → content-addressed public URL; external → untouched ──
const manifest: Record<string, { source: string; bytes: number }> = {};
const named = new Map<string, string>();
const external = new Set<string>();
let missing = 0;

function localFileFor(ref: string): string | null {
  let url: URL;
  try { url = new URL(ref); } catch { return null; }
  if (!url.pathname.startsWith("/uploads/")) return null;
  return join(localUploadsDir, decodeURIComponent(basename(url.pathname)));
}

async function publicUrlFor(ref: string): Promise<string> {
  const cached = named.get(ref);
  if (cached) return cached;
  const file = localFileFor(ref);
  if (!file) {
    external.add(new URL(ref).host);
    return ref;
  }
  const source = Bun.file(file);
  if (!(await source.exists())) {
    missing++;
    const message = `missing recording: ${file} (referenced as ${ref})`;
    if (!flag("--allow-missing")) throw new Error(message);
    console.warn(`[content:export] ${message}`);
    return ref;
  }
  const bytes = new Uint8Array(await source.arrayBuffer());
  const sha = createHash("sha256").update(bytes).digest("hex");
  const key = `audio/${sha}${(extname(file) || ".mp3").toLowerCase()}`;
  manifest[key] = { source: basename(file), bytes: bytes.byteLength };
  const url = `${AUDIO_BASE}/${key}`;
  named.set(ref, url);
  return url;
}

// ── Bundles ─────────────────────────────────────────────────────────────────
const tracks = (await listTracks(sql, true)).filter((t) => t.kind === "tour");
const bundles: TrackExport[] = [];
for (const track of tracks) {
  const exported = await exportTrack(sql, track.id);
  if (exported) bundles.push(slimDocuments(voicedOnly(exported)));
}
for (const path of values("--extra")) {
  const bundle = slimDocuments(voicedOnly(TrackExport.parse(await Bun.file(path).json())));
  if (!bundles.some((b) => b.track.slug === bundle.track.slug)) bundles.push(bundle);
}

const entries: IndexTrack[] = [];
const written = new Set<string>();
for (const raw of bundles) {
  if (raw.spots.length === 0) continue;
  const urls = new Map<string, string>();
  for (const ref of audioRefsOf(raw)) urls.set(ref, await publicUrlFor(ref));
  const relocated = mapAudioRefs(raw, (ref) => urls.get(ref) ?? ref);
  const bundle = TrackExport.parse({
    ...relocated,
    formatVersion: FORMAT_VERSION,
    exportedAt: stableExportedAt(relocated),
  });
  // Compact: a bundle is fetched by phones over cellular, and pretty-printing doubles it.
  const text = `${JSON.stringify(bundle)}\n`;
  const name = `${bundle.track.slug}.grandtour.json`;
  const entry = summarizeTrack(bundle, {
    hash: createHash("sha256").update(text).digest("hex"),
    bytes: Buffer.byteLength(text),
  });
  if (!entry) continue;
  await Bun.write(join(TOURS, name), text);
  written.add(name);
  entries.push(entry);
}

const stamp = flag("--stamp")
  ? { repo: "gtfyi/grandtour", commit: Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim() }
  : undefined;
const index = buildIndex(entries, {
  name: "GrandTour",
  description: "Tracks published by grandtour.fyi",
  generatedAt: entries.length ? bundles.map(stableExportedAt).sort().at(-1) : undefined,
  source: stamp,
});
await Bun.write(join(OUT, INDEX_FILE), `${JSON.stringify(index, null, 2)}\n`);
const sortedManifest = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)));
await Bun.write(join(OUT, "audio-manifest.json"), `${JSON.stringify(sortedManifest, null, 2)}\n`);

let pruned = 0;
if (flag("--prune")) {
  for (const name of await readdir(TOURS)) {
    if (name.endsWith(".grandtour.json") && !written.has(name)) { await rm(join(TOURS, name)); pruned++; }
  }
}

for (const t of index.tracks) {
  const held = t.visibility === "private" ? "  HELD" : "";
  console.log(`  ${t.name.padEnd(48)} ${String(t.voicedCount).padStart(4)} voiced ${String(t.minutes).padStart(6)} min  ${t.areas.length} area(s)${held}`);
}
console.log(
  `wrote ${index.tracks.length} track(s) → ${OUT}: ${Object.keys(manifest).length} recording(s) named under ${AUDIO_BASE}/audio/` +
  `${missing ? `, ${missing} missing` : ""}${external.size ? `, external audio left at ${[...external].join(", ")}` : ""}` +
  `${pruned ? `, ${pruned} stale bundle(s) pruned` : ""}`,
);
await sql.end();
