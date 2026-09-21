import { Hono } from "hono";
import { originOf, rehostUploads } from "../content/rehost";
import {
  FillInItemsQuery,
  NearbyQuery,
  RouteNearbyBody,
  TrackManifestQuery,
  Track,
} from "@grandtour/shared";
import { sql } from "../db";
import { findAlongRoute, findNearby, nearbyDataVersion } from "../geo/queries";
import {
  assembleNearby,
  exportTrack,
  getTrack,
  listPublishedFillInItems,
  listTrackManifests,
  listTracks,
} from "../content/repo";

export const publicRouter = new Hono();

/** The hot path: spots near a coordinate, with content + guide attached. */
publicRouter.get("/nearby", async (c) => {
  // The app handles freshness with changedSince. HTTP caches must never
  // hide a newly published spot or recording from an already-running tour.
  c.header("Cache-Control", "no-store");
  const parsed = NearbyQuery.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: "invalid_query", detail: parsed.error.message }, 400);
  }
  const q = parsed.data;
  const scope = {
    lat: q.lat,
    lng: q.lng,
    radiusM: q.radiusM,
    tracks: q.tracks,
    mode: q.mode,
  };

  // Freshness gate: a polling client that already has the newest data in
  // range gets an empty, explicitly-`unchanged` body instead of full assembly.
  const dataVersion = await nearbyDataVersion(sql, scope);
  if (q.changedSince && dataVersion && dataVersion <= q.changedSince) {
    return c.json({ spots: [], dataVersion, unchanged: true });
  }

  const rows = await findNearby(sql, { ...scope, limit: q.limit });
  const spots = await assembleNearby(sql, rows, q.locale, q.courseDeg, q.trackLocales);
  return c.json(rehostUploads({ spots, dataVersion, unchanged: false }, originOf(c)));
});

/**
 * Journey prefetch: all published spots within a corridor of a planned route,
 * ordered by position along it. The app caches these (and their audio) before
 * setting out, so the tour keeps working with no connectivity.
 *
 * No courseDeg: the traveler isn't on the route yet, so directional locating
 * resolves to null — the live `/nearby` poll fills that in when reachable.
 */
publicRouter.post("/route-nearby", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const parsed = RouteNearbyBody.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_body", detail: parsed.error.message }, 400);
  }
  const q = parsed.data;
  const rows = await findAlongRoute(sql, {
    points: q.points,
    corridorM: q.corridorM,
    tracks: q.tracks,
    mode: q.mode,
    limit: q.limit,
  });
  const spots = await assembleNearby(sql, rows, q.locale, undefined, q.trackLocales);
  return c.json(rehostUploads({ spots }, originOf(c)));
});

/** Catalog of tracks the user can toggle. */
publicRouter.get("/tracks", async (c) => {
  const tracks = await listTracks(sql);
  return c.json({ tracks });
});

/** Complete published tour, for the server-connected web viewer. */
publicRouter.get("/tracks/:id/bundle", async (c) => {
  const id = Track.shape.id.safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "invalid_track_id" }, 400);
  // A held track is indistinguishable from a missing one out here. The gate
  // lives in the route rather than in exportTrack, because admin and the
  // export script must keep working on held tracks — that is the point of
  // holding rather than unpublishing.
  const track = await getTrack(sql, id.data);
  if (!track || track.visibility !== "public") {
    return c.json({ error: "track_not_found" }, 404);
  }
  const bundle = await exportTrack(sql, id.data);
  if (!bundle) return c.json({ error: "track_not_found" }, 404);
  return c.json(rehostUploads(bundle, originOf(c)));
});

/**
 * Per-track unit index (published, narratable ids + sequence info). The
 * client needs the whole track — not just what's in range — for two jobs
 * /nearby can't do: sequence eligibility (are all earlier parts of a story
 * heard, wherever they are?) and completion (played ∩ manifest, computed
 * on-device because play history never leaves the phone).
 */
publicRouter.get("/track-manifest", async (c) => {
  const parsed = TrackManifestQuery.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: "invalid_query", detail: parsed.error.message }, 400);
  }
  const tracks = await listTrackManifests(sql, parsed.data.tracks);
  return c.json({ tracks });
});

/**
 * Published fill-in items for the named fill-in tracks. No geo parameters:
 * fill-in content has no location, and a track's list is small enough to
 * fetch whole and cache client-side alongside the track catalog.
 */
publicRouter.get("/fillin-items", async (c) => {
  const parsed = FillInItemsQuery.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: "invalid_query", detail: parsed.error.message }, 400);
  }
  const items = await listPublishedFillInItems(sql, parsed.data.tracks, parsed.data.limit);
  return c.json(rehostUploads({ items }, originOf(c)));
});
