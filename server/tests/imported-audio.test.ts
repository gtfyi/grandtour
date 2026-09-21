import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { verifyImportedAudio } from "../src/content/imported-audio";

describe("verified park audio imports", () => {
  const intro = new TextEncoder().encode("Welcome to Saratoga");
  const finale = new TextEncoder().encode("Return to Saratoga");
  const introHash = createHash("sha256").update(intro).digest("hex");

  test("accepts the source recording verified for the stop", () => {
    expect(() => verifyImportedAudio(intro, introHash)).not.toThrow();
  });

  test("rejects a different stop's recording even when its local filename looks correct", () => {
    expect(() => verifyImportedAudio(finale, introHash)).toThrow("checksum mismatch");
  });

  test("continues to support slates without a verified checksum", () => {
    expect(() => verifyImportedAudio(intro)).not.toThrow();
  });
});
