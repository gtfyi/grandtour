import { beforeEach, describe, expect, test } from "bun:test";
import { makeContent, makeTrack, makeSpot, resetDb } from "./helpers";
import app from "../src/index";

// Query point ≈ Brooklyn Bridge; helpers' default spot center is the same.
const AT = { lat: 40.70611, lng: -73.99653 };
// ~500m north of AT.
const NEAR = { lat: 40.71061, lng: -73.99653 };
// ~1 degree away (~111 km).
const FAR = { lat: 41.70611, lng: -73.99653 };

function nearby(params: Record<string, string | number>) {
  const qs = new URLSearchParams(
    Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
  );
  return app.fetch(new Request(`http://localhost/api/nearby?${qs}`));
}

beforeEach(async () => {
  await resetDb();
});

describe("/api/nearby geo semantics", () => {
  test("default phone request includes a regional track with more than fifty recordings", async () => {
    const track = await makeTrack({ slug: "regional-calls" });
    const ids = [];
    for (let i = 0; i < 68; i++) {
      const spot = await makeSpot(track.id, {
        triggerKind: "area",
        regionWkt: "SRID=4326;POLYGON((-74 40.70,-73.99 40.70,-73.99 40.71,-74 40.71,-74 40.70))",
        locating: { mode: "none", clips: {} },
      });
      await makeContent(spot.id, { audioUrl: `https://example.com/${i}.mp3` });
      ids.push(spot.id);
    }
    const response = await nearby({ ...AT, tracks: track.slug });
    expect(response.status).toBe(200);
    const { spots } = await response.json();
    expect(new Set(spots.map((s: any) => s.spot.id))).toEqual(new Set(ids));
    expect(spots.every((s: any) => s.triggered && s.content.audioUrl)).toBe(true);

    const limited = await (await nearby({ ...AT, tracks: track.slug, limit: 12 })).json();
    expect(limited.spots).toHaveLength(12);
    expect((await nearby({ ...AT, tracks: track.slug, limit: 201 })).status).toBe(400);
  });

  test("radius trigger: query at the spot center", async () => {
    const track = await makeTrack();
    await makeSpot(track.id, { radiusM: 100 });
    const res = await nearby({ ...AT, radiusM: 2000 });
    expect(res.status).toBe(200);
    const { spots } = await res.json();
    expect(spots.length).toBe(1);
    expect(spots[0].triggered).toBe(true);
    expect(spots[0].distanceM).toBeLessThan(1);
  });

  test("within outer cap but outside own radius: returned, not triggered", async () => {
    const track = await makeTrack();
    await makeSpot(track.id, { radiusM: 100 });
    const { spots } = await (await nearby({ ...NEAR, radiusM: 2000 })).json();
    expect(spots.length).toBe(1);
    expect(spots[0].triggered).toBe(false);
    expect(spots[0].distanceM).toBeGreaterThan(400);
  });

  test("outside the outer cap: not returned", async () => {
    const track = await makeTrack();
    await makeSpot(track.id);
    const { spots } = await (await nearby({ ...FAR, radiusM: 2000 })).json();
    expect(spots.length).toBe(0);
  });

  test("polygon trigger fires independently of the radius", async () => {
    const track = await makeTrack();
    // Tiny radius, but a region polygon around a point ~300m east of center.
    const east = { lat: 40.70611, lng: -73.9864 };
    await makeSpot(track.id, {
      radiusM: 10,
      regionWkt:
        "SRID=4326;POLYGON((-73.9880 40.6990, -73.9850 40.6990, -73.9850 40.7080, -73.9880 40.7080, -73.9880 40.6990))",
    });
    const { spots } = await (await nearby({ ...east, radiusM: 2000 })).json();
    expect(spots.length).toBe(1);
    expect(spots[0].triggered).toBe(true);
  });

  test("draft spots are invisible on the public API", async () => {
    const track = await makeTrack();
    await makeSpot(track.id, { status: "draft" });
    const { spots } = await (await nearby({ ...AT, radiusM: 2000 })).json();
    expect(spots.length).toBe(0);
  });

  test("track slug filter restricts results", async () => {
    const a = await makeTrack({ slug: "history-t" });
    const b = await makeTrack({ slug: "nature-t" });
    await makeSpot(a.id, { title: "A spot" });
    await makeSpot(b.id, { title: "B spot" });
    const { spots } = await (
      await nearby({ ...AT, radiusM: 2000, tracks: "history-t" })
    ).json();
    expect(spots.length).toBe(1);
    expect(spots[0].track.slug).toBe("history-t");
  });

  test("mode filter: empty modes match any mode; non-matching modes are hidden", async () => {
    const track = await makeTrack();
    await makeSpot(track.id, { title: "any-mode", modes: [] });
    await makeSpot(track.id, { title: "drive-only", modes: ["driving"] });
    const { spots } = await (
      await nearby({ ...AT, radiusM: 2000, mode: "walking" })
    ).json();
    expect(spots.map((s: any) => s.spot.title)).toEqual(["any-mode"]);
  });

  test("published content attaches; draft-only content yields null", async () => {
    const track = await makeTrack();
    const withPub = await makeSpot(track.id, { title: "with-pub" });
    const draftOnly = await makeSpot(track.id, { title: "draft-only" });
    const piece = await makeContent(withPub.id, { status: "published" });
    await makeContent(draftOnly.id, { status: "draft" });
    const { spots } = await (await nearby({ ...AT, radiusM: 2000 })).json();
    const byTitle = new Map(spots.map((s: any) => [s.spot.title, s]));
    expect((byTitle.get("with-pub") as any).content.id).toBe(piece.id);
    expect((byTitle.get("draft-only") as any).content).toBeNull();
  });

  test("locale selects the matching piece, falling back to any published one", async () => {
    const track = await makeTrack();
    const spot = await makeSpot(track.id);
    await makeContent(spot.id, { locale: "en" });
    const es = await makeContent(spot.id, { locale: "es" });

    const esRes = await (await nearby({ ...AT, radiusM: 2000, locale: "es" })).json();
    expect(esRes.spots[0].content.id).toBe(es.id);

    const defaultRes = await (await nearby({ ...AT, radiusM: 2000 })).json();
    expect(defaultRes.spots[0].content.locale).toBe("en");

    // No French piece: fall back to the most recently updated published piece.
    const frRes = await (await nearby({ ...AT, radiusM: 2000, locale: "fr" })).json();
    expect(frRes.spots[0].content).not.toBeNull();
  });

  test("locating resolves to the traveler's side, with clip audio when present", async () => {
    const track = await makeTrack();
    // Spot ~250m due EAST of the query point (azimuth ≈ 90°).
    await makeSpot(track.id, {
      lng: -73.99653 + 0.003,
      locating: {
        mode: "auto",
        clips: {
          left: { text: "Look to your left.", audioUrl: "https://cdn/loc-left.mp3", durationMs: 1500 },
          right: { text: "Look to your right.", audioUrl: "https://cdn/loc-right.mp3", durationMs: 1500 },
        },
      },
    });

    // Heading north: an eastern spot is on the right.
    const north = await (await nearby({ ...AT, radiusM: 2000, courseDeg: 0 })).json();
    expect(north.spots[0].locating).toEqual({
      text: "Look to your right.",
      audioUrl: "https://cdn/loc-right.mp3",
      durationMs: 1500,
    });

    // Heading south: same spot is on the left.
    const south = await (await nearby({ ...AT, radiusM: 2000, courseDeg: 180 })).json();
    expect(south.spots[0].locating.text).toBe("Look to your left.");
    expect(south.spots[0].locating.audioUrl).toBe("https://cdn/loc-left.mp3");

    // No course: a directional instruction can't pick a side — omit it.
    const noCourse = await (await nearby({ ...AT, radiusM: 2000 })).json();
    expect(noCourse.spots[0].locating).toBeNull();
  });

  test("locating: fixed custom templates ignore course; clip-less templates still carry text", async () => {
    const track = await makeTrack();
    await makeSpot(track.id, {
      title: "Fountain",
      locating: {
        mode: "custom",
        template: "Face the fountain in the plaza.",
        clips: { fixed: { text: "Face the fountain in the plaza.", audioUrl: "https://cdn/loc-fixed.mp3", durationMs: 2000 } },
      },
    });
    await makeSpot(track.id, { title: "Default auto, no clips yet", lng: -73.99653 + 0.001 });
    await makeSpot(track.id, { title: "Silent", lng: -73.99653 + 0.002, locating: { mode: "none", clips: {} } });

    const res = await (await nearby({ ...AT, radiusM: 2000, courseDeg: 0 })).json();
    const byTitle = new Map(res.spots.map((s: any) => [s.spot.title, s]));

    // Fixed template: same regardless of heading, audio attached.
    expect((byTitle.get("Fountain") as any).locating.text).toBe("Face the fountain in the plaza.");
    expect((byTitle.get("Fountain") as any).locating.audioUrl).toBe("https://cdn/loc-fixed.mp3");

    // Auto template without generated clips: text resolves, audio is null.
    const auto = (byTitle.get("Default auto, no clips yet") as any).locating;
    expect(auto.text).toBe("Look to your right.");
    expect(auto.audioUrl).toBeNull();

    // Mode none: no locating at all.
    expect((byTitle.get("Silent") as any).locating).toBeNull();
  });

  test("invalid coordinates are rejected with 400", async () => {
    const res = await nearby({ lat: 999, lng: 0 });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_query");
  });
});

