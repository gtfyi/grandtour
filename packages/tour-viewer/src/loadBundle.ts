import { TrackExport } from "@grandtour/shared";

/** Load and validate a track bundle — one the server's index names, resolved by `resolveTrackUrl`. */
export async function loadBundle(url: string, signal?: AbortSignal): Promise<TrackExport> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Failed to fetch bundle: HTTP ${res.status}`);
  const json = await res.json();
  const parsed = TrackExport.safeParse(json);
  if (!parsed.success) {
    throw new Error(`Bundle doesn't match the expected shape: ${parsed.error.message}`);
  }
  return parsed.data;
}
