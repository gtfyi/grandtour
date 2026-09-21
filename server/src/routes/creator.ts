import { Hono } from "hono";
import { createHash } from "node:crypto";
import {
  CREATOR_AUDIO_MAX_BYTES,
  CREATOR_AUDIO_TYPES,
  CreatorSpotMeta,
  CreatorTrackInput,
  slugify,
} from "@grandtour/shared";
import { sql, type Sql } from "../db";
import { creatorUpload, CreatorUploadConflict } from "../content/creator-uploads";
import { contentVersion, putAudio } from "../ai/storage";
import {
  createSpot,
  createTrack,
  deleteSpot,
  getTrack,
  listSpots,
  upsertContent,
} from "../content/repo";

/**
 * Creator API: the phone's walk-and-record mode (PRD "Walk and Record").
 * A creator records narration where they stand; the spot + audio land on a
 * track they created and publish immediately, so the same phone can turn the
 * track on and hear it back on the next lap.
 *
 * UNAUTHENTICATED by design *for now*: the server is assumed private (a dev
 * box on a tailnet, same trust level as /api/diag). Anything public needs
 * real creator accounts first — don't mount this on an internet-facing
 * deployment as-is.
 */
export const creatorRouter = new Hono();

// The phone only sends its automatic queue to a server with durable retries.
creatorRouter.get("/capabilities", (c) => c.json({ recording: true, idempotency: true }));
creatorRouter.onError((error, c) => {
  if (error instanceof CreatorUploadConflict) {
    return c.json({ error: "upload_id_conflict", detail: "This upload ID was already used for different content." }, 409);
  }
  throw error;
});

/** A globally-unique track slug: base name slug, then -2, -3, … */
async function uniqueTrackSlug(sql: Sql, name: string): Promise<string> {
  const base = slugify(name);
  const rows = await sql`SELECT slug FROM tracks WHERE slug LIKE ${base + "%"}`;
  const taken = new Set(rows.map((r: any) => r.slug));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 100; n++) {
    if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  }
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

creatorRouter.post("/tracks", async (c) => {
  const parsed = CreatorTrackInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.message }, 400);
  const result = await creatorUpload("track", parsed.data.clientId, parsed.data, async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('creator:tracks', 0))`;
    const track = await createTrack(tx, {
      slug: await uniqueTrackSlug(tx, parsed.data.name),
      name: parsed.data.name,
      description: parsed.data.description,
      lifecycle: parsed.data.lifecycle,
      kind: "tour",
      official: false,
    });
    return { track };
  });
  return c.json(result, 201);
});

/** The chosen track's spots, any status — the record screen's running list. */
creatorRouter.get("/spots", async (c) => {
  const trackId = c.req.query("trackId");
  if (!trackId) return c.json({ error: "invalid_query", detail: "trackId is required" }, 400);
  return c.json({ spots: await listSpots(sql, { trackId }) });
});

/**
 * One recorded spot: multipart body with a `meta` JSON field (CreatorSpotMeta)
 * and an `audio` file part. Creates the spot at the recorded GPS fix and its
 * human-source content piece, both published — no review step on a private
 * server, and the recording is playable the moment the request returns.
 *
 * The content piece has no filo document: there's no transcript, so there's
 * nothing to highlight (same shape as fill-in audio, which players already
 * handle). Locating is disabled — the creator's own narration says where to
 * look, and the template/TTS machinery is for generated content.
 */
creatorRouter.post("/spots", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.parseBody();
  } catch {
    return c.json({ error: "invalid_body", detail: "expected multipart/form-data" }, 400);
  }

  const metaRaw = body["meta"];
  if (typeof metaRaw !== "string") {
    return c.json({ error: "invalid_body", detail: "missing meta JSON field" }, 400);
  }
  let metaJson: unknown;
  try {
    metaJson = JSON.parse(metaRaw);
  } catch {
    return c.json({ error: "invalid_body", detail: "meta is not valid JSON" }, 400);
  }
  const parsed = CreatorSpotMeta.safeParse(metaJson);
  if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.message }, 400);
  const meta = parsed.data;

  const audio = body["audio"];
  if (!(audio instanceof File) || audio.size === 0) {
    return c.json({ error: "invalid_body", detail: "missing audio file part" }, 400);
  }
  if (audio.size > CREATOR_AUDIO_MAX_BYTES) {
    return c.json({ error: "invalid_body", detail: "audio file too large" }, 400);
  }
  const contentType = (audio.type || "audio/mp4").split(";")[0]!.trim();
  const ext = CREATOR_AUDIO_TYPES[contentType];
  if (!ext) {
    return c.json(
      { error: "invalid_body", detail: `unsupported audio type "${contentType}"` },
      400,
    );
  }

  const track = await getTrack(sql, meta.trackId);
  if (!track) return c.json({ error: "track_not_found" }, 404);
  if (track.kind === "fillin") {
    return c.json({ error: "invalid_body", detail: "fill-in tracks hold items, not spots" }, 400);
  }

  const bytes = new Uint8Array(await audio.arrayBuffer());
  const audioUrl = await putAudio(
    `creator/${slugify(meta.title)}-${contentVersion(bytes)}${ext}`,
    bytes,
    contentType,
  );

  const result = await creatorUpload("spot", meta.clientId,
    { meta, audioHash: createHash("sha256").update(bytes).digest("hex"), contentType }, async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${"creator:spots:" + meta.trackId}, 0))`;
      const spot = await createSpot(tx, {
        trackId: meta.trackId,
        title: meta.title,
        subtitle: meta.subtitle,
        trigger: { kind: "point", center: { lat: meta.lat, lng: meta.lng }, radiusM: meta.radiusM },
        locating: { mode: "none", clips: {} },
        status: "published",
      });

      const content = await upsertContent(tx, {
        spotId: spot.id,
        locale: meta.locale,
        document: null,
        audioUrl,
        durationMs: meta.durationMs ?? null,
        source: "human",
        provenance: {
          sources: [],
          warnings: [],
          capture: {
            recordedAt: meta.recordedAt,
            courseDeg: meta.courseDeg,
            speedMps: meta.speedMps,
            altitudeM: meta.altitudeM,
            horizontalAccuracyM: meta.horizontalAccuracyM,
          },
        },
        status: "published",
      });

      return { spot, content };
  });
  return c.json(result, 201);
});

/** Field mistakes are normal — a fumbled take gets deleted and re-recorded. */
creatorRouter.delete("/spots/:id", async (c) => {
  const ok = await deleteSpot(sql, c.req.param("id"));
  if (!ok) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});
