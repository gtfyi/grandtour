import type { Sql } from "../db";
import type { LngLat, PolygonRing } from "@grandtour/shared";

/**
 * Build a PostGIS point literal from a coordinate. ST_MakePoint takes (lng, lat).
 */
export function pointWkt(p: LngLat): string {
  return `SRID=4326;POINT(${p.lng} ${p.lat})`;
}

/**
 * Build a closed PostGIS polygon literal from a ring of coordinates.
 * The ring is auto-closed (first vertex repeated) as WKT requires.
 */
export function polygonWkt(ring: PolygonRing): string {
  const pts = ring.map((p) => `${p.lng} ${p.lat}`);
  if (pts[0] !== pts[pts.length - 1]) pts.push(pts[0]!);
  return `SRID=4326;POLYGON((${pts.join(", ")}))`;
}

/** A spot row joined with its track, distance, and trigger state. */
export interface NearbySpotRow {
  spot_id: string;
  track_id: string;
  slug: string;
  title: string;
  subtitle: string;
  trigger_kind: string;
  center: { type: "Point"; coordinates: [number, number] };
  radius_m: number;
  region: { type: "Polygon"; coordinates: number[][][] } | null;
  sequence_key: string | null;
  sequence_index: number | null;
  modes: string[];
  guide_id: string | null;
  locating: unknown;
  status: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  distance_m: number;
  /** Compass bearing (degrees, 0=N) from the query point to the spot center; null at zero distance. */
  azimuth_deg: number | null;
  triggered: boolean;
  // track
  track_slug: string;
  track_name: string;
  track_description: string;
  track_kind: string;
  track_icon: string | null;
  track_color: string | null;
  track_official: boolean;
  track_created_at: string;
  track_lifecycle: string;
}

export interface NearbyParams {
  lat: number;
  lng: number;
  /** Outer search cap, meters. */
  radiusM: number;
  /** Track slugs to include; empty = all. */
  tracks: string[];
  mode?: string | undefined;
  limit: number;
}

/**
 * Spots along a planned route: everything published within `corridorM` of the
 * polyline, ordered by where along the route they appear (so the app can
 * prefetch in travel order). Same GiST-indexed ST_DWithin as `findNearby`,
 * just against a LineString geography instead of a point. Area spots join
 * when their fence intersects the corridor (indexed via `region`), ordered by
 * their representative center like everything else.
 *
 * `triggered` is always false (the traveler isn't there yet) and no azimuth
 * is computed (no course to resolve a side against).
 */
export async function findAlongRoute(
  sql: Sql,
  p: {
    points: { lat: number; lng: number }[];
    corridorM: number;
    tracks: string[];
    mode?: string | undefined;
    limit: number;
  },
): Promise<NearbySpotRow[]> {
  const lineWkt =
    "SRID=4326;LINESTRING(" +
    p.points.map((pt) => `${pt.lng} ${pt.lat}`).join(",") +
    ")";

  return sql<NearbySpotRow[]>`
    SELECT
      s.id            AS spot_id,
      s.track_id      AS track_id,
      s.slug,
      s.title,
      s.subtitle,
      s.trigger_kind,
      ST_AsGeoJSON(s.center)::json  AS center,
      s.radius_m,
      ST_AsGeoJSON(s.region)::json  AS region,
      s.sequence_key,
      s.sequence_index,
      s.modes,
      s.guide_id,
      s.locating,
      s.status,
      s.created_by,
      s.created_at,
      s.updated_at,
      CASE WHEN s.trigger_kind = 'area'
           THEN ST_Distance(s.region, ${lineWkt}::geography)
           ELSE ST_Distance(s.center, ${lineWkt}::geography)
      END AS distance_m,
      NULL::float8 AS azimuth_deg,
      false AS triggered,
      l.slug          AS track_slug,
      l.name          AS track_name,
      l.description   AS track_description,
      l.kind          AS track_kind,
      l.icon          AS track_icon,
      l.color         AS track_color,
      l.official      AS track_official,
      l.created_at    AS track_created_at,
      l.lifecycle     AS track_lifecycle
    FROM spots s
    JOIN tracks l ON l.id = s.track_id
    WHERE s.status = 'published'
      AND l.kind = 'tour'
      AND l.visibility = 'public'
      AND (
        (s.trigger_kind <> 'area' AND ST_DWithin(s.center, ${lineWkt}::geography, ${p.corridorM}))
        OR (s.trigger_kind = 'area' AND ST_DWithin(s.region, ${lineWkt}::geography, ${p.corridorM}))
      )
      ${p.tracks.length ? sql`AND l.slug = ANY(${p.tracks})` : sql``}
      ${p.mode ? sql`AND (cardinality(s.modes) = 0 OR ${p.mode} = ANY(s.modes))` : sql``}
    ORDER BY ST_LineLocatePoint(${lineWkt}::geometry, s.center::geometry) ASC
    LIMIT ${p.limit}
  `;
}

