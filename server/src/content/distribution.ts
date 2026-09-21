import type { Index, TrackExport } from "@grandtour/shared";
import { buildIndex, summarizeTrack, voicedOnly } from "@grandtour/shared";
import type { Sql } from "../db";
import { exportTrack, listTracks } from "./repo";

/**
 * The distribution index, built from the database: every tour track with
 * voiced published spots, each as a full bundle, plus the index describing
 * them. The shaping itself is pure and lives in `@grandtour/shared`
 * (`voicedOnly`, `summarizeTrack`, `buildIndex`), so the content repository,
 * the live routes and the clients apply the same rules to the same files.
 *
 * Public by default: `listTracks(sql)` applies `tracks.visibility`, so a
 * held track drops out of the index in the same flip that hides it from
 * `/api/tracks`. `includeHeld` is for the private content repository, whose
 * index marks each held track `visibility: "private"`.
 *
 * `extra` lets a caller add bundles the database cannot produce yet — the
 * Going-to-the-Sun Road tour is built by its own script and its spots are
 * still drafts, so `exportTrack` would return it empty.
 */
export interface IndexBuild {
  index: Index;
  bundles: Map<string, TrackExport>;
}

export interface IndexBuildOptions {
  extra?: TrackExport[];
  includeHeld?: boolean;
  /** Where each bundle will be served relative to the index; default `tours/<slug>.grandtour.json`. */
  url?: (slug: string) => string;
}

export async function buildIndexFromDb(sql: Sql, options: IndexBuildOptions = {}): Promise<IndexBuild> {
  const tracks = (await listTracks(sql, options.includeHeld ?? false)).filter((t) => t.kind === "tour");
  const bundles = new Map<string, TrackExport>();

  for (const track of tracks) {
    const exported = await exportTrack(sql, track.id);
    if (!exported) continue;
    const bundle = voicedOnly(exported);
    if (bundle.spots.length > 0) bundles.set(bundle.track.slug, bundle);
  }
  for (const bundle of options.extra ?? []) {
    if (!bundles.has(bundle.track.slug) && bundle.spots.length > 0) bundles.set(bundle.track.slug, bundle);
  }

  const entries = [...bundles.values()].flatMap((b) => summarizeTrack(b, { url: options.url?.(b.track.slug) }) ?? []);
  for (const slug of bundles.keys()) {
    if (!entries.some((e) => e.slug === slug)) bundles.delete(slug);
  }
  return { index: buildIndex(entries, { name: "GrandTour" }), bundles };
}
