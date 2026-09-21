import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { adminHeaders, assertTestDb, makeTrack, resetDb } from "./helpers";
import app from "../src/index";

function req(path: string, init: RequestInit = {}) {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      ...init,
      headers: { ...adminHeaders, ...(init.headers ?? {}) },
    }),
  );
}

const TRIGGER = {
  center: { lat: 44.4142, lng: -68.585 },
  radiusM: 150,
  region: [
    { lat: 44.413, lng: -68.586 },
    { lat: 44.413, lng: -68.584 },
    { lat: 44.4155, lng: -68.584 },
  ],
};

beforeAll(() => {
  // admin-auth.test.ts toggles this; make sure it's set for this file.
  process.env.ADMIN_TOKEN = "test-token";
});

beforeEach(async () => {
  await resetDb();
});

describe("test-db safety guard", () => {
  test("refuses to operate on a database whose name lacks the _test suffix", () => {
    expect(() =>
      assertTestDb("postgres://postgres:postgres@localhost:5432/grandtour"),
    ).toThrow(/non-test database/);
  });
});

describe("admin CRUD routes", () => {
  test("creates a track and lists it back", async () => {
    const create = await req("/api/admin/tracks", {
      method: "POST",
      body: JSON.stringify({ slug: "walking-tours", name: "Walking Tours" }),
    });
    expect(create.status).toBe(201);
    const list = await (await req("/api/admin/tracks")).json();
    expect(list.tracks.map((l: any) => l.slug)).toContain("walking-tours");
  });

  test("rejects an invalid track slug with 400", async () => {
    const res = await req("/api/admin/tracks", {
      method: "POST",
      body: JSON.stringify({ slug: "Bad Slug!", name: "Nope" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_body");
  });

  test("creates a draft spot; it appears in the admin list and round-trips its trigger", async () => {
    const track = await makeTrack();
    const create = await req("/api/admin/spots", {
      method: "POST",
      body: JSON.stringify({ trackId: track.id, title: "Blue Hill Overlook", trigger: TRIGGER }),
    });
    expect(create.status).toBe(201);
    const { spot } = await create.json();
    expect(spot.status).toBe("draft");

    const { spots } = await (await req("/api/admin/spots")).json();
    expect(spots.map((s: any) => s.id)).toContain(spot.id);

    const detail = await (await req(`/api/admin/spots/${spot.id}`)).json();
    expect(detail.spot.trigger.center.lat).toBeCloseTo(TRIGGER.center.lat, 5);
    expect(detail.spot.trigger.center.lng).toBeCloseTo(TRIGGER.center.lng, 5);
    expect(detail.spot.trigger.radiusM).toBe(150);
    // PostGIS returns the ring closed, so expect at least the input vertices.
    expect(detail.spot.trigger.region.length).toBeGreaterThanOrEqual(3);
    expect(detail.spot.trigger.region[0].lat).toBeCloseTo(TRIGGER.region[0]!.lat, 5);
  });

  test("updating a missing spot returns 404", async () => {
    const track = await makeTrack();
    const res = await req("/api/admin/spots/00000000-0000-0000-0000-000000000000", {
      method: "PUT",
      body: JSON.stringify({ trackId: track.id, title: "Ghost", trigger: TRIGGER }),
    });
    expect(res.status).toBe(404);
  });

  test("content upsert is idempotent on (spot, locale, variant)", async () => {
    const track = await makeTrack();
    const spotRes = await req("/api/admin/spots", {
      method: "POST",
      body: JSON.stringify({ trackId: track.id, title: "Upsertable", trigger: TRIGGER }),
    });
    const { spot } = await spotRes.json();

    const body = (text: string) =>
      JSON.stringify({
        spotId: spot.id,
        source: "human",
        document: { id: `doc_${spot.id}`, text, byteLength: text.length, metadata: {}, tiers: [] },
      });
    const first = await req("/api/admin/content", { method: "PUT", body: body("v1") });
    expect(first.status).toBe(200);
    await req("/api/admin/content", { method: "PUT", body: body("v2") });

    const detail = await (await req(`/api/admin/spots/${spot.id}`)).json();
    expect(detail.content.length).toBe(1);
    expect(detail.content[0].document.text).toBe("v2");
  });

  test("status endpoint accepts enum values and rejects garbage", async () => {
    const track = await makeTrack();
    const { spot } = await (
      await req("/api/admin/spots", {
        method: "POST",
        body: JSON.stringify({ trackId: track.id, title: "Status spot", trigger: TRIGGER }),
      })
    ).json();
    const { content } = await (
      await req("/api/admin/content", {
        method: "PUT",
        body: JSON.stringify({ spotId: spot.id, source: "human" }),
      })
    ).json();

    const ok = await req(`/api/admin/content/${content.id}/status`, {
      method: "POST",
      body: JSON.stringify({ status: "published" }),
    });
    expect(ok.status).toBe(200);
    expect((await ok.json()).content.status).toBe("published");

    const bad = await req(`/api/admin/content/${content.id}/status`, {
      method: "POST",
      body: JSON.stringify({ status: "bogus" }),
    });
    expect(bad.status).toBe(400);
  });

  test("spots get URL slugs, deduped within the track", async () => {
    const track = await makeTrack();
    const make = () =>
      req("/api/admin/spots", {
        method: "POST",
        body: JSON.stringify({ trackId: track.id, title: "Café de l'Église!", trigger: TRIGGER }),
      });
    const first = await (await make()).json();
    const second = await (await make()).json();
    expect(first.spot.slug).toBe("cafe-de-l-eglise");
    expect(second.spot.slug).toBe("cafe-de-l-eglise-2");
  });

  test("deletes a spot and 404s a second delete", async () => {
    const track = await makeTrack();
    const { spot } = await (
      await req("/api/admin/spots", {
        method: "POST",
        body: JSON.stringify({ trackId: track.id, title: "Doomed", trigger: TRIGGER }),
      })
    ).json();

    const del = await req(`/api/admin/spots/${spot.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect((await del.json()).ok).toBe(true);

    const gone = await req(`/api/admin/spots/${spot.id}`);
    expect(gone.status).toBe(404);

    const again = await req(`/api/admin/spots/${spot.id}`, { method: "DELETE" });
    expect(again.status).toBe(404);
  });

  test("the spot list filters by trackId", async () => {
    const a = await makeTrack();
    const b = await makeTrack();
    await req("/api/admin/spots", {
      method: "POST",
      body: JSON.stringify({ trackId: a.id, title: "In A", trigger: TRIGGER }),
    });
    await req("/api/admin/spots", {
      method: "POST",
      body: JSON.stringify({ trackId: b.id, title: "In B", trigger: TRIGGER }),
    });
    const { spots } = await (await req(`/api/admin/spots?trackId=${a.id}`)).json();
    expect(spots.length).toBe(1);
    expect(spots[0].title).toBe("In A");
  });

  test("identify validates coordinates before calling external services", async () => {
    const res = await req("/api/admin/identify?lat=999&lng=0");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_query");
  });

  test("generate on a missing spot returns 404 without calling external APIs", async () => {
    const res = await req("/api/admin/spots/00000000-0000-0000-0000-000000000000/generate", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  test("a wrong bearer token is rejected on every admin route", async () => {
    const res = await app.fetch(
      new Request("http://localhost/api/admin/spots", {
        headers: { Authorization: "Bearer wrong", "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(401);
  });
});
