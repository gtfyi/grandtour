import type {
  ContentPiece,
  ContentPieceInput,
  FillInItem,
  FillInItemInput,
  GenerateRequest,
  IdentifyResponse,
  TrackExport,
  Track,
  Spot,
  SpotInput,
  VocabImportRequest,
} from "@grandtour/shared";

export const TOKEN_STORAGE_KEY = "grandtour_admin_token";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const token = localStorage.getItem(TOKEN_STORAGE_KEY);
  const res = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any).detail || (body as any).error || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  listTracks: () => req<{ tracks: Track[] }>("/api/admin/tracks").then((r) => r.tracks),

  createTrack: (input: Partial<Track>) =>
    req<{ track: Track }>("/api/admin/tracks", {
      method: "POST",
      body: JSON.stringify(input),
    }).then((r) => r.track),

  previewTrack: (id: string, signal?: AbortSignal) =>
    req<TrackExport>(`/api/admin/tracks/${id}/export`, { signal }),

  // Static bundle for the offline tour viewer. Fetched (not a raw link) so
  // the admin bearer token rides along; triggers a browser download.
  exportTrack: async (id: string, slug: string) => {
    const token = localStorage.getItem(TOKEN_STORAGE_KEY);
    const res = await fetch(`/api/admin/tracks/${id}/export`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`Export failed: HTTP ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${slug}.grandtour.json`;
    a.click();
    URL.revokeObjectURL(url);
  },

  listSpots: (trackId?: string) =>
    req<{ spots: Spot[] }>(`/api/admin/spots${trackId ? `?trackId=${trackId}` : ""}`).then(
      (r) => r.spots,
    ),

  // What is at this coordinate? Address + named POI candidates, nearest first.
  identify: (lat: number, lng: number) =>
    req<IdentifyResponse>(`/api/admin/identify?lat=${lat}&lng=${lng}`),

  // TTS just the locating clips for a spot (cheap, targeted).
  generateLocating: (spotId: string, input: { locale?: string; voiceId?: string } = {}) =>
    req<{ spot: Spot }>(`/api/admin/spots/${spotId}/locating/generate`, {
      method: "POST",
      body: JSON.stringify(input),
    }).then((r) => r.spot),

  getSpot: (id: string) =>
    req<{ spot: Spot; content: ContentPiece[] }>(`/api/admin/spots/${id}`),

  createSpot: (input: SpotInput) =>
    req<{ spot: Spot }>("/api/admin/spots", {
      method: "POST",
      body: JSON.stringify(input),
    }).then((r) => r.spot),

  updateSpot: (id: string, input: SpotInput) =>
    req<{ spot: Spot }>(`/api/admin/spots/${id}`, {
      method: "PUT",
      body: JSON.stringify(input),
    }).then((r) => r.spot),

  deleteSpot: (id: string) =>
    req<{ ok: boolean }>(`/api/admin/spots/${id}`, { method: "DELETE" }),

  saveContent: (input: ContentPieceInput) =>
    req<{ content: ContentPiece }>("/api/admin/content", {
      method: "PUT",
      body: JSON.stringify(input),
    }).then((r) => r.content),

  setContentStatus: (id: string, status: string) =>
    req<{ content: ContentPiece }>(`/api/admin/content/${id}/status`, {
      method: "POST",
      body: JSON.stringify({ status }),
    }).then((r) => r.content),

  generate: (spotId: string, input: GenerateRequest) =>
    req<{ content: ContentPiece }>(`/api/admin/spots/${spotId}/generate`, {
      method: "POST",
      body: JSON.stringify(input),
    }).then((r) => r.content),

  // ── Fill-in items (fillin tracks; no geometry) ──

  listFillInItems: (trackId: string) =>
    req<{ items: FillInItem[] }>(`/api/admin/fillin-items?trackId=${trackId}`).then(
      (r) => r.items,
    ),

  createFillInItem: (input: FillInItemInput) =>
    req<{ item: FillInItem }>("/api/admin/fillin-items", {
      method: "POST",
      body: JSON.stringify(input),
    }).then((r) => r.item),

  importVocab: (input: VocabImportRequest) =>
    req<{ items: FillInItem[] }>("/api/admin/fillin-items/import", {
      method: "POST",
      body: JSON.stringify(input),
    }).then((r) => r.items),

  updateFillInItem: (id: string, input: FillInItemInput) =>
    req<{ item: FillInItem }>(`/api/admin/fillin-items/${id}`, {
      method: "PUT",
      body: JSON.stringify(input),
    }).then((r) => r.item),

  deleteFillInItem: (id: string) =>
    req<{ ok: boolean }>(`/api/admin/fillin-items/${id}`, { method: "DELETE" }),

  setFillInItemStatus: (id: string, status: string) =>
    req<{ item: FillInItem }>(`/api/admin/fillin-items/${id}/status`, {
      method: "POST",
      body: JSON.stringify({ status }),
    }).then((r) => r.item),

  generateFillInAudio: (id: string, input: { voiceId?: string; pauseSeconds?: number } = {}) =>
    req<{ item: FillInItem }>(`/api/admin/fillin-items/${id}/generate`, {
      method: "POST",
      body: JSON.stringify(input),
    }).then((r) => r.item),

  // Public nearby query, handy for previewing what the app would receive.
  nearby: (lat: number, lng: number, radiusM = 2000) =>
    req<{ spots: any[] }>(`/api/nearby?lat=${lat}&lng=${lng}&radiusM=${radiusM}`),
};
