import { describe, expect, test } from "bun:test";
import { TrackExport } from "../src/api";
import { areaId } from "../src/area";
import {
  INDEX_FILE,
  audioRefsOf,
  buildIndex,
  indexUrl,
  mapAudioRefs,
  publicIndex,
  resolveTrackUrl,
  stableExportedAt,
  summarizeTrack,
  tracksInAreas,
  voicedOnly,
  slimDocuments,
} from "../src/distribution";

const fairfax = { lat: 37.9871, lng: -122.5889 };
const glacier = { lat: 48.6855, lng: -113.7037 };
const sha = "b".repeat(64);
const audio = `https://data.grandtour.fyi/audio/${sha}.mp3`;

let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

function bundle(opts: {
  slug?: string; official?: boolean; visibility?: "public" | "private";
  spots: Array<{ at: { lat: number; lng: number }; voiced: boolean; updatedAt?: string }>;
}): TrackExport {
  const trackId = uuid();
  return TrackExport.parse({
    exportedAt: "2026-09-19T00:00:00.000Z",
    track: {
      id: trackId, slug: opts.slug ?? "t", name: opts.slug ?? "T", official: opts.official ?? false,
      visibility: opts.visibility, createdAt: "2026-01-01T00:00:00.000Z",
    },
    spots: opts.spots.map((s, i) => {
      const spotId = uuid();
      const stamp = s.updatedAt ?? "2026-02-01T00:00:00.000Z";
      return {
        spot: {
          id: spotId, trackId, slug: `s${i}`, title: `S${i}`, subtitle: "",
          trigger: { kind: "point", center: s.at, radiusM: 40 },
          locating: { mode: "auto", clips: s.voiced ? { fixed: { text: "Here.", audioUrl: audio, durationMs: 800 } } : {} },
          createdAt: "2026-01-01T00:00:00.000Z", updatedAt: stamp,
        },
        content: [{
          id: uuid(), spotId, document: null, audioUrl: s.voiced ? audio : null,
          durationMs: s.voiced ? 60_000 : null, source: "human", provenance: null, status: "published",
          createdAt: "2026-01-01T00:00:00.000Z", updatedAt: stamp,
        }],
      };
    }),
  });
}

describe("indexUrl", () => {
  test("a bare host, an origin, a folder and a dev server all name their index", () => {
    expect(indexUrl("grandtour.fyi")).toBe(`https://grandtour.fyi/${INDEX_FILE}`);
    expect(indexUrl("https://grandtour.fyi")).toBe(`https://grandtour.fyi/${INDEX_FILE}`);
    expect(indexUrl(" https://example.org/tours ")).toBe(`https://example.org/tours/${INDEX_FILE}`);
    expect(indexUrl("http://localhost:8787")).toBe(`http://localhost:8787/${INDEX_FILE}`);
    expect(indexUrl("http://100.80.32.94:8787/?x=1#y")).toBe(`http://100.80.32.94:8787/${INDEX_FILE}`);
  });

  test("a GitHub repository is served raw from its branch and folder", () => {
    expect(indexUrl("github.com/gtfyi/content")).toBe(`https://raw.githubusercontent.com/gtfyi/content/main/${INDEX_FILE}`);
    expect(indexUrl("https://github.com/gtfyi/content.git")).toBe(`https://raw.githubusercontent.com/gtfyi/content/main/${INDEX_FILE}`);
    expect(indexUrl("https://github.com/gtfyi/content/tree/dev/marin")).toBe(`https://raw.githubusercontent.com/gtfyi/content/dev/marin/${INDEX_FILE}`);
    expect(() => indexUrl("github.com/gtfyi")).toThrow();
  });

  test("an explicit index file is used as given", () => {
    expect(indexUrl("https://example.org/anything/index.json")).toBe("https://example.org/anything/index.json");
  });
});

describe("resolveTrackUrl", () => {
  test("relative to the index, absolute as given", () => {
    const entry = summarizeTrack(bundle({ slug: "history", spots: [{ at: fairfax, voiced: true }] }))!;
    expect(resolveTrackUrl(entry, "https://grandtour.fyi/grandtour.json")).toBe("https://grandtour.fyi/tours/history.grandtour.json");
    expect(resolveTrackUrl(entry, "https://raw.githubusercontent.com/gtfyi/content/main/grandtour.json"))
      .toBe("https://raw.githubusercontent.com/gtfyi/content/main/tours/history.grandtour.json");
    expect(resolveTrackUrl({ ...entry, url: "https://elsewhere.org/x.grandtour.json" }, "https://grandtour.fyi/grandtour.json"))
      .toBe("https://elsewhere.org/x.grandtour.json");
  });
});

describe("voicedOnly / stableExportedAt", () => {
  test("drops silent spots and recounts", () => {
    const b = voicedOnly(bundle({ spots: [{ at: fairfax, voiced: true }, { at: fairfax, voiced: false }] }));
    expect(b.spots).toHaveLength(1);
    expect(b.track.spotCount).toBe(1);
  });

  test("exportedAt is the newest change the bundle carries, not the clock", () => {
    const b = bundle({ spots: [
      { at: fairfax, voiced: true, updatedAt: "2026-03-01T00:00:00.000Z" },
      { at: fairfax, voiced: true, updatedAt: "2026-05-01T00:00:00.000Z" },
    ] });
    expect(stableExportedAt(b)).toBe("2026-05-01T00:00:00.000Z");
  });
});

