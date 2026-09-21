import { Hono } from "hono";
import { z } from "zod";
import {
  ContentPieceInput,
  FillInGenerateRequest,
  FillInItemInput,
  GenerateRequest,
  IdentifyQuery,
  TrackInput,
  PublishStatus,
  SpotInput,
  VocabImportRequest,
  TrackVisibilityInput,
} from "@grandtour/shared";
import type { FillInPayload, FiloDocumentJson } from "@grandtour/shared";
import { isQuizPayload, locatingTemplate, payloadSchemaFor } from "@grandtour/shared";
import { env } from "../env";
import { sql } from "../db";
import { identifyPlace } from "../ai/search";
import { generateLocatingClips } from "../ai/generate";
import { deleteSpot, updateSpotLocating } from "../content/repo";
import {
  createFillInItem,
  createTrack,
  createSpot,
  deleteFillInItem,
  exportTrack,
  setTrackVisibility,
  getFillInItem,
  getSpot,
  listContentForSpot,
  listFillInItems,
  listTracks,
  listSpots,
  setContentStatus,
  setFillInItemContent,
  setFillInItemStatus,
  updateFillInItem,
  updateSpot,
  upsertContent,
} from "../content/repo";
import { generateNarration } from "../ai/generate";
import { generateVocabAudio, vocabScriptDocument } from "../ai/fillin/vocab";
import { generateQuizAudio, quizScriptDocument } from "../ai/fillin/quiz";

/** Module-appropriate text-only script document. The payload union is
 * disjoint, so the payload alone picks the builder (pairing with
 * `moduleType` is validated at the route boundary via `payloadSchemaFor`). */
function scriptDocumentFor(itemId: string, payload: FillInPayload): FiloDocumentJson {
  return isQuizPayload(payload)
    ? quizScriptDocument(itemId, payload)
    : vocabScriptDocument(itemId, payload);
}

export const adminRouter = new Hono();

// Shared-token auth. Fail closed: no ADMIN_TOKEN configured = admin API off.
adminRouter.use("*", async (c, next) => {
  const token = env.adminToken();
  if (!token) {
    return c.json(
      { error: "admin_disabled", detail: "Set ADMIN_TOKEN to enable the admin API." },
      503,
    );
  }
  if (c.req.header("Authorization") !== `Bearer ${token}`) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
});

// ─── Tracks ──────────────────────────────────────────────────────────────────

adminRouter.get("/tracks", async (c) => c.json({ tracks: await listTracks(sql, true) }));

adminRouter.post("/tracks", async (c) => {
  const parsed = TrackInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.message }, 400);
  return c.json({ track: await createTrack(sql, parsed.data) }, 201);
});

// Static bundle for the offline tour viewer: this track's published spots +
// content, self-contained enough to drive the viewer with no live API.
/**
 * Hold a track back from the public API, or release it. Nothing inside the
 * track changes — this is the release gate, not an editorial status.
 */
adminRouter.patch("/tracks/:id/visibility", async (c) => {
  const parsed = TrackVisibilityInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid_body", detail: parsed.error.message }, 400);
  }
  try {
    const track = await setTrackVisibility(
      sql,
      c.req.param("id"),
      parsed.data.visibility,
      parsed.data.holdReason,
    );
    if (!track) return c.json({ error: "track_not_found" }, 404);
    return c.json({ track });
  } catch (err) {
    return c.json({ error: "invalid_hold", detail: String(err) }, 400);
  }
});

adminRouter.get("/tracks/:id/export", async (c) => {
  const bundle = await exportTrack(sql, c.req.param("id"));
  if (!bundle) return c.json({ error: "not_found" }, 404);
  c.header(
    "Content-Disposition",
    `attachment; filename="${bundle.track.slug}.grandtour.json"`,
  );
  return c.json(bundle);
});

// ─── Identify (what is at this coordinate?) ──────────────────────────────────

