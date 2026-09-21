import { beforeEach, expect, test } from "bun:test";
import { Track } from "@grandtour/shared";
import app from "../src/index";
import { adminHeaders, makeContent, makeFillInItem, makeSpot, makeTrack, resetDb, testSql } from "./helpers";

beforeEach(resetDb);

async function catalog(admin = false) {
  const response = await app.fetch(new Request(`http://localhost/api/${admin ? "admin/" : ""}tracks`, {
    headers: admin ? adminHeaders : {},
  }));
  expect(response.status).toBe(200);
  return Track.array().parse((await response.json()).tracks);
}

test("catalog counts spots once, respects publication status, and includes empty tracks and fill-ins", async () => {
  const tour = await makeTrack();
  const spot = await makeSpot(tour.id);
  await makeContent(spot.id);
  await makeContent(spot.id, { locale: "es" });
  await makeSpot(tour.id); // Published spots count even before narration is added.
  await makeSpot(tour.id, { status: "draft" });
  await makeSpot(tour.id, { status: "review" });
  const empty = await makeTrack();
  const fillin = await makeTrack({ kind: "fillin" });
  await makeFillInItem(fillin.id);
  await makeFillInItem(fillin.id, { status: "draft" });

  const publicTracks = await catalog();
  expect(publicTracks.find((t) => t.id === tour.id)).toMatchObject({ spotCount: 2, itemCount: 0 });
  expect(publicTracks.find((t) => t.id === empty.id)).toMatchObject({ spotCount: 0, itemCount: 0 });
  expect(publicTracks.find((t) => t.id === fillin.id)).toMatchObject({ spotCount: 0, itemCount: 1 });
  const adminTracks = await catalog(true);
  expect(adminTracks.find((t) => t.id === tour.id)).toMatchObject({ spotCount: 4, itemCount: 0 });
  expect(adminTracks.find((t) => t.id === fillin.id)).toMatchObject({ spotCount: 0, itemCount: 2 });
});

test("catalog totals reflect publishing and deletion on the next request", async () => {
  const track = await makeTrack();
  const spot = await makeSpot(track.id, { status: "draft" });
  expect((await catalog())[0]!.spotCount).toBe(0);
  await testSql`UPDATE spots SET status = 'published' WHERE id = ${spot.id}`;
  expect((await catalog())[0]!.spotCount).toBe(1);
  await testSql`DELETE FROM spots WHERE id = ${spot.id}`;
  expect((await catalog())[0]!.spotCount).toBe(0);
  expect((await catalog(true))[0]!.spotCount).toBe(0);
});
