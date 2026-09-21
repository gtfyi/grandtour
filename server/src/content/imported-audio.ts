import { createHash } from "node:crypto";

/** A verified source recording must stay paired with its researched stop. */
export function verifyImportedAudio(bytes: Uint8Array, expectedSha256?: string): void {
  if (!expectedSha256) return;
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expectedSha256) {
    throw new Error(`Imported audio checksum mismatch: expected ${expectedSha256}, got ${actual}`);
  }
}