adminRouter.get("/identify", async (c) => {
  const parsed = IdentifyQuery.safeParse(c.req.query());
  if (!parsed.success) return c.json({ error: "invalid_query", detail: parsed.error.message }, 400);
  const { lat, lng } = parsed.data;
  return c.json(await identifyPlace(lat, lng));
});

// ─── Spots ───────────────────────────────────────────────────────────────────

adminRouter.get("/spots", async (c) => {
  const limit = Number(c.req.query("limit") ?? 500);
  const trackId = c.req.query("trackId") || undefined;
  return c.json({
    spots: await listSpots(sql, { limit: Number.isFinite(limit) ? limit : 500, trackId }),
  });
});

adminRouter.get("/spots/:id", async (c) => {
  const spot = await getSpot(sql, c.req.param("id"));
  if (!spot) return c.json({ error: "not_found" }, 404);
  const content = await listContentForSpot(sql, spot.id);
  return c.json({ spot, content });
});

/**
 * Write-time trigger guard. `anywhere` parses (the wire shape is reserved)
 * but nothing serves it yet — refusing here beats a spot that can never play.
 */
function rejectedTriggerDetail(input: SpotInput): string | null {
  if (input.trigger.kind === "anywhere") {
    return "anywhere triggers are reserved and not served yet — use a fill-in track, or an area fence around the region of interest";
  }
  return null;
}

/** A sequence slot collision (unique index) is an authoring error, not a 500. */
function isSequenceCollision(err: unknown): boolean {
  return (err as { code?: string })?.code === "23505" &&
    String((err as { constraint_name?: string })?.constraint_name ?? "").includes("sequence");
}

adminRouter.post("/spots", async (c) => {
  const parsed = SpotInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.message }, 400);
  const rejected = rejectedTriggerDetail(parsed.data);
  if (rejected) return c.json({ error: "invalid_body", detail: rejected }, 400);
  try {
    return c.json({ spot: await createSpot(sql, parsed.data) }, 201);
  } catch (err) {
    if (isSequenceCollision(err)) {
      return c.json(
        { error: "invalid_body", detail: "another spot already holds this sequence key + index in the track" },
        400,
      );
    }
    throw err;
  }
});

adminRouter.put("/spots/:id", async (c) => {
  const parsed = SpotInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.message }, 400);
  const rejected = rejectedTriggerDetail(parsed.data);
  if (rejected) return c.json({ error: "invalid_body", detail: rejected }, 400);
  try {
    const spot = await updateSpot(sql, c.req.param("id"), parsed.data);
    if (!spot) return c.json({ error: "not_found" }, 404);
    return c.json({ spot });
  } catch (err) {
    if (isSequenceCollision(err)) {
      return c.json(
        { error: "invalid_body", detail: "another spot already holds this sequence key + index in the track" },
        400,
      );
    }
    throw err;
  }
});

adminRouter.delete("/spots/:id", async (c) => {
  const ok = await deleteSpot(sql, c.req.param("id"));
  if (!ok) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});

// ─── Content ─────────────────────────────────────────────────────────────────

adminRouter.put("/content", async (c) => {
  const parsed = ContentPieceInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.message }, 400);
  return c.json({ content: await upsertContent(sql, parsed.data) });
});

const StatusBody = z.object({ status: PublishStatus });

adminRouter.post("/content/:id/status", async (c) => {
  const parsed = StatusBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.message }, 400);
  const content = await setContentStatus(sql, c.req.param("id"), parsed.data.status);
  if (!content) return c.json({ error: "not_found" }, 404);
  return c.json({ content });
});

// ─── Locating instructions (targeted TTS, never touches the narration) ──────

const LocatingGenBody = z.object({
  locale: z.string().default("en"),
  voiceId: z.string().optional(),
});