describe("/api/nearby freshness gate (changedSince)", () => {
  test("response carries a dataVersion and is not 'unchanged' without changedSince", async () => {
    const track = await makeTrack();
    await makeSpot(track.id, { radiusM: 100 });
    const { spots, dataVersion, unchanged } = await (
      await nearby({ ...AT, radiusM: 2000 })
    ).json();
    expect(spots.length).toBe(1);
    expect(unchanged).toBe(false);
    expect(typeof dataVersion).toBe("string");
  });

  test("echoing dataVersion back returns unchanged with no spots", async () => {
    const track = await makeTrack();
    await makeSpot(track.id, { radiusM: 100 });
    const first = await (await nearby({ ...AT, radiusM: 2000 })).json();

    const second = await (
      await nearby({ ...AT, radiusM: 2000, changedSince: first.dataVersion })
    ).json();
    expect(second.unchanged).toBe(true);
    expect(second.spots).toEqual([]);
    // The version still comes back, so the client can keep polling with it.
    expect(second.dataVersion).toBe(first.dataVersion);
  });

  test("content published after the version busts the gate", async () => {
    const track = await makeTrack();
    const spot = await makeSpot(track.id, { radiusM: 100 });
    const first = await (await nearby({ ...AT, radiusM: 2000 })).json();

    // New narration for a spot the traveler is already standing in.
    await makeContent(spot.id, { audioUrl: "http://localhost:8787/uploads/a.mp3" });

    const second = await (
      await nearby({ ...AT, radiusM: 2000, changedSince: first.dataVersion })
    ).json();
    expect(second.unchanged).toBe(false);
    expect(second.spots.length).toBe(1);
    expect(second.spots[0].content?.audioUrl).toContain("a.mp3");
    expect(second.dataVersion > first.dataVersion).toBe(true);
  });

  test("an empty area reports a null version and still returns normally", async () => {
    const res = await nearby({ ...FAR, radiusM: 2000 });
    const { spots, dataVersion, unchanged } = await res.json();
    expect(spots).toEqual([]);
    expect(dataVersion).toBeNull();
    expect(unchanged).toBe(false);
  });

  test("a stale changedSince from an empty area does not suppress real spots", async () => {
    // A client that polled an empty area then travelled into a populated one
    // must not be told 'unchanged' — there is no version to compare against.
    const track = await makeTrack();
    await makeSpot(track.id, { radiusM: 100 });
    const { spots, unchanged } = await (
      await nearby({ ...AT, radiusM: 2000, changedSince: "1999-01-01T00:00:00.000Z" })
    ).json();
    expect(unchanged).toBe(false);
    expect(spots.length).toBe(1);
  });

  test("unpublished content does not bump the version", async () => {
    const track = await makeTrack();
    const spot = await makeSpot(track.id, { radiusM: 100 });
    const first = await (await nearby({ ...AT, radiusM: 2000 })).json();

    await makeContent(spot.id, { status: "draft" });

    const second = await (
      await nearby({ ...AT, radiusM: 2000, changedSince: first.dataVersion })
    ).json();
    expect(second.unchanged).toBe(true);
  });
});