/**
 * Newest change timestamp among published spots (and their published content)
 * within `radiusM` of the point, or null when nothing is in range.
 *
 * This is the cheap half of polling: clients send back the previous value as
 * `changedSince`, and we skip the full assembly when it hasn't moved. Content
 * edits count too — republishing narration for a spot the traveler is
 * approaching should reach them without waiting for them to move.
 */
export async function nearbyDataVersion(
  sql: Sql,
  p: Omit<NearbyParams, "limit">,
): Promise<string | null> {
  const userPoint = `SRID=4326;POINT(${p.lng} ${p.lat})`;
  // The range condition must stay identical to findNearby's, or the
  // unchanged-gate would skip areas the full query would return.
  const [row] = await sql<{ version: Date | null }[]>`
    SELECT GREATEST(MAX(s.updated_at), MAX(c.updated_at)) AS version
    FROM spots s
    JOIN tracks l ON l.id = s.track_id
    LEFT JOIN content_pieces c
      ON c.spot_id = s.id AND c.status = 'published'
    WHERE s.status = 'published'
      AND l.kind = 'tour'
      AND l.visibility = 'public'
      AND (
        (s.trigger_kind <> 'area' AND ST_DWithin(s.center, ${userPoint}::geography, ${p.radiusM}))
        OR (s.trigger_kind = 'area' AND ST_DWithin(s.region, ${userPoint}::geography, ${p.radiusM}))
      )
      ${p.tracks.length ? sql`AND l.slug = ANY(${p.tracks})` : sql``}
      ${p.mode ? sql`AND (cardinality(s.modes) = 0 OR ${p.mode} = ANY(s.modes))` : sql``}
  `;
  return row?.version ? new Date(row.version).toISOString() : null;
}

/**
 * The core trigger query, kind-aware.
 *
 * `point` spots (the default): returned when their center is within the
 * outer `radiusM` cap; `triggered` when the user is within the spot's own
 * radius_m OR inside its optional precise region boundary.
 *
 * `area` spots: in/out is decided entirely by the fence polygon in `region` —
 * returned when the fence is within the cap, `triggered` when the user is
 * inside it, and `distance_m` measured to the fence (0 inside), so being
 * anywhere in the fence never reads as "far away". Azimuth is null: there is
 * no direction to a place you are standing in, and locating is skipped for
 * them at assembly.
 *
 * `ST_DWithin(geography, geography, m)` uses the GiST index on `center`; the
 * region checks use the GiST index on `region`.
 */
export async function findNearby(
  sql: Sql,
  p: NearbyParams,
): Promise<NearbySpotRow[]> {
  const userPoint = `SRID=4326;POINT(${p.lng} ${p.lat})`;

  return sql<NearbySpotRow[]>`
    SELECT
      s.id            AS spot_id,
      s.track_id      AS track_id,
      s.slug,
      s.title,
      s.subtitle,
      s.trigger_kind,
      ST_AsGeoJSON(s.center)::json  AS center,
      s.radius_m,
      ST_AsGeoJSON(s.region)::json  AS region,
      s.sequence_key,
      s.sequence_index,
      s.modes,
      s.guide_id,
      s.locating,
      s.status,
      s.created_by,
      s.created_at,
      s.updated_at,
      CASE WHEN s.trigger_kind = 'area'
           THEN ST_Distance(s.region, ${userPoint}::geography)
           ELSE ST_Distance(s.center, ${userPoint}::geography)
      END AS distance_m,
      CASE WHEN s.trigger_kind = 'area'
           THEN NULL::float8
           ELSE degrees(ST_Azimuth(${userPoint}::geography, s.center))
      END AS azimuth_deg,
      CASE WHEN s.trigger_kind = 'area'
           THEN ST_Covers(s.region, ${userPoint}::geography)
           ELSE (
             ST_DWithin(s.center, ${userPoint}::geography, s.radius_m)
             OR (s.region IS NOT NULL AND ST_Covers(s.region, ${userPoint}::geography))
           )
      END AS triggered,
      l.slug          AS track_slug,
      l.name          AS track_name,
      l.description   AS track_description,
      l.kind          AS track_kind,
      l.icon          AS track_icon,
      l.color         AS track_color,
      l.official      AS track_official,
      l.created_at    AS track_created_at,
      l.lifecycle     AS track_lifecycle
    FROM spots s
    JOIN tracks l ON l.id = s.track_id
    WHERE s.status = 'published'
      AND l.kind = 'tour'
      AND l.visibility = 'public'
      AND (
        (s.trigger_kind <> 'area' AND ST_DWithin(s.center, ${userPoint}::geography, ${p.radiusM}))
        OR (s.trigger_kind = 'area' AND ST_DWithin(s.region, ${userPoint}::geography, ${p.radiusM}))
      )
      ${p.tracks.length ? sql`AND l.slug = ANY(${p.tracks})` : sql``}
      ${p.mode ? sql`AND (cardinality(s.modes) = 0 OR ${p.mode} = ANY(s.modes))` : sql``}
    ORDER BY distance_m ASC
    LIMIT ${p.limit}
  `;
}
