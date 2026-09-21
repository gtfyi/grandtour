/**
 * The distribution protocol served live: the authoring server is a
 * GrandTour server like any static host, and must show exactly what the
 * public index would — held tracks absent, audio served from this host.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { Index, TrackExport } from "@grandtour/shared";
import { makeContent, makeSpot, makeTrack, resetDb, testSql } from "./helpers";
import app from "../src/index";

const get = (path: string, origin = "http://tailnet.example:8787") => app.fetch(new Request(`${origin}${path}`));
beforeEach(resetDb);

describe("GET /grandtour.json", () => {
  test("indexes public tour tracks with voiced spots, and nothing else", async () => {
    const live = await makeTrack({ slug: "marin-history", name: "History", official: true });
    const spot = await makeSpot(live.id, { lat: 37.98, lng: -122.59 });
    await makeContent(spot.id, { audioUrl: "http://localhost:8787/uploads/narration_voiced.mp3" });
    const held = await makeTrack({ slug: "held" });
    const heldSpot = await makeSpot(held.id);
    await makeContent(heldSpot.id, { audioUrl: "http://localhost:8787/uploads/held.mp3" });
    await testSql`UPDATE tracks SET visibility='private', hold_reason='test', held_at=now() WHERE id=${held.id}`;

    const res = await get("/grandtour.json");
    expect(res.status).toBe(200);
    const index = Index.parse(await res.json());
    expect(index.tracks.map((t) => t.slug)).toEqual(["marin-history"]);
    expect(index.tracks[0]!.url).toBe("tours/marin-history.grandtour.json");
    expect(index.tracks[0]!.areas).toHaveLength(1);
    expect(JSON.stringify(index)).not.toContain("visibility");
  });

  test("is readable from any origin", async () => {
    const res = await app.fetch(new Request("http://localhost/grandtour.json", { headers: { Origin: "https://example.org" } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("recordings are served from the host a request arrived at", () => {
  test("/api/nearby rehosts /uploads/ URLs and leaves external ones alone", async () => {
    const track = await makeTrack();
    const ours = await makeSpot(track.id);
    await makeContent(ours.id, { audioUrl: "http://localhost:8787/uploads/take.m4a" });
    const theirs = await makeSpot(track.id, { lat: 40.7062, lng: -73.9966 });
    await makeContent(theirs.id, { audioUrl: "https://www.nps.gov/audio/stop-01.mp3" });
    const res = await get("/api/nearby?lat=40.70611&lng=-73.99653&radiusM=2000");
    expect(res.status).toBe(200);
    const urls = ((await res.json()).spots as Array<{ content: { audioUrl: string } | null }>).map((s) => s.content?.audioUrl).sort();
    expect(urls).toEqual(["http://tailnet.example:8787/uploads/take.m4a", "https://www.nps.gov/audio/stop-01.mp3"]);
  });
});

describe("GET /tours/:slug.grandtour.json", () => {
  test("serves the bundle with recordings rehosted to the requesting origin", async () => {
    const live = await makeTrack({ slug: "marin-history" });
    const spot = await makeSpot(live.id);
    await makeContent(spot.id, { audioUrl: "http://localhost:8787/uploads/narration_voiced.mp3" });
    const silent = await makeSpot(live.id);
    await makeContent(silent.id, { audioUrl: null });

    const res = await get("/tours/marin-history.grandtour.json");
    expect(res.status).toBe(200);
    const bundle = TrackExport.parse(await res.json());
    expect(bundle.formatVersion).toBe(1);
    expect(bundle.spots.map((s) => s.spot.id)).toEqual([spot.id]);
    expect(bundle.spots[0]!.content[0]!.audioUrl).toBe("http://tailnet.example:8787/uploads/narration_voiced.mp3");
  });

  test("a held or unknown track is not found, and a non-bundle name is not a route", async () => {
    const held = await makeTrack({ slug: "held" });
    const spot = await makeSpot(held.id);
    await makeContent(spot.id);
    await testSql`UPDATE tracks SET visibility='private', hold_reason='test', held_at=now() WHERE id=${held.id}`;
    expect((await get("/tours/held.grandtour.json")).status).toBe(404);
    expect((await get("/tours/nope.grandtour.json")).status).toBe(404);
    expect((await get("/tours/held")).status).toBe(404);
  });
});
