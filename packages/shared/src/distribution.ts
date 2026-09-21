import { z } from "zod";
import { AreaId, areasOf } from "./area";
import type { TrackExport } from "./api";
import { TrackLifecycle, TrackVisibility } from "./content";
import { LngLat, haversineM, triggerAnchor } from "./geo";

/**
 * Distribution: how content reaches players.
 *
 * A GrandTour *server* is any base URL that serves an index file matching
 * this schema and the files it points to — a website, a GitHub repository
 * served raw, a directory on a laptop, or the authoring server. Nothing
 * else is required. The index says where the tours live; the tours say
 * where the data lives:
 *
 *   <base>/grandtour.json                Index: one entry per track, with the bundle's URL
 *   <base>/tours/<slug>.grandtour.json   TrackExport, audio by absolute public URL
 *
 * Track URLs in the index resolve against the index's own URL, so a
 * checkout and a website serve identical files. Audio URLs are absolute:
 * the bytes live wherever the bundle says — our bucket, a park service's
 * site — and nothing rewrites them.
 *
 * A client fetches the index, keeps the tracks whose `areas` meet the cells
 * around its own position (`areasAround`), fetches those bundles whole, and
 * evaluates triggers locally. No position ever leaves the device; the
 * server only ever sees which files were asked for.
 */
export const FORMAT_VERSION = 1;
export const INDEX_FILE = "grandtour.json";
export const TOURS_DIR = "tours";

export const IndexTrack = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  description: z.string().default(""),
  color: z.string().optional(),
  icon: z.string().optional(),
  lifecycle: TrackLifecycle,
  official: z.boolean(),
  /** Only a private index carries this; a public index holds public tracks alone. */
  visibility: TrackVisibility.optional(),
  /** The bundle: absolute, or relative to the index's own URL. */
  url: z.string().min(1),
  spotCount: z.number().int().nonnegative(),
  /** Spots with at least one recorded narration. */
  voicedCount: z.number().int().nonnegative(),
  /** Recorded narration, in minutes. */
  minutes: z.number().nonnegative(),
  /** Mean of the spot anchors — for "how far is this track from me". */
  center: LngLat,
  /** Rough diameter of the track's footprint. */
  spanKm: z.number().nonnegative(),
  /** Every area cell the track's triggers touch: the selection key. */
  areas: z.array(AreaId).default([]),
  /** SHA-256 and size of the bundle file, for cache validation and sync. */
  hash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  bytes: z.number().int().nonnegative().optional(),
  createdAt: z.string().datetime(),
});
export type IndexTrack = z.infer<typeof IndexTrack>;

export const Index = z.object({
  formatVersion: z.number().int().positive().default(FORMAT_VERSION),
  generatedAt: z.string().datetime(),
  name: z.string().optional(),
  description: z.string().optional(),
  /** Where this index was built from. */
  source: z.object({ repo: z.string().optional(), commit: z.string().optional() }).optional(),
  tracks: z.array(IndexTrack),
});
export type Index = z.infer<typeof Index>;

/**
 * Where a server's index is, from however a user names the server:
 * `grandtour.fyi`, `https://example.org/tours/`, `http://localhost:8787`, a
 * GitHub repository (`github.com/gtfyi/content`, served raw from its
 * default branch or the branch and folder in a `/tree/` link), or an
 * explicit `.json` URL.
 */
export function indexUrl(server: string): string {
  let s = server.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  const u = new URL(s);
  if (u.hostname === "github.com" || u.hostname === "www.github.com") {
    const [owner, repo, kind, branch, ...rest] = u.pathname.split("/").filter(Boolean);
    if (!owner || !repo) throw new Error(`not a GitHub repository: ${server}`);
    const ref = kind === "tree" && branch ? branch : "main";
    const dir = kind === "tree" ? rest.join("/") : "";
    return `https://raw.githubusercontent.com/${owner}/${repo.replace(/\.git$/, "")}/${ref}/${dir ? `${dir}/` : ""}${INDEX_FILE}`;
  }
  if (u.pathname.endsWith(".json")) return u.href;
  if (!u.pathname.endsWith("/")) u.pathname += "/";
  u.search = "";
  u.hash = "";
  return new URL(INDEX_FILE, u).href;
}

/** A track's bundle URL, resolved against the index it came from. */
export function resolveTrackUrl(track: IndexTrack, indexUrl: string): string {
  return new URL(track.url, indexUrl).href;
}

/**
 * Keep only spots with a recording, and only their recorded pieces. The phone
 * defaults to "server audio only" and never auto-plays an unvoiced story; the
 * distribution holds the same bar rather than shipping scripts that would be
 * read in a robot voice.
 */
export function voicedOnly(bundle: TrackExport): TrackExport {
  const spots = bundle.spots
    .map(({ spot, content }) => ({ spot, content: content.filter((c) => !!c.audioUrl) }))
    .filter(({ content }) => content.length > 0);
  return { ...bundle, spots, track: { ...bundle.track, spotCount: spots.length } };
}

/**
 * When the bundle's content last changed: the newest `updatedAt` it carries.
 * Used as `exportedAt` so an unchanged track exports byte-for-byte the same.
 */
export function stableExportedAt(bundle: TrackExport): string {
  let latest = bundle.track.createdAt;
  const consider = (t: string | undefined) => { if (t && t > latest) latest = t; };
  for (const { spot, content } of bundle.spots) {
    consider(spot.updatedAt);
    for (const c of content) consider(c.updatedAt);
  }
  for (const item of bundle.fillInItems ?? []) consider(item.updatedAt);
  return latest;
}

