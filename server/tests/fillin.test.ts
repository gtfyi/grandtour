import { beforeEach, describe, expect, test } from "bun:test";
import { FillInItem } from "@grandtour/shared";
import {
  adminHeaders,
  makeContent,
  makeFillInItem,
  makeQuizFillInItem,
  makeSpot,
  makeTrack,
  resetDb,
  testSql,
} from "./helpers";
import app from "../src/index";

// Query point ≈ Brooklyn Bridge; helpers' default spot center is the same.
const AT = { lat: 40.70611, lng: -73.99653 };

function nearby(params: Record<string, string | number>) {
  const qs = new URLSearchParams(
    Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
  );
  return app.fetch(new Request(`http://localhost/api/nearby?${qs}`));
}

function fillinItems(tracks?: string) {
  const qs = tracks !== undefined ? `?tracks=${encodeURIComponent(tracks)}` : "";
  return app.fetch(new Request(`http://localhost/api/fillin-items${qs}`));
}

beforeEach(async () => {
  await resetDb();
});

describe("track kind", () => {
  test("/api/tracks surfaces kind for both kinds", async () => {
    await makeTrack({ slug: "walk", kind: "tour" });
    await makeTrack({ slug: "vocab", kind: "fillin" });
    const { tracks } = await (
      await app.fetch(new Request("http://localhost/api/tracks"))
    ).json();
    const bySlug = new Map(tracks.map((t: any) => [t.slug, t.kind]));
    expect(bySlug.get("walk")).toBe("tour");
    expect(bySlug.get("vocab")).toBe("fillin");
  });
});

describe("fill-in tracks are excluded from geo queries", () => {
  // A fill-in track should never hold spots, but nothing in the DB forbids
  // it — the geo queries must exclude by kind explicitly, not rely on the
  // join coming up empty.
  test("/nearby never returns a spot on a fillin track", async () => {
    const track = await makeTrack({ kind: "fillin" });
    const spot = await makeSpot(track.id, { radiusM: 500 });
    await makeContent(spot.id);
    const { spots } = await (await nearby({ ...AT, radiusM: 2000 })).json();
    expect(spots.length).toBe(0);
  });

  test("/route-nearby never returns a spot on a fillin track", async () => {
    const track = await makeTrack({ kind: "fillin" });
    await makeSpot(track.id, { radiusM: 500 });
    const res = await app.fetch(
      new Request("http://localhost/api/route-nearby", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          points: [
            { lat: AT.lat, lng: AT.lng },
            { lat: AT.lat + 0.01, lng: AT.lng },
          ],
        }),
      }),
    );
    const { spots } = await res.json();
    expect(spots.length).toBe(0);
  });

  test("a tour-track spot still comes back (filter is kind-scoped, not global)", async () => {
    const track = await makeTrack({ kind: "tour" });
    await makeSpot(track.id, { radiusM: 500 });
    const { spots } = await (await nearby({ ...AT, radiusM: 2000 })).json();
    expect(spots.length).toBe(1);
    expect(spots[0].track.kind).toBe("tour");
  });
});

describe("GET /api/fillin-items", () => {
  test("returns published items for the named tracks only", async () => {
    const vocab = await makeTrack({ slug: "vocab", kind: "fillin" });
    const other = await makeTrack({ slug: "other-fillin", kind: "fillin" });
    await makeFillInItem(vocab.id, { word: "published-word", status: "published" });
    await makeFillInItem(vocab.id, { word: "draft-word", status: "draft" });
    await makeFillInItem(other.id, { word: "other-word", status: "published" });

    const { items } = await (await fillinItems("vocab")).json();
    expect(items.length).toBe(1);
    expect(items[0].payload.word).toBe("published-word");
    expect(items[0].status).toBe("published");
  });

  test("multiple tracks: a random sample of the published set", async () => {
    const vocab = await makeTrack({ slug: "vocab", kind: "fillin" });
    await makeFillInItem(vocab.id, { word: "second", order: 2 });
    await makeFillInItem(vocab.id, { word: "first", order: 1 });
    const { items } = await (await fillinItems("vocab,missing-slug")).json();
    // Order is deliberately random (rotating sample of a possibly-huge
    // list) — assert membership, not sequence.
    expect(items.map((i: any) => i.payload.word).sort()).toEqual(["first", "second"]);
  });

  test("tracks param is required", async () => {
    expect((await fillinItems()).status).toBe(400);
    expect((await fillinItems("")).status).toBe(400);
  });

  test("an item with audio surfaces a ContentPiece keyed to the item", async () => {
    const vocab = await makeTrack({ slug: "vocab", kind: "fillin" });
    const item = await makeFillInItem(vocab.id, {
      audioUrl: "http://localhost:8787/uploads/fillin_x_en-default.mp3",
    });
    const { items } = await (await fillinItems("vocab")).json();
    expect(items[0].content.audioUrl).toContain("fillin_x_en-default.mp3");
    expect(items[0].content.spotId).toBe(item.id); // item id stands in — no spot
  });

  test("quiz and vocab items are served side by side from one track set", async () => {
    const geo = await makeTrack({ slug: "geography", kind: "fillin" });
    const vocab = await makeTrack({ slug: "vocab", kind: "fillin" });
    await makeQuizFillInItem(geo.id, { question: "What is the capital of Mongolia?" });
    await makeQuizFillInItem(geo.id, { question: "Draft question", status: "draft" });
    await makeFillInItem(vocab.id, { word: "published-word" });

    const { items } = await (await fillinItems("geography,vocab")).json();
    expect(items.length).toBe(2);
    const quiz = items.find((i: any) => i.moduleType === "quiz");
    expect(quiz.payload.question).toBe("What is the capital of Mongolia?");
    expect(quiz.payload.answers.length).toBe(2);
    // The wire shape must round-trip the shared schema (union payload).
    expect(FillInItem.safeParse(quiz).success).toBe(true);
  });
});