describe("POST /api/route-nearby (journey prefetch)", () => {
  function routeNearby(body: unknown) {
    return app.fetch(
      new Request("http://localhost/api/route-nearby", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  // A ~2km south→north line through AT's longitude.
  const ROUTE = {
    points: [
      { lat: 40.70, lng: -73.99653 },
      { lat: 40.72, lng: -73.99653 },
    ],
  };

  test("returns corridor spots ordered along the route, excludes far ones", async () => {
    const track = await makeTrack();
    // Deliberately created out of travel order.
    await makeSpot(track.id, { title: "North", lat: 40.715, lng: -73.9964 });
    await makeSpot(track.id, { title: "South", lat: 40.703, lng: -73.9967 });
    await makeSpot(track.id, { title: "Mid", lat: 40.709, lng: -73.9963 });
    // ~1 degree of longitude away — far outside any sane corridor.
    await makeSpot(track.id, { title: "Elsewhere", lat: 40.71, lng: -72.99 });

    const res = await routeNearby({ ...ROUTE, corridorM: 300 });
    expect(res.status).toBe(200);
    const { spots } = await res.json();
    expect(spots.map((s: any) => s.spot.title)).toEqual(["South", "Mid", "North"]);
    // Nothing is triggered from the armchair.
    expect(spots.every((s: any) => s.triggered === false)).toBe(true);
    // Directional locating can't resolve without a course.
    expect(spots.every((s: any) => s.locating === null)).toBe(true);
  });

  test("corridor width is honored", async () => {
    const track = await makeTrack();
    // ~250m east of the line (at this latitude 0.003 lng ≈ 253m).
    await makeSpot(track.id, { title: "Offside", lat: 40.71, lng: -73.9935 });
    const narrow = await (await routeNearby({ ...ROUTE, corridorM: 100 })).json();
    expect(narrow.spots.length).toBe(0);
    const wide = await (await routeNearby({ ...ROUTE, corridorM: 500 })).json();
    expect(wide.spots.map((s: any) => s.spot.title)).toEqual(["Offside"]);
  });

  test("rejects a single-point route", async () => {
    const res = await routeNearby({ points: [{ lat: 40.7, lng: -73.99 }] });
    expect(res.status).toBe(400);
  });

  test("draft spots stay out of the corridor", async () => {
    const track = await makeTrack();
    await makeSpot(track.id, { title: "Hidden", lat: 40.71, lng: -73.9964, status: "draft" });
    const { spots } = await (await routeNearby({ ...ROUTE, corridorM: 300 })).json();
    expect(spots.length).toBe(0);
  });
});
