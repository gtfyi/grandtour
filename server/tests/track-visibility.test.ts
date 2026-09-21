/**
 * Track visibility: holding a finished track back from the public API without
 * unpublishing anything inside it.
 *
 * The property that matters is the second half — a hold must be lossless, so
 * releasing is a single flip rather than a reconstruction of what used to be
 * published. These tests pin both halves: every public surface hides a held
 * track, and nothing inside it moves.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { adminHeaders, makeContent, makeFillInItem, makeSpot, makeTrack, resetDb, testSql } from "./helpers";
import app from "../src/index";

const AT = { lat: 40.70611, lng: -73.99653 };

const hold = (id: string, holdReason = "Rights review pending") =>
  app.fetch(
    new Request(`http://localhost/api/admin/tracks/${id}/visibility`, {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({ visibility: "private", holdReason }),
    }),
  );

const release = (id: string) =>
  app.fetch(
    new Request(`http://localhost/api/admin/tracks/${id}/visibility`, {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({ visibility: "public" }),
    }),
  );

const nearby = (extra: Record<string, string | number> = {}) => {
  const qs = new URLSearchParams(
    Object.fromEntries(
      Object.entries({ lat: AT.lat, lng: AT.lng, radiusM: 500, ...extra }).map(([k, v]) => [
        k,
        String(v),
      ]),
    ),
  );
  return app.fetch(new Request(`http://localhost/api/nearby?${qs}`));
};

beforeEach(resetDb);

describe("holding a track back", () => {
  test("hides it from every public surface but not from the admin", async () => {
    const track = await makeTrack({ slug: "held-tour" });
    const spot = await makeSpot(track.id);
    await makeContent(spot.id);
    const open = await makeTrack({ slug: "open-tour" });
    const openSpot = await makeSpot(open.id);
    await makeContent(openSpot.id);

    expect((await hold(track.id)).status).toBe(200);

    const catalog = await (await app.fetch(new Request("http://localhost/api/tracks"))).json();
    expect(catalog.tracks.map((t: any) => t.slug)).toEqual(["open-tour"]);

    const near = await (await nearby()).json();
    expect(near.spots.map((s: any) => s.spot.id)).toEqual([openSpot.id]);

    const manifest = await (
      await app.fetch(new Request("http://localhost/api/track-manifest"))
    ).json();
    expect(manifest.tracks.map((t: any) => t.slug)).toEqual(["open-tour"]);

    const bundle = await app.fetch(new Request(`http://localhost/api/tracks/${track.id}/bundle`));
    expect(bundle.status).toBe(404);

    // The author must keep full sight of what they are holding.
    const admin = await (
      await app.fetch(new Request("http://localhost/api/admin/tracks", { headers: adminHeaders }))
    ).json();
    const held = admin.tracks.find((t: any) => t.slug === "held-tour");
    expect(held.visibility).toBe("private");
    expect(held.holdReason).toBe("Rights review pending");
    expect(held.heldAt).toBeTruthy();
    const adminBundle = await app.fetch(
      new Request(`http://localhost/api/admin/tracks/${track.id}/export`, { headers: adminHeaders }),
    );
    expect(adminBundle.status).toBe(200);
  });

  test("is lossless: no spot or content status changes", async () => {
    const track = await makeTrack();
    const published = await makeSpot(track.id);
    await makeContent(published.id);
    const draft = await makeSpot(track.id, { status: "draft" });
    await makeContent(draft.id, { status: "review" });

    const before = await testSql`
      SELECT s.id, s.status AS spot_status, c.status AS content_status
      FROM spots s JOIN content_pieces c ON c.spot_id = s.id
      WHERE s.track_id = ${track.id} ORDER BY s.id
    `;

    await hold(track.id);
    await release(track.id);

    const after = await testSql`
      SELECT s.id, s.status AS spot_status, c.status AS content_status
      FROM spots s JOIN content_pieces c ON c.spot_id = s.id
      WHERE s.track_id = ${track.id} ORDER BY s.id
    `;
    expect(after).toEqual(before);

    // And the round trip actually restores public visibility.
    const near = await (await nearby()).json();
    expect(near.spots.map((s: any) => s.spot.id)).toEqual([published.id]);
  });

  test("the unchanged-poll gate agrees with the full query", async () => {
    // If dataVersion still saw a held track, the gate would report a change
    // for content /nearby will not return — or worse, hide a real one.
    const track = await makeTrack();
    const spot = await makeSpot(track.id);
    await makeContent(spot.id);

    const first = await (await nearby()).json();
    expect(first.dataVersion).toBeTruthy();

    await hold(track.id);

    const held = await (await nearby()).json();
    expect(held.spots).toEqual([]);
    expect(held.dataVersion).toBeNull();

    // A stale version from before the hold must not resurrect it.
    const polled = await (await nearby({ changedSince: first.dataVersion })).json();
    expect(polled.spots ?? []).toEqual([]);
  });

  test("hides a held fill-in track's items", async () => {
    const track = await makeTrack({ slug: "held-vocab", kind: "fillin" });
    await makeFillInItem(track.id);
    await hold(track.id);

    const res = await app.fetch(
      new Request("http://localhost/api/fillin-items?tracks=held-vocab"),
    );
    const body = await res.json();
    expect(body.items).toEqual([]);
  });

  test("keeps a held track out of route prefetch", async () => {
    const held = await makeTrack();
    const heldSpot = await makeSpot(held.id, { lat: AT.lat, lng: AT.lng });
    await makeContent(heldSpot.id);
    // A control on the same corridor, so an empty result can't pass vacuously.
    const open = await makeTrack();
    const openSpot = await makeSpot(open.id, { title: "Open", lat: AT.lat, lng: AT.lng });
    await makeContent(openSpot.id);
    await hold(held.id);

    const res = await app.fetch(
      new Request("http://localhost/api/route-nearby", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          points: [
            { lat: AT.lat - 0.01, lng: AT.lng },
            { lat: AT.lat + 0.01, lng: AT.lng },
          ],
          corridorM: 500,
        }),
      }),
    );
    expect(res.status).toBe(200);
    const { spots } = await res.json();
    expect(spots.map((s: any) => s.spot.id)).toEqual([openSpot.id]);
  });
});

describe("the hold record", () => {
  test("requires a reason, and clears it on release", async () => {
    const track = await makeTrack();

    const noReason = await app.fetch(
      new Request(`http://localhost/api/admin/tracks/${track.id}/visibility`, {
        method: "PATCH",
        headers: adminHeaders,
        body: JSON.stringify({ visibility: "private" }),
      }),
    );
    expect(noReason.status).toBe(400);

    await hold(track.id, "Point Reyes Light rights unresolved");
    const [rowHeld] = await testSql`SELECT * FROM tracks WHERE id = ${track.id}`;
    expect(rowHeld!.visibility).toBe("private");
    expect(rowHeld!.hold_reason).toBe("Point Reyes Light rights unresolved");
    expect(rowHeld!.held_at).toBeTruthy();

    await release(track.id);
    const [rowOpen] = await testSql`SELECT * FROM tracks WHERE id = ${track.id}`;
    expect(rowOpen!.visibility).toBe("public");
    expect(rowOpen!.hold_reason).toBeNull();
    expect(rowOpen!.held_at).toBeNull();
  });

  test("the database refuses a held row with no reason", async () => {
    const track = await makeTrack();
    // try/catch rather than expect().rejects: a postgres.js query is a lazy
    // thenable, and handing it to .rejects hangs instead of settling.
    let threw = false;
    try {
      await testSql`UPDATE tracks SET visibility = 'private' WHERE id = ${track.id}`;
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