adminRouter.post("/spots/:id/locating/generate", async (c) => {
  const spot = await getSpot(sql, c.req.param("id"));
  if (!spot) return c.json({ error: "not_found" }, 404);
  if (spot.trigger.kind === "area") {
    return c.json(
      { error: "locating_disabled", detail: "Area spots have no 'where to look' — the traveler is inside them." },
      400,
    );
  }

  const parsed = LocatingGenBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.message }, 400);

  const template = locatingTemplate(spot.locating);
  if (!template) {
    return c.json({ error: "locating_disabled", detail: "This spot's locating mode is 'none'." }, 400);
  }

  let clips;
  try {
    clips = await generateLocatingClips({
      spotId: spot.id,
      template,
      locale: parsed.data.locale,
      voiceId: parsed.data.voiceId,
    });
  } catch (err) {
    console.error("locating_generation_failed", spot.id, err);
    return c.json(
      { error: "locating_generation_failed", detail: "Locating audio generation failed. Check server logs." },
      502,
    );
  }

  const updated = await updateSpotLocating(sql, spot.id, { ...spot.locating, clips });
  return c.json({ spot: updated });
});

// ─── Fill-in items (plans/014-fillin-content.md) ─────────────────────────────

adminRouter.get("/fillin-items", async (c) => {
  const trackId = c.req.query("trackId");
  if (!trackId) return c.json({ error: "invalid_query", detail: "trackId is required" }, 400);
  return c.json({ items: await listFillInItems(sql, trackId) });
});

adminRouter.post("/fillin-items", async (c) => {
  const parsed = FillInItemInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.message }, 400);
  if (!payloadSchemaFor(parsed.data.moduleType).safeParse(parsed.data.payload).success) {
    return c.json(
      { error: "invalid_body", detail: `payload does not match moduleType "${parsed.data.moduleType}"` },
      400,
    );
  }
  const created = await createFillInItem(sql, parsed.data);
  // Script document attached immediately (no audio): the item is speakable
  // by the on-device voice as soon as it's published, before any TTS spend.
  const item = await setFillInItemContent(sql, created.id, {
    document: scriptDocumentFor(created.id, created.payload),
    audioUrl: null,
    durationMs: null,
    source: "human",
    provenance: null,
  });
  return c.json({ item }, 201);
});

/** Bulk vocab import: one source stamped across a pasted word list. */
adminRouter.post("/fillin-items/import", async (c) => {
  const parsed = VocabImportRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.message }, 400);
  const { trackId, source, words } = parsed.data;
  // Continue numbering after the track's existing items, so successive
  // import batches don't restart at 0 and interleave.
  const [orderRow] = await sql<{ next: number }[]>`
    SELECT COALESCE(MAX(sort_order), -1) + 1 AS next
    FROM fillin_items WHERE track_id = ${trackId}
  `;
  const next = Number(orderRow?.next ?? 0);
  const items = [];
  for (const [i, w] of words.entries()) {
    const created = await createFillInItem(sql, {
      trackId,
      moduleType: "vocab",
      payload: {
        word: w.word,
        ...(w.pronunciation ? { pronunciation: w.pronunciation } : {}),
        senses: [
          {
            ...(w.partOfSpeech ? { partOfSpeech: w.partOfSpeech } : {}),
            definition: w.definition,
            exampleSentence: w.exampleSentence,
          },
        ],
        source,
      },
      order: next + i,
    });
    items.push(
      await setFillInItemContent(sql, created.id, {
        document: scriptDocumentFor(created.id, created.payload),
        audioUrl: null,
        durationMs: null,
        source: "imported",
        provenance: null,
      }),
    );
  }
  return c.json({ items }, 201);
});

adminRouter.put("/fillin-items/:id", async (c) => {
  const parsed = FillInItemInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.message }, 400);
  if (!payloadSchemaFor(parsed.data.moduleType).safeParse(parsed.data.payload).success) {
    return c.json(
      { error: "invalid_body", detail: `payload does not match moduleType "${parsed.data.moduleType}"` },
      400,
    );
  }
  let item = await updateFillInItem(sql, c.req.param("id"), parsed.data);
  if (!item) return c.json({ error: "not_found" }, 404);
  // A payload edit changes the script; refresh the doc — but only while no
  // audio exists (a recorded clip and its document must stay in step; the
  // admin re-generates audio to refresh both).
  if (!item.content?.audioUrl) {
    item = await setFillInItemContent(sql, item.id, {
      document: scriptDocumentFor(item.id, item.payload),
      audioUrl: null,
      durationMs: null,
      source: item.content?.source ?? "human",
      provenance: item.content?.provenance ?? null,
    });
  }
  return c.json({ item });
});