/** Every audio URL a bundle names: narrations, locating clips, fill-in items. */
export function audioRefsOf(bundle: TrackExport): string[] {
  const out = new Set<string>();
  for (const { spot, content } of bundle.spots) {
    for (const c of content) if (c.audioUrl) out.add(c.audioUrl);
    for (const clip of Object.values(spot.locating.clips)) if (clip?.audioUrl) out.add(clip.audioUrl);
  }
  for (const item of bundle.fillInItems ?? []) if (item.content?.audioUrl) out.add(item.content.audioUrl);
  return [...out].sort();
}

/** The same bundle with every audio URL passed through `f`. */
/**
 * Tiers the players use: `audio` (time ranges → byte ranges, the spoken-text
 * highlight) and `sentence`. The `word` tier is 80 % of a bundle and no
 * client reads it, so the distribution leaves it out; the authoring
 * database keeps the full document.
 */
export const DISTRIBUTED_TIERS: ReadonlySet<string> = new Set(["audio", "sentence"]);

/** The distribution's document cut: only `DISTRIBUTED_TIERS` travel. */
export function slimDocuments(bundle: TrackExport): TrackExport {
  return {
    ...bundle,
    spots: bundle.spots.map((s) => ({
      ...s,
      content: s.content.map((c) =>
        c.document ? { ...c, document: { ...c.document, tiers: c.document.tiers.filter((t) => DISTRIBUTED_TIERS.has(t.kind)) } } : c),
    })),
  };
}

export function mapAudioRefs(bundle: TrackExport, f: (ref: string) => string): TrackExport {
  const clips = (c: TrackExport["spots"][number]["spot"]["locating"]["clips"]) =>
    Object.fromEntries(Object.entries(c).map(([side, clip]) => [side, clip && { ...clip, audioUrl: f(clip.audioUrl) }]));
  return {
    ...bundle,
    spots: bundle.spots.map(({ spot, content }) => ({
      spot: { ...spot, locating: { ...spot.locating, clips: clips(spot.locating.clips) } },
      content: content.map((c) => ({ ...c, audioUrl: c.audioUrl && f(c.audioUrl) })),
    })),
    fillInItems: bundle.fillInItems?.map((item) => ({
      ...item,
      content: item.content && { ...item.content, audioUrl: item.content.audioUrl && f(item.content.audioUrl) },
    })),
  };
}

/** The index entry for a bundle, or null when nothing in it can be placed on a map. */
export function summarizeTrack(
  bundle: TrackExport,
  file: { url?: string; hash?: string; bytes?: number } = {},
): IndexTrack | null {
  const anchors = bundle.spots
    .map((s) => triggerAnchor(s.spot.trigger))
    .filter((p): p is LngLat => p !== null);
  if (anchors.length === 0) return null;

  const center: LngLat = {
    lat: anchors.reduce((sum, a) => sum + a.lat, 0) / anchors.length,
    lng: anchors.reduce((sum, a) => sum + a.lng, 0) / anchors.length,
  };
  const spanKm = (2 * Math.max(0, ...anchors.map((a) => haversineM(center, a)))) / 1000;

  let voicedCount = 0;
  let durationMs = 0;
  for (const { content } of bundle.spots) {
    const voiced = content.find((c) => c.audioUrl);
    if (!voiced) continue;
    voicedCount++;
    durationMs += voiced.durationMs ?? 0;
  }

  const { track } = bundle;
  return IndexTrack.parse({
    id: track.id,
    slug: track.slug,
    name: track.name,
    description: track.description,
    color: track.color,
    icon: track.icon,
    lifecycle: track.lifecycle,
    official: track.official,
    visibility: track.visibility,
    url: file.url ?? `${TOURS_DIR}/${track.slug}.grandtour.json`,
    spotCount: bundle.spots.length,
    voicedCount,
    minutes: Math.round(durationMs / 6000) / 10,
    center,
    spanKm: Math.round(spanKm * 10) / 10,
    areas: areasOf(bundle.spots.map((s) => s.spot.trigger)),
    hash: file.hash,
    bytes: file.bytes,
    createdAt: track.createdAt,
  });
}

/** Official tracks first, then by name. */
export function buildIndex(
  entries: IndexTrack[],
  meta: { generatedAt?: string; name?: string; description?: string; source?: Index["source"] } = {},
): Index {
  const tracks = [...entries].sort(
    (a, b) => Number(b.official) - Number(a.official) || a.name.localeCompare(b.name),
  );
  return Index.parse({
    formatVersion: FORMAT_VERSION,
    generatedAt: meta.generatedAt ?? new Date().toISOString(),
    name: meta.name,
    description: meta.description,
    source: meta.source,
    tracks,
  });
}

/** The public face of an index: held tracks dropped, the visibility field gone. */
export function publicIndex(index: Index): Index {
  return {
    ...index,
    tracks: index.tracks
      .filter((t) => t.visibility !== "private")
      .map((t) => { const { visibility, ...rest } = t; void visibility; return rest; }),
  };
}

/** The entries whose footprint meets any of the given cells. */
export function tracksInAreas(index: Index, cells: Iterable<AreaId>): IndexTrack[] {
  const wanted = new Set(cells);
  return index.tracks.filter((t) => t.areas.some((a) => wanted.has(a)));
}
