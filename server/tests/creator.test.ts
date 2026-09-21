import { beforeEach, describe, expect, test } from "bun:test";
import { makeTrack, resetDb, testSql } from "./helpers";
import app from "../src/index";

function req(path: string, init: RequestInit = {}) {
  return app.fetch(new Request(`http://localhost${path}`, init));
}

function postJson(path: string, body: unknown) {
  return req(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** A tiny fake m4a: content doesn't matter, the route stores bytes opaquely. */
function makeRecordingForm(meta: Record<string, unknown>): FormData {
  const form = new FormData();
  form.set("meta", JSON.stringify(meta));
  form.set(
    "audio",
    new File([new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])], "take.m4a", {
      type: "audio/mp4",
    }),
  );
  return form;
}

const META = {
  title: "The Old Mill",
  lat: 37.987,
  lng: -122.589,
  durationMs: 12_500,
  recordedAt: "2026-09-08T17:00:00.000Z",
  courseDeg: 270,
  speedMps: 1.4,
  horizontalAccuracyM: 5,
};

beforeEach(async () => {
  await resetDb();
});

describe("creator tracks", () => {
  test("advertises durable recording uploads", async () => {
    const res = await req("/api/creator/capabilities");
    expect(await res.json()).toEqual({ recording: true, idempotency: true });
  });

  test("replays concurrent track retries without creating duplicates", async () => {
    const body = { name: "Offline walk", clientId: crypto.randomUUID() };
    const responses = await Promise.all(Array.from({ length: 3 }, () => postJson("/api/creator/tracks", body)));
    expect(responses.map((r) => r.status)).toEqual([201, 201, 201]);
    const tracks = await Promise.all(responses.map(async (r) => (await r.json()).track));
    expect(new Set(tracks.map((t) => t.id)).size).toBe(1);
    expect(await testSql`SELECT id FROM tracks`).toHaveLength(1);
    const conflict = await postJson("/api/creator/tracks", { ...body, name: "Different walk" });
    expect(conflict.status).toBe(409);
  });

  test("creates a track from a name, slugified and non-official", async () => {
    const res = await postJson("/api/creator/tracks", { name: "Russ's Mill Valley Walk" });
    expect(res.status).toBe(201);
    const { track } = await res.json();
    expect(track.slug).toBe("russ-s-mill-valley-walk");
    expect(track.name).toBe("Russ's Mill Valley Walk");
    expect(track.official).toBe(false);
    expect(track.kind).toBe("tour");
  });

  test("uniques colliding slugs", async () => {
    const first = await postJson("/api/creator/tracks", { name: "My Walk" });
    const second = await postJson("/api/creator/tracks", { name: "My walk" });
    const a = (await first.json()).track.slug;
    const b = (await second.json()).track.slug;
    expect(a).toBe("my-walk");
    expect(b).toBe("my-walk-2");
  });

  test("rejects an empty name", async () => {
    const res = await postJson("/api/creator/tracks", { name: "  " });
    expect(res.status).toBe(400);
  });
});

