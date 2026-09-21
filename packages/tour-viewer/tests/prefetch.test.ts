import { describe, expect, test } from "bun:test";
import { AudioPrefetch } from "../src/prefetch";

const settle = () => new Promise((r) => setTimeout(r, 20));

describe("AudioPrefetch", () => {
  test("keeps a readable recording as a blob and warms an unreadable one", async () => {
    const calls: string[] = [];
    const prefetch = new AudioPrefetch(6, async (url, init) => {
      calls.push(`${url}${init?.mode === "no-cors" ? " (no-cors)" : ""}`);
      if (url.includes("bucket")) return new Response("audio bytes");
      throw new TypeError("no CORS");
    });
    prefetch.warm(["https://bucket/a.mp3", "https://elsewhere/b.mp3", null, "https://bucket/a.mp3"]);
    await settle();
    expect(prefetch.resolve("https://bucket/a.mp3").startsWith("blob:")).toBe(true);
    expect(prefetch.resolve("https://elsewhere/b.mp3")).toBe("https://elsewhere/b.mp3");
    expect(prefetch.has("https://elsewhere/b.mp3")).toBe(true);
    expect(calls).toEqual(["https://bucket/a.mp3", "https://elsewhere/b.mp3", "https://elsewhere/b.mp3 (no-cors)"]);
    prefetch.warm(["https://bucket/a.mp3"]);
    await settle();
    expect(calls).toHaveLength(3);
    // A host that refused once is asked opaquely from then on: one CORS error per host, not per file.
    prefetch.warm(["https://elsewhere/c.mp3"]);
    await settle();
    expect(calls.slice(3)).toEqual(["https://elsewhere/c.mp3 (no-cors)"]);
  });
  test("an unknown recording resolves to itself, and old ones are let go", async () => {
    const prefetch = new AudioPrefetch(2, async () => new Response("x"));
    expect(prefetch.resolve("https://bucket/z.mp3")).toBe("https://bucket/z.mp3");
    prefetch.warm(["https://bucket/1.mp3", "https://bucket/2.mp3", "https://bucket/3.mp3"]);
    await settle();
    expect(prefetch.has("https://bucket/1.mp3")).toBe(false);
    expect(prefetch.has("https://bucket/3.mp3")).toBe(true);
  });
});
