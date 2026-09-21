/**
 * The distribution index is a public surface: it must carry exactly the
 * tracks the public API would, so a held track vanishes from every client
 * in the same flip that hides it from /api/tracks.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { TrackExport } from "@grandtour/shared";
import { makeContent, makeFillInItem, makeSpot, makeTrack, resetDb, testSql } from "./helpers";
import { buildIndexFromDb } from "../src/content/distribution";
import { sql } from "../src/db";

beforeEach(resetDb);

describe("buildIndexFromDb", () => {
  test("lists public tour tracks with published spots, and nothing else", async () => {
    const live = await makeTrack({ slug: "marin-history", name: "History", official: true });
    const voiced = await makeSpot(live.id, { lat: 37.98, lng: -122.59 });
    await makeContent(voiced.id, { audioUrl: "http://localhost:8787/uploads/narration_voiced.mp3" });
    const silent = await makeSpot(live.id, { lat: 37.99, lng: -122.6 });
    await makeContent(silent.id, { audioUrl: null });
    await makeSpot(live.id, { status: "draft" });

    const held = await makeTrack({ slug: "held" });
    const heldSpot = await makeSpot(held.id);
    await makeContent(heldSpot.id);
    await testSql`UPDATE tracks SET visibility='private', hold_reason='test', held_at=now() WHERE id=${held.id}`;

    const empty = await makeTrack({ slug: "drafts-only" });
    await makeSpot(empty.id, { status: "draft" });

    const fillin = await makeTrack({ slug: "vocab", kind: "fillin" });
    await makeFillInItem(fillin.id);

    const { index: catalog, bundles } = await buildIndexFromDb(sql);
    expect(catalog.tracks.map((t) => t.slug)).toEqual(["marin-history"]);
    expect([...bundles.keys()]).toEqual(["marin-history"]);

    const entry = catalog.tracks[0]!;
    // The silent spot is published, but the app is voiced-only (C1).
    expect(entry.spotCount).toBe(1);
    expect(entry.voicedCount).toBe(1);
    expect(entry.url).toBe("tours/marin-history.grandtour.json");
    expect(entry.id).toBe(live.id);
    expect(entry.areas).toHaveLength(1);
    expect(entry.center.lat).toBeCloseTo(37.98, 3);
    expect(entry.spanKm).toBe(0);

    // The bundle is the same shape the viewer already validates.
    const bundle = TrackExport.parse(bundles.get("marin-history"));
    expect(bundle.spots.map((s) => s.spot.id)).toEqual([voiced.id]);
    expect(silent.id).not.toBe(voiced.id);
  });

  test("appends pre-built bundles without duplicating a database track", async () => {
    const live = await makeTrack({ slug: "marin-history", name: "Marin" });
    const spot = await makeSpot(live.id);
    await makeContent(spot.id, { audioUrl: "http://localhost:8787/uploads/narration_a.mp3" });
    const { bundles: db } = await buildIndexFromDb(sql);
    const prebuilt = db.get("marin-history")!;

    const glacier: TrackExport = {
      ...prebuilt,
      track: { ...prebuilt.track, id: "00000000-0000-4000-8000-000000000001", slug: "glacier", name: "Glacier", official: false },
    };
    const { index: catalog } = await buildIndexFromDb(sql, { extra: [glacier, prebuilt] });
    // Sorted by name (official first); the duplicate pre-built copy is dropped.
    expect(catalog.tracks.map((t) => t.slug)).toEqual(["glacier", "marin-history"]);
  });
});
