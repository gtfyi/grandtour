/**
 * Publish the content repository: every public track to the public content
 * repository and the site, with its recordings uploaded to the bucket.
 *
 *   cd server && bun run content:publish --from ../../content-private --to ../../content [options]
 *
 *   --site <dir>   also write the files into the site's static root
 *   --upload       upload each referenced recording to the R2_* bucket (objects that exist are
 *                  skipped) and each public bundle to tours/<file> there (rewritten when changed)
 *   --prune        delete bundles in the targets that are no longer public
 *
 * Held tracks stay in the private repository only: their entries are dropped
 * from the public index, their bundles are not copied, and their audio is
 * never uploaded — so a held track's public URLs do not resolve. The public
 * repository also receives LICENSE and README.public.md (as README.md) from
 * the private one. The bundles go to the bucket as well because the site
 * serves them from there (Workers static assets stop at 25 MiB per file, and
 * a topic track's bundle passed that): the site build points its index at
 * `${AUDIO_PUBLIC_BASE_URL}/tours/` (SITE_BUNDLE_BASE_URL). Publishing is
 * idempotent; run it after every export you want live. It leaves the git
 * commit and the site deploy to you and prints them.
 */
import { mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { INDEX_FILE, Index, TOURS_DIR, TrackExport, audioRefsOf, publicIndex } from "@grandtour/shared";
import { env } from "../src/env";
import { localUploadsDir } from "../src/ai/storage";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]!] : []))[0];
const fromArg = value("--from");
const toArg = value("--to");
if (!fromArg || !toArg) {
  console.error("usage: bun run scripts/publish-content.ts --from <private dir> --to <public dir> [--site <dir>] [--upload] [--prune]");
  process.exit(1);
}
const FROM = resolve(fromArg);
const targets = [resolve(toArg), ...(value("--site") ? [resolve(value("--site")!)] : [])];

const index = publicIndex(Index.parse(await Bun.file(join(FROM, INDEX_FILE)).json()));
const bundles = new Map<string, { text: string; bundle: TrackExport }>();
for (const track of index.tracks) {
  const text = await Bun.file(join(FROM, track.url)).text();
  bundles.set(track.url, { text, bundle: TrackExport.parse(JSON.parse(text)) });
}

for (const target of targets) {
  await mkdir(join(target, TOURS_DIR), { recursive: true });
  await Bun.write(join(target, INDEX_FILE), `${JSON.stringify(index, null, 2)}\n`);
  for (const [url, { text }] of bundles) await Bun.write(join(target, url), text);
  // The public repository carries the licence and its own README (the
  // private README describes the repository of record); the site does not.
  if (target === targets[0]) {
    for (const [from, to] of [["LICENSE", "LICENSE"], ["README.public.md", "README.md"]]) {
      const file = Bun.file(join(FROM, from));
      if (await file.exists()) await Bun.write(join(target, to), file);
    }
  }
  if (flag("--prune")) {
    const keep = new Set([...bundles.keys()].map((u) => u.split("/").pop()!));
    for (const name of await readdir(join(target, TOURS_DIR))) {
      if (name.endsWith(".grandtour.json") && !keep.has(name)) await rm(join(target, TOURS_DIR, name));
    }
  }
}

let uploaded = 0, present = 0, bundlesUploaded = 0, bundlesPresent = 0;
if (flag("--upload")) {
  const { endpoint, bucket, accessKey, secretKey } = {
    endpoint: env.publish.endpoint(), bucket: env.publish.bucket(),
    accessKey: env.publish.accessKey(), secretKey: env.publish.secretKey(),
  };
  if (!endpoint || !bucket || !accessKey || !secretKey) {
    throw new Error("--upload needs R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY (the public bucket's S3 credentials)");
  }
  const { S3Client } = await import("bun");
  const client = new S3Client({ endpoint, bucket, accessKeyId: accessKey, secretAccessKey: secretKey });
  const manifest = (await Bun.file(join(FROM, "audio-manifest.json")).json()) as Record<string, { source: string; bytes: number }>;
  const base = `${env.audioPublicBaseUrl()}/`;
  const types: Record<string, string> = { mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav" };
  const keys = new Set<string>();
  for (const { bundle } of bundles.values()) {
    for (const ref of audioRefsOf(bundle)) if (ref.startsWith(base)) keys.add(ref.slice(base.length));
  }
  for (const key of [...keys].sort()) {
    const entry = manifest[key];
    if (!entry) throw new Error(`${key} is not in audio-manifest.json — re-run content:export`);
    if (await client.exists(key)) { present++; continue; }
    const file = Bun.file(join(localUploadsDir, entry.source));
    if (!(await file.exists())) throw new Error(`missing recording for ${key}: ${entry.source}`);
    await client.write(key, file, { type: types[key.split(".").pop() ?? ""] ?? "application/octet-stream" });
    uploaded++;
  }
  // Bundles are keyed by slug and change with every export, so compare the
  // object's ETag (the MD5 of a single-part upload) instead of skipping on
  // existence. The index itself is not uploaded: a server is where its
  // index is, and the site's index names these objects.
  for (const [url, { text }] of bundles) {
    const md5 = new Bun.CryptoHasher("md5").update(text).digest("hex");
    const current = await client.stat(url).catch(() => null);
    if (current?.etag?.replace(/"/g, "") === md5) { bundlesPresent++; continue; }
    await client.write(url, text, { type: "application/json" });
    bundlesUploaded++;
  }
}

console.log(`published ${index.tracks.length} public track(s) → ${targets.join(", ")}` +
  (flag("--upload")
    ? `; audio: ${uploaded} uploaded, ${present} already present; bundles: ${bundlesUploaded} uploaded, ${bundlesPresent} unchanged`
    : "; nothing uploaded (pass --upload)"));
console.log(`next: commit and push ${targets[0]}${targets[1] ? `, then deploy the site from ${targets[1]}` : ""}`);