adminRouter.delete("/fillin-items/:id", async (c) => {
  const ok = await deleteFillInItem(sql, c.req.param("id"));
  if (!ok) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});

adminRouter.post("/fillin-items/:id/status", async (c) => {
  const parsed = StatusBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.message }, 400);
  const item = await setFillInItemStatus(sql, c.req.param("id"), parsed.data.status);
  if (!item) return c.json({ error: "not_found" }, 404);
  return c.json({ item });
});

/**
 * TTS a fill-in item (vocab or quiz): deterministic script over the payload,
 * think-time pause baked into the audio. Deliberately NOT the location
 * pipeline — no vetting, no refusal path; see the doc comments in
 * ../ai/fillin/vocab.ts and ../ai/fillin/quiz.ts.
 */
adminRouter.post("/fillin-items/:id/generate", async (c) => {
  const item = await getFillInItem(sql, c.req.param("id"));
  if (!item) return c.json({ error: "not_found" }, 404);

  const parsed = FillInGenerateRequest.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.message }, 400);

  let result;
  try {
    const common = {
      itemId: item.id,
      voiceId: parsed.data.voiceId,
      pauseSeconds: parsed.data.pauseSeconds,
    };
    result = isQuizPayload(item.payload)
      ? await generateQuizAudio({ ...common, payload: item.payload })
      : await generateVocabAudio({ ...common, payload: item.payload });
  } catch (err) {
    console.error("fillin_generation_failed", item.id, err);
    return c.json(
      { error: "fillin_generation_failed", detail: "Fill-in audio generation failed. Check server logs." },
      502,
    );
  }

  const updated = await setFillInItemContent(sql, item.id, {
    document: result.document,
    audioUrl: result.audioUrl,
    durationMs: result.durationMs,
    source: "ai",
    provenance: result.provenance,
  });
  return c.json({ item: updated });
});

// ─── AI generation ───────────────────────────────────────────────────────────

adminRouter.post("/spots/:id/generate", async (c) => {
  const spot = await getSpot(sql, c.req.param("id"));
  if (!spot) return c.json({ error: "not_found" }, 404);

  const parsed = GenerateRequest.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.message }, 400);
  const req = parsed.data;

  const [track] = await sql`SELECT name FROM tracks WHERE id = ${spot.trackId}`;

  let result;
  try {
    result = await generateNarration({
      spot,
      trackName: track?.name ?? "",
      brief: req.brief,
      locale: req.locale,
      variant: req.variant,
      voiceId: req.voiceId,
      targetSeconds: req.targetSeconds,
      useSearch: req.useSearch,
      useWikipedia: req.useWikipedia,
      synthesizeAudio: req.synthesizeAudio,
    });
  } catch (err) {
    // The wrong-location refusal is a deliberate, user-facing message.
    if (err instanceof Error && err.message.includes("Refusing to generate")) {
      return c.json({ error: "generation_refused", detail: err.message }, 422);
    }
    console.error("generation_failed", spot.id, err);
    return c.json(
      { error: "generation_failed", detail: "Narration generation failed. Check server logs." },
      502,
    );
  }

  // Directional scripts produce several pieces (left/right + template master);
  // pieces[0] is always a playable preview.
  const saved = [];
  for (const piece of result.pieces) {
    saved.push(
      await upsertContent(sql, {
        spotId: spot.id,
        locale: req.locale,
        variant: piece.variant,
        document: piece.document,
        audioUrl: piece.audioUrl,
        durationMs: piece.durationMs,
        source: "ai",
        provenance: result.provenance,
        status: "draft",
      }),
    );
  }

  return c.json({ content: saved[0], contents: saved });
});