describe("audioRefsOf / mapAudioRefs", () => {
  test("collects narrations and locating clips once, and rewrites them all", () => {
    const b = bundle({ spots: [{ at: fairfax, voiced: true }, { at: glacier, voiced: true }] });
    expect(audioRefsOf(b)).toEqual([audio]);
    const moved = mapAudioRefs(b, (ref) => ref.replace("data.grandtour.fyi", "cdn.example"));
    expect(audioRefsOf(moved)).toEqual([audio.replace("data.grandtour.fyi", "cdn.example")]);
    expect(moved.spots[0]!.spot.locating.clips.fixed?.audioUrl).toContain("cdn.example");
    expect(audioRefsOf(b)).toEqual([audio]);
  });
});

describe("summarizeTrack / buildIndex / publicIndex / tracksInAreas", () => {
  test("an entry carries identity, footprint cells and the file digest", () => {
    const entry = summarizeTrack(
      bundle({ slug: "two-parks", spots: [{ at: fairfax, voiced: true }, { at: glacier, voiced: true }] }),
      { hash: sha, bytes: 1234 },
    );
    expect(entry).not.toBeNull();
    expect(entry!.url).toBe("tours/two-parks.grandtour.json");
    expect(entry!.areas).toEqual([areaId(fairfax), areaId(glacier)].sort());
    expect(entry!.hash).toBe(sha);
    expect(entry!.bytes).toBe(1234);
    expect(entry!.voicedCount).toBe(2);
    expect(entry!.minutes).toBe(2);
    expect(entry!.spanKm).toBeGreaterThan(1000);
    expect(entry!.visibility).toBe("public");
    expect(entry!.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  test("is null for a bundle with nothing to place on a map", () => {
    expect(summarizeTrack(bundle({ spots: [] }))).toBeNull();
  });

  test("official first, then by name; a public index drops held tracks; selection by cell", () => {
    const a = summarizeTrack(bundle({ slug: "zeta", official: true, spots: [{ at: fairfax, voiced: true }] }))!;
    const b = summarizeTrack(bundle({ slug: "alpha", spots: [{ at: glacier, voiced: true }] }))!;
    const c = summarizeTrack(bundle({ slug: "beta", official: true, spots: [{ at: fairfax, voiced: true }] }))!;
    const held = summarizeTrack(bundle({ slug: "held", visibility: "private", spots: [{ at: fairfax, voiced: true }] }))!;
    const index = buildIndex([a, b, c, held], { generatedAt: "2026-09-19T00:00:00.000Z", source: { repo: "gtfyi/grandtour", commit: "abc" } });
    expect(index.formatVersion).toBe(1);
    expect(index.tracks.map((t) => t.slug)).toEqual(["beta", "zeta", "alpha", "held"]);

    const pub = publicIndex(index);
    expect(pub.tracks.map((t) => t.slug)).toEqual(["beta", "zeta", "alpha"]);
    expect(pub.tracks.every((t) => !("visibility" in t))).toBe(true);
    expect(JSON.stringify(pub)).not.toContain("visibility");

    expect(tracksInAreas(pub, [areaId(glacier)]).map((t) => t.slug)).toEqual(["alpha"]);
    expect(tracksInAreas(pub, [areaId(fairfax)]).map((t) => t.slug)).toEqual(["beta", "zeta"]);
    expect(tracksInAreas(pub, ["0000"])).toEqual([]);
  });
});

describe("slimDocuments", () => {
  const at = "2026-01-01T00:00:00.000Z";
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const tier = (kind: string) => ({ id: kind, kind, source: "test", annotations: [{ id: `${kind}-1`, tierId: kind, kind, start: 0, end: 5, payload: {} }] });
  const bundle = TrackExport.parse({
    formatVersion: 1, exportedAt: at,
    track: { id: id(1), slug: "t", name: "T", description: "", official: true, createdAt: at },
    spots: [{
      spot: { id: id(2), trackId: id(1), slug: "s", title: "S", subtitle: "", trigger: { kind: "point", center: { lat: 1, lng: 2 }, radiusM: 30 }, createdAt: at, updatedAt: at },
      content: [{
        id: id(3), spotId: id(2), locale: "en", variant: "default", source: "human", provenance: null, status: "published", createdAt: at, updatedAt: at,
        audioUrl: "https://data.example/audio/a.mp3", durationMs: 1000,
        document: { id: "d", text: "Hello", byteLength: 5, metadata: {}, tiers: [tier("word"), tier("sentence"), tier("audio")] },
      }],
    }],
  });
  test("keeps the audio and sentence tiers and drops the word tier, leaving the input alone", () => {
    const slim = slimDocuments(bundle);
    expect(slim.spots[0]!.content[0]!.document!.tiers.map((t) => t.kind)).toEqual(["sentence", "audio"]);
    expect(bundle.spots[0]!.content[0]!.document!.tiers).toHaveLength(3);
    expect(slim.spots[0]!.content[0]!.document!.text).toBe("Hello");
  });
});
