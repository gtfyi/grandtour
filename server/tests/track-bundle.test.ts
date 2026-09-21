import { beforeEach, describe, expect, test } from "bun:test";
import { TrackExport } from "@grandtour/shared";
import { makeContent, makeFillInItem, makeSpot, makeTrack, resetDb, testSql } from "./helpers";
import app from "../src/index";

const getBundle = (id: string) => app.fetch(new Request(`http://localhost/api/tracks/${id}/bundle`));
beforeEach(resetDb);

describe("public track bundles", () => {
  test("serves only the selected track's published spots and content without admin credentials", async () => {
    const track = await makeTrack();
    const published = await makeSpot(track.id);
    const content = await makeContent(published.id);
    await makeContent(published.id, { status: "draft", variant: "draft" });
    await makeContent(published.id, { status: "review", variant: "review" });
    const draft = await makeSpot(track.id, { status: "draft" });
    await makeContent(draft.id);
    await makeSpot(track.id, { status: "review" });
    const other = await makeTrack();
    await makeSpot(other.id);
    const res = await getBundle(track.id);
    expect(res.status).toBe(200);
    const bundle = TrackExport.parse(await res.json());
    expect(bundle.track.id).toBe(track.id);
    expect(bundle.spots.map((s) => s.spot.id)).toEqual([published.id]);
    expect(bundle.spots[0]!.content.map((c) => c.id)).toEqual([content.id]);
  });

  test("returns an empty bundle for a track with no published spots", async () => {
    const track = await makeTrack();
    await makeSpot(track.id, { status: "draft" });
    const res = await getBundle(track.id);
    expect(res.status).toBe(200);
    expect((await res.json()).spots).toEqual([]);
  });

  test("does not truncate a track beyond 1,000 spots", async () => {
    const track = await makeTrack();
    await testSql`
      INSERT INTO spots (track_id, slug, title, trigger_kind, center, radius_m, status)
      SELECT ${track.id}, 'spot-' || n, 'Spot ' || n, 'point',
             ST_SetSRID(ST_MakePoint(-122.59, 37.98), 4326)::geography, 100, 'published'
      FROM generate_series(1, 1001) AS n
    `;
    const res = await getBundle(track.id);
    expect(res.status).toBe(200);
    expect((await res.json()).spots).toHaveLength(1001);
  });

  test("exports every published fill-in item in stable order with its audio", async () => {
    const track = await makeTrack({ kind: "fillin" });
    const second = await makeFillInItem(track.id, {
      order: 2, audioUrl: "http://localhost:8787/uploads/second.mp3",
    });
    const first = await makeFillInItem(track.id, {
      order: 1, audioUrl: "http://localhost:8787/uploads/first.mp3",
    });
    const unordered = await makeFillInItem(track.id);
    await makeFillInItem(track.id, { status: "draft" });
    await makeFillInItem(track.id, { status: "review" });
    const other = await makeTrack({ kind: "fillin" });
    await makeFillInItem(other.id);

    const res = await getBundle(track.id);
    expect(res.status).toBe(200);
    const bundle = TrackExport.parse(await res.json());
    expect(bundle.track.itemCount).toBe(3);
    expect(bundle.spots).toEqual([]);
    expect(bundle.fillInItems?.map((item) => item.id)).toEqual([
      first.id, second.id, unordered.id,
    ]);
    // Recordings are served from the host the request arrived at, never the
    // generation-time host.
    expect(bundle.fillInItems?.map((item) => item.content?.audioUrl ?? null)).toEqual([
      "http://localhost/uploads/first.mp3", "http://localhost/uploads/second.mp3", null,
    ]);
  });

  test("does not sample or truncate fill-in downloads at the live endpoint's 2,000-item cap", async () => {
    const track = await makeTrack({ kind: "fillin" });
    const payload = {
      word: "complete",
      senses: [{ definition: "Entire", exampleSentence: "The track is complete." }],
      source: { title: "Test list", url: "https://example.com/vocab" },
    };
    await testSql`
      INSERT INTO fillin_items (track_id, module_type, payload, sort_order, status, audio_url)
      SELECT ${track.id}, 'vocab', ${testSql.json(payload)}, n, 'published',
             'http://localhost:8787/uploads/item-' || n || '.mp3'
      FROM generate_series(1, 2001) AS n
    `;

    const res = await getBundle(track.id);
    expect(res.status).toBe(200);
    const bundle = TrackExport.parse(await res.json());
    expect(bundle.track.itemCount).toBe(2001);
    expect(bundle.fillInItems).toHaveLength(2001);
    expect(bundle.fillInItems?.[0]?.order).toBe(1);
    expect(bundle.fillInItems?.[2000]?.order).toBe(2001);
  });

  test("returns 400 for invalid IDs and 404 for missing tracks", async () => {
    expect((await getBundle("invalid")).status).toBe(400);
    expect((await getBundle(crypto.randomUUID())).status).toBe(404);
  });
});