describe("creator spots (walk and record)", () => {
  test("a failed narration write rolls back its spot and allows a clean retry", async () => {
    const track = await makeTrack();
    const meta = { ...META, trackId: track.id, clientId: crypto.randomUUID() };
    await testSql.unsafe(`
      CREATE FUNCTION reject_creator_test_content() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'simulated narration write failure'; END $$;
      CREATE TRIGGER reject_creator_test_content BEFORE INSERT ON content_pieces
      FOR EACH ROW EXECUTE FUNCTION reject_creator_test_content();
    `);
    try {
      const failed = await req("/api/creator/spots", { method: "POST", body: makeRecordingForm(meta) });
      expect(failed.status).toBe(500);
      expect(await testSql`SELECT id FROM spots`).toHaveLength(0);
      expect(await testSql`SELECT client_id FROM creator_uploads`).toHaveLength(0);
    } finally {
      await testSql.unsafe(`DROP TRIGGER reject_creator_test_content ON content_pieces;
                           DROP FUNCTION reject_creator_test_content();`);
    }
    const retried = await req("/api/creator/spots", { method: "POST", body: makeRecordingForm(meta) });
    expect(retried.status).toBe(201);
    expect(await testSql`SELECT id FROM spots`).toHaveLength(1);
    expect(await testSql`SELECT id FROM content_pieces`).toHaveLength(1);
  });

  test("replays spot uploads and commits one spot, narration and receipt", async () => {
    const track = await makeTrack();
    const meta = { ...META, trackId: track.id, clientId: crypto.randomUUID() };
    const send = () => req("/api/creator/spots", { method: "POST", body: makeRecordingForm(meta) });
    const responses = await Promise.all([send(), send(), send()]);
    expect(responses.map((r) => r.status)).toEqual([201, 201, 201]);
    const results = await Promise.all(responses.map((r) => r.json()));
    expect(new Set(results.map((r) => r.spot.id)).size).toBe(1);
    expect(new Set(results.map((r) => r.content.id)).size).toBe(1);
    expect(await testSql`SELECT id FROM spots`).toHaveLength(1);
    expect(await testSql`SELECT id FROM content_pieces`).toHaveLength(1);
    expect(await testSql`SELECT client_id FROM creator_uploads WHERE operation = 'spot'`).toHaveLength(1);
    const conflict = await req("/api/creator/spots", {
      method: "POST", body: makeRecordingForm({ ...meta, title: "Different title" }),
    });
    expect(conflict.status).toBe(409);
  });

  test("stores the recording and publishes spot + human content immediately", async () => {
    const track = await makeTrack();
    const res = await req("/api/creator/spots", {
      method: "POST",
      body: makeRecordingForm({ ...META, trackId: track.id }),
    });
    expect(res.status).toBe(201);
    const { spot, content } = await res.json();

    expect(spot.status).toBe("published");
    expect(spot.trigger.kind).toBe("point");
    expect(spot.trigger.center.lat).toBeCloseTo(META.lat, 5);
    expect(spot.trigger.radiusM).toBe(40); // walking-scale default
    expect(spot.locating.mode).toBe("none");

    expect(content.status).toBe("published");
    expect(content.source).toBe("human");
    expect(content.document).toBeNull();
    expect(content.durationMs).toBe(12_500);
    expect(content.audioUrl).toContain("/uploads/");
    expect(content.provenance.capture.courseDeg).toBe(270);

    // The whole point: the recording is already live on /nearby.
    const nearby = await req(
      `/api/nearby?lat=${META.lat}&lng=${META.lng}&radiusM=500`,
    );
    const { spots } = await nearby.json();
    expect(spots).toHaveLength(1);
    expect(spots[0].spot.id).toBe(spot.id);
    expect(spots[0].triggered).toBe(true);
    // Served from the requesting host (rehosted), same recording.
    expect(new URL(spots[0].content.audioUrl).pathname).toBe(new URL(content.audioUrl).pathname);
  });

  test("the stored audio is served back through /uploads", async () => {
    const track = await makeTrack();
    const res = await req("/api/creator/spots", {
      method: "POST",
      body: makeRecordingForm({ ...META, trackId: track.id }),
    });
    const { content } = await res.json();
    const audioPath = new URL(content.audioUrl).pathname;
    const audio = await req(audioPath);
    expect(audio.status).toBe(200);
    expect((await audio.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  test("rejects a missing audio part", async () => {
    const track = await makeTrack();
    const form = new FormData();
    form.set("meta", JSON.stringify({ ...META, trackId: track.id }));
    const res = await req("/api/creator/spots", { method: "POST", body: form });
    expect(res.status).toBe(400);
    expect((await res.json()).detail).toContain("audio");
  });

  test("rejects an unsupported audio type", async () => {
    const track = await makeTrack();
    const form = new FormData();
    form.set("meta", JSON.stringify({ ...META, trackId: track.id }));
    form.set("audio", new File([new Uint8Array([1])], "notes.txt", { type: "text/plain" }));
    const res = await req("/api/creator/spots", { method: "POST", body: form });
    expect(res.status).toBe(400);
    expect((await res.json()).detail).toContain("unsupported audio type");
  });

  test("rejects an unknown track and fill-in tracks", async () => {
    const missing = await req("/api/creator/spots", {
      method: "POST",
      body: makeRecordingForm({ ...META, trackId: crypto.randomUUID() }),
    });
    expect(missing.status).toBe(404);

    const fillin = await makeTrack({ kind: "fillin" });
    const wrongKind = await req("/api/creator/spots", {
      method: "POST",
      body: makeRecordingForm({ ...META, trackId: fillin.id }),
    });
    expect(wrongKind.status).toBe(400);
  });

  test("lists a track's spots and deletes a fumbled take", async () => {
    const track = await makeTrack();
    const created = await req("/api/creator/spots", {
      method: "POST",
      body: makeRecordingForm({ ...META, trackId: track.id }),
    });
    const { spot } = await created.json();

    const list = await req(`/api/creator/spots?trackId=${track.id}`);
    expect((await list.json()).spots).toHaveLength(1);

    const del = await req(`/api/creator/spots/${spot.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    const [orphan] = await testSql`SELECT id FROM content_pieces WHERE spot_id = ${spot.id}`;
    expect(orphan).toBeUndefined(); // content cascades with the spot

    const after = await req(`/api/creator/spots?trackId=${track.id}`);
    expect((await after.json()).spots).toHaveLength(0);
  });
});
