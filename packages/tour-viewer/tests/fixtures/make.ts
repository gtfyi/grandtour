// Writes tests/fixtures/sample.grandtour.json: a small synthetic track that
// satisfies the TrackExport schema. Run with `bun tests/fixtures/make.ts`.
import { TrackExport } from "@grandtour/shared";
const at = "2026-01-01T00:00:00.000Z";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const trackId = uuid(1);
const sha = (n: number) => String(n).padStart(64, "0");
const script = (text: string) => ({ id: `doc-${text.length}`, text, byteLength: new TextEncoder().encode(text).byteLength, metadata: {}, tiers: [] });
const spots = [
  ["town-hall", "Town Hall", 37.9871, -122.5889],
  ["the-creek", "The Creek", 37.9885, -122.5901],
  ["old-depot", "Old Depot", 37.9860, -122.5870],
  ["bolinas-road", "Bolinas Road", 37.9840, -122.5910],
] as const;
const bundle = TrackExport.parse({
  formatVersion: 1,
  exportedAt: at,
  track: { id: trackId, slug: "sample-town", name: "Sample Town", description: "A synthetic test track.", official: true, createdAt: at },
  spots: spots.map(([slug, title, lat, lng], i) => ({
    spot: {
      id: uuid(10 + i), trackId, slug, title, subtitle: "",
      trigger: { kind: "point", center: { lat, lng }, radiusM: 40 },
      createdAt: at, updatedAt: at,
    },
    content: [{
      id: uuid(100 + i), spotId: uuid(10 + i), document: script(`${title} is spot ${i + 1} of the sample track. Its story is short and made up.`),
      // The first spot is text-only, like the field data these tests grew up on.
      audioUrl: i === 0 ? null : `https://data.grandtour.fyi/audio/${sha(i + 1)}.mp3`, durationMs: i === 0 ? null : 45_000,
      source: "human", provenance: null, status: "published", createdAt: at, updatedAt: at,
    }],
  })),
});
await Bun.write(new URL("./sample.grandtour.json", import.meta.url), `${JSON.stringify(bundle, null, 2)}\n`);
console.log(`wrote sample.grandtour.json (${bundle.spots.length} spots)`);
