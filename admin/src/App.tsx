import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ContentPiece,
  Locating,
  Track,
  LngLat,
  PlaceCandidate,
  PolygonRing,
  Spot,
} from "@grandtour/shared";
import {
  DEFAULT_LOCATING_TEMPLATE,
  SIDE_TOKEN,
  locatingTemplate,
  slugify,
  triggerAnchor,
  trackCountLabel,
} from "@grandtour/shared";
import { api, TOKEN_STORAGE_KEY } from "./api";
import { MapView } from "./MapView";
import { ContentEditor } from "./ContentEditor";
import { DriveMode } from "./DriveMode";
import { FillInPanel } from "./FillInPanel";
import { triggerFromDraft } from "./spotDraft";

interface DraftSpot {
  id: string | null;
  trackId: string;
  title: string;
  subtitle: string;
  /** "point" (arrive → play) or "area" (anywhere in the fence, gap-scheduled). */
  kind: "point" | "area";
  center: LngLat;
  radiusM: number;
  region?: PolygonRing;
  /** Ordered-story membership; empty key = not sequenced. */
  sequenceKey: string;
  sequenceIndex: number;
  locating: Locating;
  status: string;
  modes: Spot["modes"];
  guideId?: string;
}

const DEFAULT_LOCATING: Locating = { mode: "auto", clips: {} };

function sequenceFromDraft(d: DraftSpot) {
  const key = d.sequenceKey.trim();
  return key ? { key, index: d.sequenceIndex } : undefined;
}

/**
 * URL scheme — copy-pasteable admin state:
 *   /                        track chooser (pick or create a track)
 *   /:trackSlug              working in a track: map + its spots
 *   /:trackSlug/:spotSlug    editing one spot
 */
function usePath(): [string, (p: string) => void] {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = useCallback((p: string) => {
    window.history.pushState(null, "", p);
    setPath(p);
  }, []);
  return [path, navigate];
}