describe("admin fill-in CRUD", () => {
  test("requires the bearer token", async () => {
    const res = await app.fetch(
      new Request("http://localhost/api/admin/fillin-items?trackId=x"),
    );
    expect(res.status).toBe(401);
  });

  test("import stamps source and order across the list", async () => {
    const vocab = await makeTrack({ kind: "fillin" });
    const res = await app.fetch(
      new Request("http://localhost/api/admin/fillin-items/import", {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({
          trackId: vocab.id,
          source: { title: "SAT list", url: "https://example.com/sat" },
          words: [
            { word: "alpha", definition: "first", exampleSentence: "Alpha comes first." },
            { word: "beta", definition: "second", exampleSentence: "Beta follows alpha." },
          ],
        }),
      }),
    );
    expect(res.status).toBe(201);
    const { items } = await res.json();
    expect(items.length).toBe(2);
    expect(items[0].payload.source.url).toBe("https://example.com/sat");
    expect(items.map((i: any) => i.order)).toEqual([0, 1]);
    expect(items.every((i: any) => i.status === "draft")).toBe(true);
    // Import attaches the script document immediately (no audio), so a
    // published item is on-device-speakable before any TTS spend.
    expect(items[0].content.document.text).toStartWith("The word is: alpha.");
    expect(items[0].content.audioUrl).toBeNull();
    expect(items[0].content.source).toBe("imported");
  });

  test("status flips to published and the public route picks it up", async () => {
    const vocab = await makeTrack({ slug: "vocab2", kind: "fillin" });
    const item = await makeFillInItem(vocab.id, { status: "draft" });
    const res = await app.fetch(
      new Request(`http://localhost/api/admin/fillin-items/${item.id}/status`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ status: "published" }),
      }),
    );
    expect(res.status).toBe(200);
    const { items } = await (await fillinItems("vocab2")).json();
    expect(items.length).toBe(1);
  });

  test("update edits the payload without unpublishing", async () => {
    const vocab = await makeTrack({ kind: "fillin" });
    const item = await makeFillInItem(vocab.id, { status: "published" });
    const res = await app.fetch(
      new Request(`http://localhost/api/admin/fillin-items/${item.id}`, {
        method: "PUT",
        headers: adminHeaders,
        body: JSON.stringify({
          trackId: vocab.id,
          moduleType: "vocab",
          payload: {
            word: "edited",
            senses: [
              { definition: "a changed definition", exampleSentence: "The edited sentence." },
            ],
            source: { title: "Test list", url: "https://example.com/vocab" },
          },
        }),
      }),
    );
    expect(res.status).toBe(200);
    const { item: updated } = await res.json();
    expect(updated.payload.word).toBe("edited");
    expect(updated.status).toBe("published"); // omitted status preserved
  });

  test("create quiz item attaches the quiz script document", async () => {
    const geo = await makeTrack({ kind: "fillin" });
    const res = await app.fetch(
      new Request("http://localhost/api/admin/fillin-items", {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({
          trackId: geo.id,
          moduleType: "quiz",
          payload: {
            category: "Geography",
            question: "What is the capital of Mongolia?",
            answers: ["Ulaanbaatar"],
            source: { title: "Wikidata", url: "https://query.wikidata.org/" },
          },
        }),
      }),
    );
    expect(res.status).toBe(201);
    const { item } = await res.json();
    expect(item.content.document.text).toStartWith("Geography quiz.");
    expect(item.content.document.text).toContain("The answer: Ulaanbaatar.");
    expect(item.content.audioUrl).toBeNull();
  });

  test("payload that doesn't match moduleType is rejected", async () => {
    const geo = await makeTrack({ kind: "fillin" });
    const res = await app.fetch(
      new Request("http://localhost/api/admin/fillin-items", {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({
          trackId: geo.id,
          moduleType: "quiz",
          payload: {
            word: "loquacious",
            senses: [{ definition: "talkative" }],
            source: { title: "Test list", url: "https://example.com/vocab" },
          },
        }),
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.detail).toContain("moduleType");
  });

  test("delete removes the item; deleting the track cascades", async () => {
    const vocab = await makeTrack({ kind: "fillin" });
    const a = await makeFillInItem(vocab.id);
    await makeFillInItem(vocab.id);
    const res = await app.fetch(
      new Request(`http://localhost/api/admin/fillin-items/${a.id}`, {
        method: "DELETE",
        headers: adminHeaders,
      }),
    );
    expect(res.status).toBe(200);
    await testSql`DELETE FROM tracks WHERE id = ${vocab.id}`;
    const [row] = await testSql`SELECT count(*)::int AS n FROM fillin_items`;
    expect(row!.n).toBe(0);
  });
});
