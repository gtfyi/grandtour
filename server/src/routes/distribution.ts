import { Hono } from "hono";
import {
  FORMAT_VERSION,
  INDEX_FILE,
  TOURS_DIR,
  mapAudioRefs,
  slimDocuments,
  publicIndex,
  stableExportedAt,
  voicedOnly,
  type TrackExport,
} from "@grandtour/shared";
import { sql } from "../db";
import { buildIndexFromDb } from "../content/distribution";
import { originOf, rehostRef } from "../content/rehost";
import { exportTrack, listTracks } from "../content/repo";

/**
 * The distribution protocol, served live: this server is a GrandTour server
 * like any static host, so a client can point at it and read the same files
 * it would read from grandtour.fyi — with content that changes as it is
 * authored. Recordings stored locally are minted against localhost; they are
 * served from whatever host this request arrived at.
 */
export const distributionRouter = new Hono();

distributionRouter.get(`/${INDEX_FILE}`, async (c) => {
  const { index } = await buildIndexFromDb(sql);
  return c.json(publicIndex(index));
});

distributionRouter.get(`/${TOURS_DIR}/:file`, async (c) => {
  const file = c.req.param("file");
  const slug = file.replace(/\.grandtour\.json$/, "");
  if (slug === file) return c.json({ error: "not_found" }, 404);
  const track = (await listTracks(sql)).find((t) => t.slug === slug && t.kind === "tour");
  if (!track) return c.json({ error: "track_not_found" }, 404);
  const exported = await exportTrack(sql, track.id);
  if (!exported) return c.json({ error: "track_not_found" }, 404);
  // Targeted rewrite and no schema re-parse: a large track is megabytes of
  // annotations, and this route runs per request.
  const bundle = slimDocuments(voicedOnly(mapAudioRefs(exported, rehostRef(originOf(c)))));
  const body: TrackExport = { ...bundle, formatVersion: FORMAT_VERSION, exportedAt: stableExportedAt(bundle) };
  return c.json(body);
});