export default function App() {
  const [path, navigate] = usePath();
  const [trackSlug, spotSlug] = useMemo(
    () => path.split("/").filter(Boolean).map(decodeURIComponent),
    [path],
  );

  const [tracks, setTracks] = useState<Track[] | null>(null); // null = loading
  const [spots, setSpots] = useState<Spot[]>([]);
  const [hoveredSpotId, setHoveredSpotId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftSpot | null>(null);
  const [content, setContent] = useState<ContentPiece | null>(null);
  const [text, setText] = useState("");
  const [drawingPolygon, setDrawingPolygon] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needToken, setNeedToken] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  const [newTrackName, setNewTrackName] = useState("");
  const [newTrackKind, setNewTrackKind] = useState<"tour" | "fillin">("tour");
  const [newTrackLifecycle, setNewTrackLifecycle] = useState<"evergreen" | "series">("evergreen");
  const [withAudio, setWithAudio] = useState(true);
  // What's here? Candidates for a freshly-dropped spot's name.
  const [candidates, setCandidates] = useState<PlaceCandidate[]>([]);
  const [address, setAddress] = useState<string | null>(null);
  // Live map center, so "New spot" can drop a draft at what the user is viewing.
  const mapCenterRef = useRef<LngLat | null>(null);
  // Try the same simulator used by the exported web app.
  const [driveMode, setDriveMode] = useState(false);

  useEffect(() => {
    setHoveredSpotId(null);
  }, [path, driveMode]);

  const track = useMemo(
    () => tracks?.find((t) => t.slug === trackSlug) ?? null,
    [tracks, trackSlug],
  );

  const refreshTracks = useCallback(async () => {
    try {
      setTracks(await api.listTracks());
      setNeedToken(false);
    } catch (e) {
      const msg = String(e);
      if (/unauthorized|ADMIN_TOKEN/i.test(msg)) {
        setNeedToken(true);
        setError(null);
      } else {
        setError(msg);
      }
    }
  }, []);

  useEffect(() => {
    refreshTracks();
  }, [refreshTracks, trackSlug]);

  const saveToken = useCallback(() => {
    localStorage.setItem(TOKEN_STORAGE_KEY, tokenInput.trim());
    setTokenInput("");
    refreshTracks();
  }, [tokenInput, refreshTracks]);

  // Load this track's spots whenever the track changes (or after saves).
  const refreshSpots = useCallback(async () => {
    if (!track) {
      setSpots([]);
      return;
    }
    try {
      setSpots(await api.listSpots(track.id));
    } catch (e) {
      setError(String(e));
    }
  }, [track?.id]);

  useEffect(() => {
    refreshSpots();
  }, [refreshSpots]);

  // Drive mode is a track-level activity: exit it when a spot opens or the
  // track changes.
  useEffect(() => {
    setDriveMode(false);
  }, [track?.id, spotSlug]);

  // Sync the spot editor with the URL. Saved spots are URL-driven; an unsaved
  // draft (id === null) is transient and survives having no URL segment.
  useEffect(() => {
    if (!track) return;
    if (spotSlug) {
      const s = spots.find((sp) => sp.slug === spotSlug);
      if (!s) return; // spots still loading, or bad slug (surfaced below)
      if (draft?.id === s.id) return; // already open
      (async () => {
        try {
          const { spot, content } = await api.getSpot(s.id);
          setDrawingPolygon(false);
          setCandidates([]);
          setAddress(null);
          setDraft({
            id: spot.id,
            trackId: spot.trackId,
            title: spot.title,
            subtitle: spot.subtitle,
            kind: spot.trigger.kind === "area" ? "area" : "point",
            center: triggerAnchor(spot.trigger) ?? { lat: 40.7128, lng: -74.0059 },
            radiusM: spot.trigger.radiusM,
            region: spot.trigger.region,
            sequenceKey: spot.sequence?.key ?? "",
            sequenceIndex: spot.sequence?.index ?? 0,
            locating: spot.locating ?? DEFAULT_LOCATING,
            status: spot.status,
            modes: spot.modes,
            guideId: spot.guideId,
          });
          const piece = content[0] ?? null;
          setContent(piece);
          setText(piece?.document?.text ?? "");
        } catch (e) {
          setError(String(e));
        }
      })();
    } else {
      // Back at the track level (e.g. browser Back): close any saved spot.
      setDraft((d) => (d && d.id !== null ? null : d));
    }
  }, [track?.id, spotSlug, spots]);

  const closeSpot = useCallback(() => {
    setDraft(null);
    setContent(null);
    setText("");
    setCandidates([]);
    setAddress(null);
    if (track) navigate(`/${track.slug}`);
  }, [track, navigate]);

  const openSpot = useCallback(
    (id: string) => {
      const s = spots.find((sp) => sp.id === id);
      if (s && track) navigate(`/${track.slug}/${s.slug}`);
    },
    [spots, track, navigate],
  );

  // Ask the server what's at a coordinate; auto-fill a still-untouched new
  // draft's title with the top candidate. Best-effort — failures are silent.
  const identifyAt = useCallback((p: LngLat) => {
    setCandidates([]);
    setAddress(null);
    api
      .identify(p.lat, p.lng)
      .then((res) => {
        setCandidates(res.candidates);
        setAddress(res.address);
        const top = res.candidates[0];
        if (top) {
          setDraft((d) =>
            d && d.id === null && d.center === p ? { ...d, title: top.title } : d,
          );
        }
      })
      .catch(() => {});
  }, []);

  // Begin a brand-new (unsaved) draft at a coordinate and identify what's there.
  const startDraftAt = useCallback(
    (p: LngLat) => {
      if (!track) return;
      setContent(null);
      setText("");
      setDraft({
        id: null,
        trackId: track.id,
        title: "New spot",
        subtitle: "",
        kind: "point",
        center: p,
        radiusM: 100,
        sequenceKey: "",
        sequenceIndex: 0,
        locating: DEFAULT_LOCATING,
        status: "draft",
        modes: [],
      });
      identifyAt(p);
    },
    [track, identifyAt],
  );

  // "New spot" button: drop a draft at the map's current center.
  const newSpot = useCallback(() => {
    const c = mapCenterRef.current ?? draft?.center ?? { lat: 40.7128, lng: -74.0059 };
    startDraftAt(c);
  }, [startDraftAt, draft]);

  const removeSpot = useCallback(
    async (s: Spot) => {
      if (!confirm(`Delete “${s.title}”? This removes the spot and its narration.`)) return;
      setBusy("Deleting…");
      setError(null);
      try {
        await api.deleteSpot(s.id);
        if (draft?.id === s.id) closeSpot();
        await refreshSpots();
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(null);
      }
    },
    [draft, closeSpot, refreshSpots],
  );

  const onMapClick = useCallback(
    (p: LngLat) => {
      if (!track) return; // pick a track first — the map is read-only until then
      if (track.kind === "fillin") return; // fill-in tracks have no geometry
      if (drawingPolygon && draft) {
        setDraft({ ...draft, region: [...(draft.region ?? []), p] });
        return;
      }
      // While editing, a click repositions the trigger center (pinpoint
      // placement) — it must never silently discard the open draft. For a
      // not-yet-saved spot, re-ask what's at the new location.
      if (draft) {
        setDraft({ ...draft, center: p });
        if (draft.id === null) identifyAt(p);
        return;
      }
      // No draft open: start a new spot at the clicked point.
      startDraftAt(p);
    },
    [drawingPolygon, draft, track, identifyAt, startDraftAt],
  );

  const onDraftMove = useCallback((p: LngLat) => {
    setDraft((d) => (d ? { ...d, center: p } : d));
  }, []);

  const saveSpot = useCallback(async () => {
    if (!draft || !track) return;
    setBusy("Saving spot…");
    setError(null);
    try {
      const input = {
        trackId: track.id,
        title: draft.title,
        subtitle: draft.subtitle,
        trigger: triggerFromDraft(draft),
        sequence: sequenceFromDraft(draft),
        locating: draft.locating,
        status: draft.status as any,
        modes: draft.modes,
        guideId: draft.guideId,
      };
      const spot = draft.id
        ? await api.updateSpot(draft.id, input)
        : await api.createSpot(input);
      setDraft((d) => (d ? { ...d, id: spot.id } : d));
      await refreshSpots();
      // A newly created spot now has a slug — give it its URL.
      if (!draft.id) navigate(`/${track.slug}/${spot.slug}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }, [draft, track, refreshSpots, navigate]);

  const saveText = useCallback(async () => {
    if (!draft?.id) {
      setError("Save the spot first");
      return;
    }
    setBusy("Saving text…");
    try {
      // Store plain text as a minimal filo doc (no tiers); audio alignment
      // is produced by the AI pipeline or a later forced-alignment step.
      const byteLength = new TextEncoder().encode(text).length;
      const piece = await api.saveContent({
        spotId: draft.id,
        document: text
          ? { id: `doc_${draft.id}`, text, byteLength, metadata: {}, tiers: [] }
          : null,
        audioUrl: content?.audioUrl ?? null,
        durationMs: content?.durationMs ?? null,
        source: content?.source ?? "human",
        status: content?.status ?? "draft",
      });
      setContent(piece);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }, [draft, text, content]);

  const generate = useCallback(async () => {
    if (!draft?.id) {
      setError("Save the spot first");
      return;
    }
    setError(null);

    // The server does this as one request (~30–60s). We can't stream per-phase
    // progress from it, so advance through the expected phases on a timer to
    // show the work is alive. Cleared in `finally`.
    const phases = [
      "Searching sources (exa.ai + Wikipedia)…",
      "Drafting the narration script…",
      "Synthesizing audio (ElevenLabs)…",
      "Aligning audio to text…",
    ];
    let phase = 0;
    setBusy(phases[0]!);
    const ticker = setInterval(() => {
      phase = Math.min(phase + 1, phases.length - 1);
      setBusy(phases[phase]!);
    }, 8000);

    try {
      const piece = await api.generate(draft.id, {
        locale: "en",
        variant: "default",
        targetSeconds: 90,
        useSearch: true,
        useWikipedia: true,
        synthesizeAudio: withAudio,
      });
      setContent(piece);
      setText(piece.document?.text ?? "");
    } catch (e) {
      setError(String(e));
    } finally {
      clearInterval(ticker);
      setBusy(null);
    }
  }, [draft, withAudio]);

  // TTS just the locating clips — targeted, never re-drafts the narration.
  const generateLocating = useCallback(async () => {
    if (!draft?.id) {
      setError("Save the spot first");
      return;
    }
    setBusy("Synthesizing locating clips…");
    setError(null);
    try {
      const spot = await api.generateLocating(draft.id, { locale: "en" });
      setDraft((d) => (d && d.id === spot.id ? { ...d, locating: spot.locating } : d));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }, [draft]);

  const publish = useCallback(async () => {
    if (!content?.id) return;
    setBusy("Publishing…");
    try {
      // Spot and content both need to be published to surface in /nearby.
      const piece = await api.setContentStatus(content.id, "published");
      setContent(piece);
      if (draft?.id) {
        await api.updateSpot(draft.id, {
          trackId: draft.trackId,
          title: draft.title,
          subtitle: draft.subtitle,
          trigger: triggerFromDraft(draft),
          sequence: sequenceFromDraft(draft),
          locating: draft.locating,
          status: "published" as any,
          modes: draft.modes,
          guideId: draft.guideId,
        });
        setDraft((d) => (d ? { ...d, status: "published" } : d));
        await refreshSpots();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }, [content, draft, refreshSpots]);

  const createTrack = useCallback(async () => {
    const name = newTrackName.trim();
    if (!name) return;
    setBusy("Creating track…");
    setError(null);
    try {
      const t = await api.createTrack({
        slug: slugify(name),
        name,
        kind: newTrackKind,
        lifecycle: newTrackLifecycle,
      });
      setNewTrackName("");
      setNewTrackKind("tour");
      setNewTrackLifecycle("evergreen");
      await refreshTracks();
      navigate(`/${t.slug}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }, [newTrackName, newTrackKind, newTrackLifecycle, refreshTracks, navigate]);

  if (track && track.kind !== "fillin" && !draft && driveMode) {
    return <DriveMode key={track.id} track={track} onClose={() => setDriveMode(false)} />;
  }

  const badTrack = tracks !== null && trackSlug && !track;
  const badSpot =
    track && spotSlug && spots.length > 0 && !spots.some((s) => s.slug === spotSlug);

  return (
    <div className="app">
      <MapView
        spots={spots}
        selectedId={draft?.id ?? null}
        hoveredId={hoveredSpotId}
        onHover={setHoveredSpotId}
        draft={draft ? { kind: draft.kind, center: draft.center, radiusM: draft.radiusM, region: draft.region } : null}
        drawingPolygon={drawingPolygon}
        onMapClick={onMapClick}
        onSelect={openSpot}
        onDraftMove={onDraftMove}
        centerRef={mapCenterRef}
        frameKey={track?.slug ?? null}
      />

      <div className="panel">
        <h1>GrandTour Admin</h1>
        <div className="crumbs">
          <a onClick={() => navigate("/")}>tracks</a>
          {track && (
            <>
              <span>/</span>
              <a onClick={closeSpot}>{track.name}</a>
            </>
          )}
          {track && draft?.id && spotSlug && (
            <>
              <span>/</span>
              <span>{spotSlug}</span>
            </>
          )}
        </div>

        {error && <div className="error">{error}</div>}
        {busy && <div className="muted">⏳ {busy}</div>}

        {needToken && (
          <div className="card">
            <h2>Admin token</h2>
            <div className="field">
              <label>Enter the ADMIN_TOKEN configured on the server</label>
              <input
                type="password"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && saveToken()}
              />
            </div>
            <div className="toolbar">
              <button onClick={saveToken}>Save token</button>
            </div>
          </div>
        )}

        {/* ── Track chooser (top level: always work within a track) ── */}
        {!needToken && !track && (
          <div className="card">
            <h2>Choose a track</h2>
            {badTrack && (
              <div className="error" style={{ marginBottom: 8 }}>
                No track “{trackSlug}” — pick one below.
              </div>
            )}
            <div className="spot-list">
              {(tracks ?? []).map((t) => (
                <button key={t.id} onClick={() => navigate(`/${t.slug}`)}>
                  {t.name} <span className="muted">· {trackCountLabel(t)} · /{t.slug}</span>
                  {t.kind === "fillin" && <span className="pill draft"> fill-in</span>}
                </button>
              ))}
              {tracks === null && <div className="muted">Loading…</div>}
              {tracks !== null && tracks.length === 0 && (
                <div className="muted">No tracks yet — create the first one.</div>
              )}
            </div>
            <div className="field" style={{ marginTop: 12 }}>
              <label>New track</label>
              <div className="row">
                <input
                  placeholder={newTrackKind === "fillin" ? "e.g. SAT Vocabulary" : "e.g. History"}
                  value={newTrackName}
                  onChange={(e) => setNewTrackName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && createTrack()}
                />
                <select
                  value={newTrackKind}
                  onChange={(e) => setNewTrackKind(e.target.value as "tour" | "fillin")}
                  title="Tour tracks hold geo-triggered spots; fill-in tracks hold items played during narration gaps."
                >
                  <option value="tour">Tour</option>
                  <option value="fillin">Fill-in</option>
                </select>
                <select
                  value={newTrackLifecycle}
                  onChange={(e) => setNewTrackLifecycle(e.target.value as "evergreen" | "series")}
                  title="Evergreen: replayable forever, may keep growing. Series: podcast model — heard-once units, auto-disables in the app when fully played."
                >
                  <option value="evergreen">Evergreen</option>
                  <option value="series">Series</option>
                </select>
                <button onClick={createTrack} disabled={!newTrackName.trim() || !!busy}>
                  Create
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Fill-in track: items panel instead of the map/spots workspace ── */}
        {track && track.kind === "fillin" && <FillInPanel track={track} />}

        {/* ── In a track, no spot open: this track's spots ── */}
        {track && track.kind !== "fillin" && !draft && !driveMode && (
          <div className="card">
            <div className="toolbar" style={{ justifyContent: "space-between", marginBottom: 10 }}>
              <h2 style={{ margin: 0 }}>
                Spots <span className="muted">· {spots.length}</span>
              </h2>
              <div className="toolbar">
                {spots.length > 0 && (
                  <button className="secondary" onClick={() => setDriveMode(true)}>
                    ▶ Try me out
                  </button>
                )}
                <button
                  className="ghost"
                  onClick={() => api.exportTrack(track.id, track.slug).catch((e) => setError(String(e)))}
                  title="Download this track's published spots + content as a static JSON bundle for the offline tour viewer"
                >
                  ⇩ Export
                </button>
                <button onClick={newSpot}>+ New spot</button>
              </div>
            </div>
            {badSpot && (
              <div className="error" style={{ marginBottom: 8 }}>
                No spot “{spotSlug}” in this track.
              </div>
            )}
            {spots.length === 0 ? (
              <div className="empty">
                <div className="muted" style={{ marginBottom: 10 }}>
                  No spots in <b>{track.name}</b> yet.
                </div>
                <button onClick={newSpot}>+ New spot</button>
                <div className="muted" style={{ marginTop: 8, fontSize: 11 }}>
                  or click anywhere on the map to drop one there.
                </div>
              </div>
            ) : (
              <div className="spot-list">
                {spots.map((s) => (
                  <div
                    key={s.id}
                    className={`spot-row${hoveredSpotId === s.id ? " is-highlighted" : ""}`}
                    onMouseEnter={() => setHoveredSpotId(s.id)}
                    onMouseLeave={() => setHoveredSpotId(null)}
                    onClick={() => openSpot(s.id)}
                  >
                    <span
                      className="spot-kind-icon"
                      role="img"
                      aria-label={s.trigger.kind === "point" ? "Exact place" : s.trigger.kind === "area" ? "Neighborhood story" : "Anywhere story"}
                      title={s.trigger.kind === "point" ? "Exact place — plays nearby" : s.trigger.kind === "area" ? "Neighborhood — plays within its boundary" : "Anywhere — no location boundary"}
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        {s.trigger.kind === "point" ? (
                          <>
                            <path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z" />
                            <circle cx="12" cy="10" r="2.5" />
                          </>
                        ) : (
                          <path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8-6.2-3.2L5.8 21 7 14.2 2 9.3l6.9-1L12 2Z" />
                        )}
                      </svg>
                    </span>
                    <div className="spot-row-main">
                      <div className="spot-row-title">{s.title}</div>
                      {s.subtitle && <div className="muted spot-row-sub">{s.subtitle}</div>}
                    </div>
                    <span className={`pill ${s.status}`}>{s.status}</span>
                    <button
                      className="ghost spot-del"
                      title="Delete spot"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeSpot(s);
                      }}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="muted" style={{ marginTop: 10, fontSize: 11 }}>
              Tip: click the map to drop a spot where you click, or use “New spot”
              to place one at the current view center.
            </div>
          </div>
        )}

        {/* ── Spot editor ── */}
        {track && track.kind !== "fillin" && draft && (
          <>
            <div className="card">
              <div className="toolbar" style={{ justifyContent: "space-between" }}>
                <h2>{draft.id ? "Edit spot" : "New spot"}</h2>
                <span className={`pill ${draft.status}`}>{draft.status}</span>
              </div>

              <div className="field">
                <label>Title</label>
                <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
                {candidates.length > 0 && (
                  <div className="toolbar" style={{ marginTop: 6, flexWrap: "wrap" }}>
                    {candidates.slice(0, 5).map((c) => (
                      <button
                        key={c.title}
                        className={draft.title === c.title ? "ok" : "ghost"}
                        title={c.distanceM != null ? `${Math.round(c.distanceM)} m away` : undefined}
                        onClick={() => setDraft({ ...draft, title: c.title })}
                      >
                        {c.title}
                        {c.distanceM != null && (
                          <span className="muted"> · {Math.round(c.distanceM)}m</span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
                {address && (
                  <div className="muted" style={{ marginTop: 4 }}>
                    📍 {address}{" "}
                    <button className="ghost" onClick={() => setDraft({ ...draft, subtitle: address })}>
                      use as subtitle
                    </button>
                  </div>
                )}
              </div>
              <div className="field">
                <label>Subtitle</label>
                <input value={draft.subtitle} onChange={(e) => setDraft({ ...draft, subtitle: e.target.value })} />
              </div>
              <div className="field">
                <label>Trigger kind</label>
                <select
                  value={draft.kind}
                  onChange={(e) => setDraft({ ...draft, kind: e.target.value as DraftSpot["kind"] })}
                  title="Point: plays when the traveler arrives. Area: playable anywhere inside the fence, inserted into narration gaps."
                >
                  <option value="point">Point — plays on arrival</option>
                  <option value="area">Area — anywhere in the fence, fills gaps</option>
                </select>
                {draft.kind === "area" && !draft.region?.length && (
                  <div className="muted" style={{ marginTop: 4 }}>
                    Draw the fence polygon on the map (required for area spots).
                  </div>
                )}
              </div>
              <div className="muted" style={{ marginBottom: 8 }}>
                Drag the crosshair or click the map to move the pin, then Save spot.
                {draft.kind === "area" && " The outline defines where this story can play; moving the pin leaves that boundary in place."}
              </div>
              <div className="row">
                <div className="field">
                  <label>Lat</label>
                  <input
                    key={`lat-${draft.center.lat}`}
                    defaultValue={draft.center.lat.toFixed(6)}
                    onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                    onBlur={(e) => {
                      const v = Number(e.target.value);
                      if (Number.isFinite(v) && v >= -90 && v <= 90 && v !== draft.center.lat) {
                        setDraft({ ...draft, center: { ...draft.center, lat: v } });
                      }
                    }}
                  />
                </div>
                <div className="field">
                  <label>Lng</label>
                  <input
                    key={`lng-${draft.center.lng}`}
                    defaultValue={draft.center.lng.toFixed(6)}
                    onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                    onBlur={(e) => {
                      const v = Number(e.target.value);
                      if (Number.isFinite(v) && v >= -180 && v <= 180 && v !== draft.center.lng) {
                        setDraft({ ...draft, center: { ...draft.center, lng: v } });
                      }
                    }}
                  />
                </div>
              </div>
              {draft.kind === "point" && (
              <div className="field">
                <label>Trigger radius: {draft.radiusM} m</label>
                <input
                  type="range" min={20} max={2000} step={10}
                  value={draft.radiusM}
                  onChange={(e) => setDraft({ ...draft, radiusM: Number(e.target.value) })}
                />
              </div>
              )}
              <div className="toolbar">
                <button
                  className={drawingPolygon ? "ok" : "secondary"}
                  onClick={() => setDrawingPolygon((v) => !v)}
                >
                  {drawingPolygon
                    ? "Click map to add points… (done)"
                    : draft.kind === "area" ? "Draw fence" : "Draw region"}
                </button>
                {draft.region && (
                  <button className="ghost" onClick={() => setDraft({ ...draft, region: undefined })}>
                    Clear {draft.kind === "area" ? "fence" : "region"} ({draft.region.length})
                  </button>
                )}
              </div>
              <div className="row">
                <div className="field">
                  <label>Story key (blank = not sequenced)</label>
                  <input
                    placeholder="e.g. gold-rush-story"
                    value={draft.sequenceKey}
                    onChange={(e) =>
                      setDraft({ ...draft, sequenceKey: slugify(e.target.value) })
                    }
                  />
                </div>
                {draft.sequenceKey.trim() && (
                  <div className="field">
                    <label>Part #</label>
                    <input
                      type="number" min={0} step={1}
                      value={draft.sequenceIndex}
                      onChange={(e) =>
                        setDraft({ ...draft, sequenceIndex: Math.max(0, Math.floor(Number(e.target.value) || 0)) })
                      }
                    />
                  </div>
                )}
              </div>
              {draft.sequenceKey.trim() && (
                <div className="muted" style={{ marginBottom: 8 }}>
                  Parts sharing a story key auto-play strictly in order — part{" "}
                  {draft.sequenceIndex} waits until every earlier part has been heard.
                </div>
              )}
              <div className="toolbar" style={{ marginTop: 10 }}>
                <button onClick={saveSpot} disabled={!!busy || (draft.kind === "area" && !draft.region?.length)}>Save spot</button>
                <button className="ghost" onClick={closeSpot}>
                  ← All spots in {track.name}
                </button>
              </div>
            </div>

            {draft.kind === "point" && (
            <div className="card">
              <h2>Locating instructions</h2>
              <div className="muted" style={{ marginBottom: 8 }}>
                The "where to look" line, played before the narration.{" "}
                <code>{"{{side}}"}</code> becomes left/right from the traveler's
                direction of travel.
              </div>
              <div className="field">
                <label>Mode</label>
                <select
                  value={draft.locating.mode}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      locating: { ...draft.locating, mode: e.target.value as Locating["mode"] },
                    })
                  }
                >
                  <option value="auto">Auto — “{DEFAULT_LOCATING_TEMPLATE}”</option>
                  <option value="custom">Custom template</option>
                  <option value="none">None</option>
                </select>
              </div>
              {draft.locating.mode === "custom" && (
                <div className="field">
                  <label>Template ({"{{side}}"} → left/right; omit it for fixed directions)</label>
                  <input
                    placeholder={DEFAULT_LOCATING_TEMPLATE}
                    value={draft.locating.template ?? ""}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        locating: { ...draft.locating, template: e.target.value },
                      })
                    }
                  />
                </div>
              )}
              {draft.locating.mode !== "none" && (
                <>
                  {(() => {
                    const tpl = locatingTemplate(draft.locating);
                    if (!tpl) return null;
                    return (
                      <div className="muted" style={{ marginBottom: 8 }}>
                        Preview:{" "}
                        {tpl.includes(SIDE_TOKEN)
                          ? `“${tpl.replaceAll(SIDE_TOKEN, "left")}” / “${tpl.replaceAll(SIDE_TOKEN, "right")}”`
                          : `“${tpl}” (fixed — same for every approach)`}
                      </div>
                    );
                  })()}
                  {(["left", "right", "fixed"] as const).map((k) => {
                    const clip = draft.locating.clips?.[k];
                    return clip ? (
                      <div key={k} className="field">
                        <label>{k} · “{clip.text}”</label>
                        <audio src={clip.audioUrl} controls preload="none" />
                      </div>
                    ) : null;
                  })}
                  <div className="toolbar">
                    <button
                      className="secondary"
                      onClick={generateLocating}
                      disabled={!draft.id || !!busy}
                      title={!draft.id ? "Save the spot first" : undefined}
                    >
                      🔊 Generate locating audio
                    </button>
                  </div>
                </>
              )}
            </div>
            )}

            <ContentEditor content={content} text={text} onTextChange={setText} />

            <div className="toolbar">
              <button className="secondary" onClick={saveText} disabled={!draft.id || !!busy}>Save text</button>
              <button onClick={generate} disabled={!draft.id || !!busy}>
                {busy ? <><span className="spinner" /> {busy}</> : "✨ AI generate"}
              </button>
              <label className="muted" style={{ display: "flex", alignItems: "center", gap: 4, margin: 0 }}>
                <input
                  type="checkbox"
                  style={{ width: "auto" }}
                  checked={withAudio}
                  onChange={(e) => setWithAudio(e.target.checked)}
                />
                audio
              </label>
              <button className="ok" onClick={publish} disabled={!content?.id || !!busy}>Publish</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
