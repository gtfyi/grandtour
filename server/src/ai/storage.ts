import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { env } from "../env";

const LOCAL_DIR = join(import.meta.dir, "../../uploads");

/**
 * Short content fingerprint to embed in audio keys, so every distinct
 * generation gets a distinct URL. Clients cache audio by URL and never
 * revalidate; a regenerated clip stored at the same key would play stale
 * from that cache forever. Same bytes hash to the same key, which makes
 * re-saving identical audio a harmless overwrite.
 */
export function contentVersion(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 8);
}

/**
 * Persist an audio blob and return a public URL.
 *
 * If S3/R2 storage is configured, upload there. Otherwise (dev), write to a
 * local ./uploads directory which the server exposes at /uploads/*.
 */
export async function putAudio(
  key: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<string> {
  const endpoint = env.storage.endpoint();
  const bucket = env.storage.bucket();
  const accessKey = env.storage.accessKey();
  const secretKey = env.storage.secretKey();

  if (endpoint && bucket && accessKey && secretKey) {
    // Use Bun's built-in S3 client (S3/R2 compatible).
    const { S3Client } = await import("bun");
    const client = new S3Client({
      endpoint,
      bucket,
      accessKeyId: accessKey,
      secretAccessKey: secretKey,
    });
    await client.write(key, bytes, { type: contentType });
    const base = env.storage.publicBaseUrl() ?? `${endpoint}/${bucket}`;
    return `${base.replace(/\/$/, "")}/${key}`;
  }

  // Dev fallback: local file, served by the server.
  await mkdir(LOCAL_DIR, { recursive: true });
  const path = join(LOCAL_DIR, key.replace(/\//g, "_"));
  await Bun.write(path, bytes);
  const port = env.port();
  return `http://localhost:${port}/uploads/${key.replace(/\//g, "_")}`;
}

export const localUploadsDir = LOCAL_DIR;

/** True when S3/R2 storage is configured (vs. the local dev fallback). */
export function isRemoteStorage(): boolean {
  return Boolean(
    env.storage.endpoint() &&
      env.storage.bucket() &&
      env.storage.accessKey() &&
      env.storage.secretKey(),
  );
}

/** Lazily-constructed S3 client for reads; null when storage isn't configured. */
async function s3Client() {
  if (!isRemoteStorage()) return null;
  const { S3Client } = await import("bun");
  return new S3Client({
    endpoint: env.storage.endpoint(),
    bucket: env.storage.bucket(),
    accessKeyId: env.storage.accessKey(),
    secretAccessKey: env.storage.secretKey(),
  });
}

export interface AudioObject {
  /** Total size of the object in bytes. */
  size: number;
  contentType: string;
  /**
   * Read the requested byte range (inclusive), or the whole object if omitted,
   * into a fixed buffer. A fixed-size body lets the runtime emit an accurate
   * Content-Length instead of chunked transfer encoding — which iOS AVPlayer
   * relies on for seeking. (Returning a Blob/file slice was unreliable: Bun's
   * file fast-path ignored the slice bounds and streamed the whole file.)
   */
  bytes(range?: { start: number; end: number }): Promise<Uint8Array>;
}

/**
 * Look up a stored audio object by its public key (the path segment after
 * /uploads/). Returns null if it doesn't exist. Supports both the local dev
 * directory and S3/R2 when STORAGE_* is configured.
 */
export async function getAudio(key: string): Promise<AudioObject | null> {
  const client = await s3Client();
  if (client) {
    const file = client.file(key);
    const stat = await file.stat().catch(() => null);
    if (!stat) return null;
    return {
      size: stat.size,
      contentType: stat.type || "application/octet-stream",
      bytes: async (range) => {
        const slice = range ? file.slice(range.start, range.end + 1) : file;
        return new Uint8Array(await slice.arrayBuffer());
      },
    };
  }

  // Local dev fallback. Files are written with `/` replaced by `_`.
  const path = join(LOCAL_DIR, key.replace(/\//g, "_"));
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  return {
    size: file.size,
    contentType: file.type || "application/octet-stream",
    bytes: async (range) => {
      const slice = range ? file.slice(range.start, range.end + 1) : file;
      return new Uint8Array(await slice.arrayBuffer());
    },
  };
}
