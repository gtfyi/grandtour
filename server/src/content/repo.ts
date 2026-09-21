import { Locating, SIDE_TOKEN, locatingTemplate, ringCentroid, slugify } from "@grandtour/shared";
import type { Sql } from "../db";
import { polygonWkt } from "../geo/queries";
import type { NearbySpotRow } from "../geo/queries";
import type {
  ContentPiece,
  ContentPieceInput,
  FillInItem,
  FillInItemInput,
  Guide,
  LocatingResolved,
  Track,
  TrackExport,
  TrackInput,
  TrackManifest,
  TrackVisibility,
  NearbySpot,
  Spot,
  SpotInput,
} from "@grandtour/shared";

// ─── Row → DTO mappers ───────────────────────────────────────────────────────

function rowToTrack(r: any): Track {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    description: r.description ?? "",
    kind: r.kind ?? "tour",
    lifecycle: r.lifecycle ?? "evergreen",
    icon: r.icon ?? undefined,
    color: r.color ?? undefined,
    official: r.official,
    visibility: r.visibility ?? "public",
    holdReason: r.hold_reason ?? null,
    heldAt: r.held_at ? new Date(r.held_at).toISOString() : null,
    spotCount: r.spot_count === undefined ? undefined : Number(r.spot_count),
    itemCount: r.item_count === undefined ? undefined : Number(r.item_count),
    createdAt: new Date(r.created_at).toISOString(),
  };
}

function rowToGuide(r: any): Guide {
  return {
    id: r.id,
    name: r.name,
    bio: r.bio ?? "",
    avatarUrl: r.avatar_url ?? undefined,
    bookingUrl: r.booking_url ?? undefined,
    contactEmail: r.contact_email ?? undefined,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

const LOCATING_FALLBACK: Locating = { mode: "auto", clips: {} };

/** JSONB → validated Locating; malformed rows fall back to the default. */
function parseLocating(raw: unknown): Locating {
  const parsed = Locating.safeParse(raw ?? LOCATING_FALLBACK);
  return parsed.success ? parsed.data : LOCATING_FALLBACK;
}

function rowToSpot(r: any): Spot {
  const center = r.center; // GeoJSON Point [lng, lat]; null only for future anywhere rows
  return {
    id: r.id ?? r.spot_id,
    trackId: r.track_id,
    slug: r.slug,
    title: r.title,
    subtitle: r.subtitle ?? "",
    trigger: {
      kind: r.trigger_kind ?? "point",
      center: center
        ? { lng: center.coordinates[0], lat: center.coordinates[1] }
        : undefined,
      radiusM: Number(r.radius_m),
      region: r.region
        ? r.region.coordinates[0].map((c: [number, number]) => ({
            lng: c[0],
            lat: c[1],
          }))
        : undefined,
    },
    sequence:
      r.sequence_key != null && r.sequence_index != null
        ? { key: r.sequence_key, index: Number(r.sequence_index) }
        : undefined,
    modes: r.modes ?? [],
    guideId: r.guide_id ?? undefined,
    locating: parseLocating(r.locating),
    status: r.status,
    createdBy: r.created_by ?? undefined,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

function rowToContent(r: any): ContentPiece {
  return {
    id: r.id,
    spotId: r.spot_id,
    locale: r.locale,
    variant: r.variant,
    document: r.document ?? null,
    audioUrl: r.audio_url ?? null,
    durationMs: r.duration_ms ?? null,
    source: r.source,
    provenance: r.provenance ?? null,
    status: r.status,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

// ─── Tracks ──────────────────────────────────────────────────────────────────

/**
 * `includeUnpublished` is the admin flag: it also lifts the visibility gate,
 * because a held track has to stay visible to the person holding it.
 */
export async function listTracks(sql: Sql, includeUnpublished = false): Promise<Track[]> {
  const rows = await sql`
    SELECT t.*, COALESCE(s.total, 0)::int AS spot_count, COALESCE(f.total, 0)::int AS item_count
    FROM tracks t
    LEFT JOIN (
      SELECT track_id, COUNT(*) AS total FROM spots
      ${includeUnpublished ? sql`` : sql`WHERE status = 'published'`}
      GROUP BY track_id
    ) s ON s.track_id = t.id
    LEFT JOIN (
      SELECT track_id, COUNT(*) AS total FROM fillin_items
      ${includeUnpublished ? sql`` : sql`WHERE status = 'published'`}
      GROUP BY track_id
    ) f ON f.track_id = t.id
    ${includeUnpublished ? sql`` : sql`WHERE t.visibility = 'public'`}
    ORDER BY t.official DESC, t.name ASC
  `;
  return rows.map(rowToTrack);
}

/**
 * Hold a track back from the public API, or release it.
 *
 * Deliberately does not touch spot or content status: that is the whole point.
 * A held track keeps every row exactly as it was, so releasing it is this same
 * call in reverse rather than a reconstruction of what used to be published.
 * A reason is required when holding — the DB check enforces it too, so the row
 * can always explain itself.
 */
export async function setTrackVisibility(
  sql: Sql,
  id: string,
  visibility: TrackVisibility,
  holdReason?: string | null,
): Promise<Track | null> {
  const holding = visibility === "private";
  const reason = holding ? (holdReason?.trim() || null) : null;
  if (holding && !reason) throw new Error("holding a track requires a reason");
  const [row] = await sql`
    UPDATE tracks
    SET visibility = ${visibility},
        hold_reason = ${reason},
        held_at = ${holding ? new Date() : null}
    WHERE id = ${id}
    RETURNING *
  `;
  return row ? rowToTrack(row) : null;
}

export async function createTrack(sql: Sql, input: TrackInput): Promise<Track> {
  const [row] = await sql`
    INSERT INTO tracks (slug, name, description, kind, lifecycle, icon, color, official)
    VALUES (${input.slug}, ${input.name}, ${input.description ?? ""},
            ${input.kind ?? "tour"}, ${input.lifecycle ?? "evergreen"},
            ${input.icon ?? null}, ${input.color ?? null}, ${input.official ?? false})
    RETURNING *
  `;
  return rowToTrack(row);
}

export async function getTrack(sql: Sql, id: string): Promise<Track | null> {
  const [row] = await sql`SELECT * FROM tracks WHERE id = ${id}`;
  return row ? rowToTrack(row) : null;
}

/**
 * A single track's published content, self-contained enough to drive the
 * static tour-viewer with no live API and download every unit to a phone.
 * Only published spots, content pieces, and fill-in items are included, so
 * the exported bundle can never leak draft/review-status narration. Unlike
 * the live fill-in endpoint's rotating sample, this has no item limit.
 */
export async function exportTrack(sql: Sql, trackId: string): Promise<TrackExport | null> {
  const track = await getTrack(sql, trackId);
  if (!track) return null;

  const spotRows = await sql`
    SELECT ${sql.unsafe(SPOT_COLS)} FROM spots
    WHERE track_id = ${trackId} AND status = 'published'
    ORDER BY created_at ASC, id ASC
  `;
  const contentRows = await sql`
    SELECT c.* FROM content_pieces c JOIN spots s ON s.id = c.spot_id
    WHERE s.track_id = ${trackId} AND s.status = 'published' AND c.status = 'published'
    ORDER BY c.created_at ASC, c.id ASC
  `;
  const bySpot = new Map<string, ContentPiece[]>();
  for (const row of contentRows) {
    const content = rowToContent(row);
    const pieces = bySpot.get(content.spotId) ?? [];
    pieces.push(content);
    bySpot.set(content.spotId, pieces);
  }
  const spots = spotRows.map((row) => {
    const spot = rowToSpot(row);
    return { spot, content: bySpot.get(spot.id) ?? [] };
  });
  const itemRows = track.kind === "fillin"
    ? await sql`
        SELECT * FROM fillin_items
        WHERE track_id = ${trackId} AND status = 'published'
        ORDER BY sort_order ASC NULLS LAST, created_at ASC, id ASC
      `
    : [];
  const fillInItems = itemRows.map(rowToFillInItem);

  return {
    exportedAt: new Date().toISOString(),
    track: { ...track, spotCount: spots.length, itemCount: fillInItems.length },
    spots,
    fillInItems,
  };
}

/**
 * Per-track manifests: every published, narratable unit's id (+ sequence for
 * spots), plus the newest change timestamp. "Narratable" matches the app's
 * bar — published content with audio or a speakable document — so completion
 * math counts exactly what a traveler could actually hear.
 */
export async function listTrackManifests(
  sql: Sql,
  trackSlugs: string[],
): Promise<TrackManifest[]> {
  const tracks = await sql`
    SELECT id, slug, lifecycle, kind FROM tracks
    WHERE visibility = 'public'
    ${trackSlugs.length ? sql`AND slug = ANY(${trackSlugs})` : sql``}
    ORDER BY slug ASC
  `;
  if (tracks.length === 0) return [];
  const ids = tracks.map((t: any) => t.id);

  const spotRows = await sql<
    { track_id: string; id: string; sequence_key: string | null; sequence_index: number | null; unit_updated_at: Date }[]
  >`
    SELECT s.track_id, s.id, s.sequence_key, s.sequence_index,
           GREATEST(s.updated_at, MAX(c.updated_at)) AS unit_updated_at
    FROM spots s
    JOIN content_pieces c ON c.spot_id = s.id
      AND c.status = 'published'
      AND (c.audio_url IS NOT NULL OR c.document IS NOT NULL)
    WHERE s.status = 'published' AND s.track_id = ANY(${ids})
    GROUP BY s.id
    ORDER BY s.sequence_key ASC NULLS LAST, s.sequence_index ASC, s.created_at ASC
  `;
  const itemRows = await sql<{ track_id: string; id: string; updated_at: Date }[]>`
    SELECT track_id, id, updated_at FROM fillin_items
    WHERE status = 'published'
      AND (audio_url IS NOT NULL OR document IS NOT NULL)
      AND track_id = ANY(${ids})
    ORDER BY sort_order ASC NULLS LAST, created_at ASC
  `;

  return tracks.map((t: any) => {
    const spotUnits = spotRows.filter((r) => r.track_id === t.id);
    const itemUnits = itemRows.filter((r) => r.track_id === t.id);
    const newest = [
      ...spotUnits.map((r) => new Date(r.unit_updated_at).getTime()),
      ...itemUnits.map((r) => new Date(r.updated_at).getTime()),
    ];
    return {
      trackId: t.id,
      slug: t.slug,
      lifecycle: t.lifecycle ?? "evergreen",
      contentUpdatedAt: newest.length
        ? new Date(Math.max(...newest)).toISOString()
        : null,
      units:
        t.kind === "fillin"
          ? itemUnits.map((r) => ({ id: r.id, sequenceKey: null, sequenceIndex: null }))
          : spotUnits.map((r) => ({
              id: r.id,
              sequenceKey: r.sequence_key ?? null,
              sequenceIndex: r.sequence_index != null ? Number(r.sequence_index) : null,
            })),
    };
  });
}

// ─── Spots ───────────────────────────────────────────────────────────────────

/**
 * The stored center: the given one, else (area triggers) the fence centroid —
 * a representative point for distance sort and map pins, never trigger math.
 * The GeoTrigger schema guarantees one of the two exists for every kind the
 * write paths accept (`anywhere` is rejected at the route boundary).
 */
function spotCenterWkt(input: SpotInput): string {
  const c =
    input.trigger.center ??
    (input.trigger.region ? ringCentroid(input.trigger.region) : null);
  if (!c) throw new Error("trigger has no center and no region to derive one from");
  return `SRID=4326;POINT(${c.lng} ${c.lat})`;
}

/** The full spot column list every rowToSpot consumer selects/returns. */
const SPOT_COLS = `id, track_id, slug, title, subtitle, trigger_kind,
           ST_AsGeoJSON(center)::json AS center, radius_m,
           ST_AsGeoJSON(region)::json AS region,
           sequence_key, sequence_index,
           modes, guide_id, locating, status, created_by, created_at, updated_at`;

export async function getSpot(sql: Sql, id: string): Promise<Spot | null> {
  const [row] = await sql`
    SELECT ${sql.unsafe(SPOT_COLS)}
    FROM spots WHERE id = ${id}
  `;
  return row ? rowToSpot(row) : null;
}

/** All spots regardless of status, newest-edited first (admin authoring list). */
export async function listSpots(
  sql: Sql,
  opts: { limit?: number; trackId?: string } = {},
): Promise<Spot[]> {
  const limit = Math.min(opts.limit ?? 500, 1000);
  const rows = await sql`
    SELECT ${sql.unsafe(SPOT_COLS)}
    FROM spots
    ${opts.trackId ? sql`WHERE track_id = ${opts.trackId}` : sql``}
    ORDER BY updated_at DESC
    LIMIT ${limit}
  `;
  return rows.map(rowToSpot);
}

/** A slug unique within the track: base title slug, then -2, -3, … */
async function uniqueSpotSlug(sql: Sql, trackId: string, title: string): Promise<string> {
  const base = slugify(title);
  const rows = await sql`
    SELECT slug FROM spots WHERE track_id = ${trackId} AND slug LIKE ${base + "%"}
  `;
  const taken = new Set(rows.map((r: any) => r.slug));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 100; n++) {
    if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  }
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

export async function createSpot(sql: Sql, input: SpotInput): Promise<Spot> {
  const region = input.trigger.region ? polygonWkt(input.trigger.region) : null;
  const slug = await uniqueSpotSlug(sql, input.trackId, input.title);
  const [row] = await sql`
    INSERT INTO spots (track_id, slug, title, subtitle, trigger_kind, center, radius_m, region,
                       sequence_key, sequence_index, modes, guide_id, locating, status)
    VALUES (
      ${input.trackId}, ${slug}, ${input.title}, ${input.subtitle ?? ""},
      ${input.trigger.kind}, ${spotCenterWkt(input)}::geography, ${input.trigger.radiusM},
      ${region}::geography,
      ${input.sequence?.key ?? null}, ${input.sequence?.index ?? null},
      ${input.modes ?? []},
      ${input.guideId ?? null}, ${sql.json((input.locating ?? LOCATING_FALLBACK) as never)},
      ${input.status ?? "draft"}
    )
    RETURNING ${sql.unsafe(SPOT_COLS)}
  `;
  return rowToSpot(row);
}

export async function updateSpot(
  sql: Sql,
  id: string,
  input: SpotInput,
): Promise<Spot | null> {
  const region = input.trigger.region ? polygonWkt(input.trigger.region) : null;
  const [row] = await sql`
    UPDATE spots SET
      track_id = ${input.trackId},
      title = ${input.title},
      subtitle = ${input.subtitle ?? ""},
      trigger_kind = ${input.trigger.kind},
      center = ${spotCenterWkt(input)}::geography,
      radius_m = ${input.trigger.radiusM},
      region = ${region}::geography,
      sequence_key = ${input.sequence?.key ?? null},
      sequence_index = ${input.sequence?.index ?? null},
      modes = ${input.modes ?? []},
      guide_id = ${input.guideId ?? null},
      locating = COALESCE(${input.locating ? sql.json(input.locating as never) : null}, locating),
      status = ${input.status ?? "draft"},
      updated_at = now()
    WHERE id = ${id}
    RETURNING ${sql.unsafe(SPOT_COLS)}
  `;
  return row ? rowToSpot(row) : null;
}

/** Delete a spot (content pieces cascade). Returns true if a row was removed. */
export async function deleteSpot(sql: Sql, id: string): Promise<boolean> {
  const rows = await sql`DELETE FROM spots WHERE id = ${id} RETURNING id`;
  return rows.length > 0;
}

/** Targeted update of just the locating instructions (e.g. after clip TTS). */
export async function updateSpotLocating(
  sql: Sql,
  id: string,
  locating: Locating,
): Promise<Spot | null> {
  const [row] = await sql`
    UPDATE spots SET locating = ${sql.json(locating as never)}, updated_at = now()
    WHERE id = ${id}
    RETURNING ${sql.unsafe(SPOT_COLS)}
  `;
  return row ? rowToSpot(row) : null;
}

// ─── Content pieces ──────────────────────────────────────────────────────────

export async function listContentForSpot(sql: Sql, spotId: string): Promise<ContentPiece[]> {
  const rows = await sql`SELECT * FROM content_pieces WHERE spot_id = ${spotId} ORDER BY created_at DESC`;
  return rows.map(rowToContent);
}

/** Insert or update by (spot, locale, variant). */
export async function upsertContent(
  sql: Sql,
  input: ContentPieceInput,
): Promise<ContentPiece> {
  const [row] = await sql`
    INSERT INTO content_pieces (spot_id, locale, variant, document, audio_url, duration_ms, source, provenance, status)
    VALUES (
      ${input.spotId}, ${input.locale ?? "en"}, ${input.variant ?? "default"},
      ${input.document ? sql.json(input.document as never) : null},
      ${input.audioUrl ?? null}, ${input.durationMs ?? null},
      ${input.source}, ${input.provenance ? sql.json(input.provenance as never) : null},
      ${input.status ?? "draft"}
    )
    ON CONFLICT (spot_id, locale, variant) DO UPDATE SET
      document = EXCLUDED.document,
      audio_url = EXCLUDED.audio_url,
      duration_ms = EXCLUDED.duration_ms,
      source = EXCLUDED.source,
      provenance = EXCLUDED.provenance,
      status = EXCLUDED.status,
      updated_at = now()
    RETURNING *
  `;
  return rowToContent(row);
}

export async function setContentStatus(
  sql: Sql,
  id: string,
  status: string,
): Promise<ContentPiece | null> {
  const [row] = await sql`
    UPDATE content_pieces SET status = ${status}, updated_at = now()
    WHERE id = ${id} RETURNING *
  `;
  return row ? rowToContent(row) : null;
}

// ─── Fill-in items ───────────────────────────────────────────────────────────

/**
 * A fill-in item's content columns live on its own row (see 006_fillin.sql),
 * surfaced as a ContentPiece so every player/transcript consumer works
 * unchanged. `spotId` carries the item's own id — there is no spot.
 */
function rowToFillInItem(r: any): FillInItem {
  const hasContent = r.document != null || r.audio_url != null;
  return {
    id: r.id,
    trackId: r.track_id,
    moduleType: r.module_type,
    payload: r.payload,
    order: r.sort_order ?? null,
    content: hasContent
      ? {
          id: r.id,
          spotId: r.id,
          locale: "en",
          variant: "default",
          document: r.document ?? null,
          audioUrl: r.audio_url ?? null,
          durationMs: r.duration_ms ?? null,
          source: r.source,
          provenance: r.provenance ?? null,
          status: r.status,
          createdAt: new Date(r.created_at).toISOString(),
          updatedAt: new Date(r.updated_at).toISOString(),
        }
      : null,
    status: r.status,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

export async function getFillInItem(sql: Sql, id: string): Promise<FillInItem | null> {
  const [row] = await sql`SELECT * FROM fillin_items WHERE id = ${id}`;
  return row ? rowToFillInItem(row) : null;
}

/** All of a track's items regardless of status (admin authoring list). */
export async function listFillInItems(sql: Sql, trackId: string): Promise<FillInItem[]> {
  const rows = await sql`
    SELECT * FROM fillin_items WHERE track_id = ${trackId}
    ORDER BY sort_order ASC NULLS LAST, created_at ASC
  `;
  return rows.map(rowToFillInItem);
}

/**
 * Published items for the given fill-in track slugs (the public read path).
 * A ROTATING RANDOM SAMPLE, not a stable page: a track can hold thousands of
 * items (a 10k vocab list) while the client fetches at most `limit`, and
 * playback shuffles anyway — each app launch just draws a fresh hand.
 */
export async function listPublishedFillInItems(
  sql: Sql,
  trackSlugs: string[],
  limit: number,
): Promise<FillInItem[]> {
  const rows = await sql`
    SELECT f.* FROM fillin_items f
    JOIN tracks t ON t.id = f.track_id
    WHERE f.status = 'published'
      AND t.kind = 'fillin'
      AND t.visibility = 'public'
      AND t.slug = ANY(${trackSlugs})
    ORDER BY random()
    LIMIT ${limit}
  `;
  return rows.map(rowToFillInItem);
}

export async function createFillInItem(
  sql: Sql,
  input: FillInItemInput,
): Promise<FillInItem> {
  const [row] = await sql`
    INSERT INTO fillin_items (track_id, module_type, payload, sort_order, status)
    VALUES (
      ${input.trackId}, ${input.moduleType}, ${sql.json(input.payload as never)},
      ${input.order ?? null}, ${input.status ?? "draft"}
    )
    RETURNING *
  `;
  return rowToFillInItem(row);
}

export async function updateFillInItem(
  sql: Sql,
  id: string,
  input: FillInItemInput,
): Promise<FillInItem | null> {
  // Omitted order/status keep their stored values (an edit to the payload
  // must not silently unpublish the item or wipe its position).
  const [row] = await sql`
    UPDATE fillin_items SET
      payload = ${sql.json(input.payload as never)},
      sort_order = COALESCE(${input.order ?? null}, sort_order),
      status = COALESCE(${input.status ?? null}, status),
      updated_at = now()
    WHERE id = ${id}
    RETURNING *
  `;
  return row ? rowToFillInItem(row) : null;
}

export async function deleteFillInItem(sql: Sql, id: string): Promise<boolean> {
  const rows = await sql`DELETE FROM fillin_items WHERE id = ${id} RETURNING id`;
  return rows.length > 0;
}

/** Attach generated narration (filo doc + audio) to an item. */
export async function setFillInItemContent(
  sql: Sql,
  id: string,
  content: {
    document: unknown;
    audioUrl: string | null;
    durationMs: number | null;
    source: string;
    provenance: unknown;
  },
): Promise<FillInItem | null> {
  const [row] = await sql`
    UPDATE fillin_items SET
      document = ${content.document ? sql.json(content.document as never) : null},
      audio_url = ${content.audioUrl},
      duration_ms = ${content.durationMs},
      source = ${content.source},
      provenance = ${content.provenance ? sql.json(content.provenance as never) : null},
      updated_at = now()
    WHERE id = ${id}
    RETURNING *
  `;
  return row ? rowToFillInItem(row) : null;
}

export async function setFillInItemStatus(
  sql: Sql,
  id: string,
  status: string,
): Promise<FillInItem | null> {
  const [row] = await sql`
    UPDATE fillin_items SET status = ${status}, updated_at = now()
    WHERE id = ${id} RETURNING *
  `;
  return row ? rowToFillInItem(row) : null;
}

// ─── Nearby assembly ─────────────────────────────────────────────────────────

/**
 * Which side of the traveler a spot falls on, given the compass bearing from
 * the traveler to the spot and the traveler's course (both degrees, 0 = N).
 * Bearings within (0°, 180°) clockwise of the course are to the right.
 * Returns null when either angle is unknown.
 */
export function preferredSide(
  azimuthDeg: number | null,
  courseDeg: number | undefined,
): "left" | "right" | null {
  if (azimuthDeg == null || courseDeg == null) return null;
  const rel = (((azimuthDeg - courseDeg) % 360) + 360) % 360;
  return rel < 180 ? "right" : "left";
}

/**
 * Rank a spot's published pieces for one request. Lower is better:
 * locale match, then has-audio, then recency.
 */
function pickContent(pieces: ContentPiece[], locale: string): ContentPiece | null {
  const ranked = [...pieces].sort((a, b) => {
    const la = a.locale === locale ? 0 : 1;
    const lb = b.locale === locale ? 0 : 1;
    if (la !== lb) return la - lb;
    const aa = a.audioUrl ? 0 : 1;
    const ab = b.audioUrl ? 0 : 1;
    if (aa !== ab) return aa - ab;
    return a.updatedAt < b.updatedAt ? 1 : -1;
  });
  return ranked[0] ?? null;
}

/**
 * Resolve a spot's locating instructions for one traveler. Directional
 * templates need a known course — without one we return null rather than
 * guess a side. Clips may be missing (not yet TTS'd): text still resolves,
 * audioUrl is null.
 */
export function resolveLocating(
  locating: Locating,
  azimuthDeg: number | null,
  courseDeg: number | undefined,
): LocatingResolved | null {
  const template = locatingTemplate(locating);
  if (!template) return null;
  if (template.includes(SIDE_TOKEN)) {
    const side = preferredSide(azimuthDeg, courseDeg);
    if (!side) return null;
    const clip = locating.clips[side];
    return {
      text: template.replaceAll(SIDE_TOKEN, side),
      audioUrl: clip?.audioUrl ?? null,
      durationMs: clip?.durationMs ?? null,
    };
  }
  const clip = locating.clips.fixed;
  return {
    text: template,
    audioUrl: clip?.audioUrl ?? null,
    durationMs: clip?.durationMs ?? null,
  };
}

/**
 * Given nearby spot rows, fetch the best published content piece for each
 * (preferring the requested locale, else any), resolve locating instructions
 * for this traveler's course, and attach the promoted guide.
 *
 * `locale` is the default; `trackLocales` (by track slug) overrides it for
 * specific tracks, so a traveler can hear one track in a different language
 * than the rest of their active tracks in the same query.
 */
export async function assembleNearby(
  sql: Sql,
  rows: NearbySpotRow[],
  locale: string,
  courseDeg?: number,
  trackLocales: Record<string, string> = {},
): Promise<NearbySpot[]> {
  if (rows.length === 0) return [];
  const spotIds = rows.map((r) => r.spot_id);
  const guideIds = rows.map((r) => r.guide_id).filter((g): g is string => !!g);

  const contentRows = await sql`
    SELECT * FROM content_pieces
    WHERE spot_id = ANY(${spotIds}) AND status = 'published'
  `;
  const piecesBySpot = new Map<string, ContentPiece[]>();
  for (const r of contentRows) {
    const list = piecesBySpot.get(r.spot_id) ?? [];
    list.push(rowToContent(r));
    piecesBySpot.set(r.spot_id, list);
  }
  const contentBySpot = new Map<string, ContentPiece>();
  for (const r of rows) {
    const pieces = piecesBySpot.get(r.spot_id);
    if (!pieces?.length) continue;
    const best = pickContent(pieces, trackLocales[r.track_slug] ?? locale);
    if (best) contentBySpot.set(r.spot_id, best);
  }

  const guideBySpot = new Map<string, Guide>();
  if (guideIds.length) {
    const guideRows = await sql`SELECT * FROM guides WHERE id = ANY(${guideIds})`;
    const byId = new Map(guideRows.map((g) => [g.id, rowToGuide(g)]));
    for (const r of rows) {
      if (r.guide_id && byId.has(r.guide_id)) guideBySpot.set(r.spot_id, byId.get(r.guide_id)!);
    }
  }

  return rows.map((r) => ({
    spot: rowToSpot(r),
    // Area spots have no "where to look": the traveler is inside them, and
    // the azimuth to a centroid you're standing in would point nowhere.
    locating:
      r.trigger_kind === "area"
        ? null
        : resolveLocating(parseLocating(r.locating), r.azimuth_deg, courseDeg),
    track: rowToTrack({
      id: r.track_id,
      slug: r.track_slug,
      name: r.track_name,
      description: r.track_description,
      kind: r.track_kind,
      lifecycle: r.track_lifecycle,
      icon: r.track_icon,
      color: r.track_color,
      official: r.track_official,
      created_at: r.track_created_at,
    }),
    distanceM: Number(r.distance_m),
    triggered: r.triggered,
    content: contentBySpot.get(r.spot_id) ?? null,
    guide: guideBySpot.get(r.spot_id) ?? null,
  }));
}
