// @refresh reset
// The stateful playback controller must be recreated when its code hot-reloads.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { LngLat, NearbySpot, RoutedTrack, TrackExport } from "@grandtour/shared";
import { buildRoute, mphToMps, triggerAnchor, SPEED_PRESETS } from "@grandtour/shared";
import { ViewerMap } from "./ViewerMap";
import { computeNearby } from "./nearby";
import { useGeolocation } from "./useGeolocation";
import { useDriveSim } from "./useDriveSim";
import { StoryReader } from "./StoryReader";
import { formatDistance, formatSpeed, type Units } from "./units";
import { GAP_KEY, GAP_OPTIONS, loadGapSeconds } from "./gap";
import { NowPlayingCard } from "./NowPlayingCard";
import { TourPlayback, type Fix } from "./TourPlayback";
import { sequenceReleased } from "./eligibility";
import { planNarrationStops, type NarrationStop } from "./narrationRoute";
import { nextRouteStop, previousRouteStop, reverseRoute } from "./routeNavigation";
import "maplibre-gl/dist/maplibre-gl.css";
import "./tour.css";

const EMPTY_PATH: LngLat[] = [];
const NO_WAYPOINTS: number[] = [];
type Mode = "gps" | "explore" | "simulate";

interface Props {
  bundle: TrackExport;
  backHref?: string;
  onClose?: () => void;
  initialMode?: Mode;
}

export function TourView({ bundle, backHref, onClose, initialMode = "simulate" }: Props) {
  const { track, spots } = bundle;
  const [mode, setMode] = useState<Mode>(initialMode);
  const [following, setFollowing] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [reader, setReader] = useState<{ stories: NearbySpot[]; initialId: string } | null>(null);
  const [units, setUnits] = useState<Units>(() => {
    try { return localStorage.getItem("tourUnits") === "metric" ? "metric" : "imperial"; } catch { return "imperial"; }
  });
  useEffect(() => {
    try { localStorage.setItem("tourUnits", units); } catch { /* private storage */ }
  }, [units]);
  const [gapSeconds, setGapSeconds] = useState(loadGapSeconds);
  const [player] = useState(() => {
    const p: TourPlayback = new TourPlayback(undefined, {
      released: (item) => sequenceReleased(item, bundle, (id) => p.heard(id)),
    });
    return p;
  });
  useEffect(() => {
    player.setGapSeconds(gapSeconds);
    try { localStorage.setItem(GAP_KEY, String(gapSeconds)); } catch { /* private storage */ }
  }, [player, gapSeconds]);
  const playback = useSyncExternalStore(player.subscribe, player.getSnapshot);
  const selected = playback.item;
  const selectedId = selected?.spot.id ?? null;
  const mapSpots = useMemo(() => spots.map((s) => s.spot), [spots]);
  const [explorePos, setExplorePos] = useState<LngLat | null>(null);
  const geo = useGeolocation(mode === "gps");

  const [routeDirection, setRouteDirection] = useState("forward");
  const [route, setRoute] = useState<RoutedTrack | null>(null);
  const [routeBuilding, setRouteBuilding] = useState(true);
  const [routeError, setRouteError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setRouteBuilding(true);
    setRoute(null);
    setRouteError(null);
    if (bundle.routePath) {
      setRoute({ path: bundle.routePath, onRoads: true, order: spots.map((_, index) => index) });
      setRouteBuilding(false);
      return () => { alive = false; };
    }
    const anchors = spots.map((s) => triggerAnchor(s.spot.trigger)).filter((p): p is LngLat => p !== null);
    buildRoute(anchors).then((result) => {
      if (alive) setRoute(result);
    }).catch(() => {
      if (alive) setRouteError("Could not prepare this route. You can still explore the map.");
    }).finally(() => { if (alive) setRouteBuilding(false); });
    return () => { alive = false; };
  }, [bundle.routePath, spots]);
  const activeRoute = useMemo(() => route && (routeDirection === "reverse" ? reverseRoute(route) : route), [route, routeDirection]);
  const activePath = activeRoute?.path ?? EMPTY_PATH;
  const sim = useDriveSim(activePath, NO_WAYPOINTS);
  const manualStoryIdRef = useRef<string | null>(null);
  const resumeSimulationAfterStoryRef = useRef(false);
  const stops = useMemo(() => planNarrationStops(track, spots, activePath), [track, spots, activePath]);
  const traveler = useMemo(() => {
    if (mode === "gps" && geo.pos) return { pos: geo.pos, headingDeg: geo.courseDeg ?? 0 };
    if (mode === "simulate" && sim.pos) return { pos: sim.pos, headingDeg: sim.headingDeg };
    return null;
  }, [mode, geo.pos, geo.courseDeg, sim.pos, sim.headingDeg]);
  const nearbyPos = mode === "explore" ? explorePos : traveler?.pos ?? null;
  const nearbyCourse = mode === "gps" ? geo.courseDeg : mode === "simulate" ? sim.headingDeg : null;
  const nearby: NearbySpot[] = useMemo(() => {
    if (!nearbyPos) return spots.map(({ spot, content }) => ({
      spot, track, locating: null, distanceM: 0, triggered: false,
      content: content.find((c) => c.locale === "en") ?? content[0] ?? null, guide: null,
    }));
    return computeNearby(track, spots, nearbyPos, nearbyCourse, Infinity);
  }, [spots, track, nearbyPos, nearbyCourse]);

  // The fix the scheduler decides on: the phone's context, from GPS or the simulated drive.
  const fix = useMemo<Fix>(() => {
    if (mode === "gps") return { location: geo.pos ? { ...geo.pos, speedMps: geo.speedMps ?? -1 } : null, courseDeg: geo.courseDeg, mode: "walking" };
    if (mode === "simulate") return { location: sim.pos ? { ...sim.pos, speedMps: mphToMps(sim.mph) } : null, courseDeg: sim.headingDeg, mode: "driving" };
    return {};
  }, [mode, geo.pos, geo.speedMps, geo.courseDeg, sim.pos, sim.mph, sim.headingDeg]);
  const nextStop = nextRouteStop(stops, sim.distM, player.isAvailable);
  const previousStop = previousRouteStop(stops, sim.distM, selectedId);
  const upNext = mode === "gps" ? playback.upNext ?? undefined : nextStop?.item;
  const simulationTourRunning = mode === "simulate" && (sim.playing || playback.running);
  const selectSpot = (id: string) => {
    const item = nearby.find((n) => n.spot.id === id);
    if (!item) return;
    if (sim.playing || playback.playing || playback.running) {
      setReader({ stories: nearby, initialId: item.spot.id });
      return;
    }
    sim.pause();
    setMode("explore");
    setFollowing(false);
    setExplorePos(nearbyPos);
    player.select(item);
  };
  const exploreMap = useCallback((pos: LngLat) => {
    if (sim.playing || playback.playing || playback.running) return;
    setFollowing(false);
    setMode("explore");
    setExplorePos(pos);
    player.pause();
    sim.pause();
  }, [player, playback.playing, playback.running, sim.pause, sim.playing]);
  const followLocation = () => {
    sim.pause();
    if (mode !== "gps") player.reset();
    setMode("gps");
    setFollowing(true);
    // Unlock output on the bullseye gesture; GPS fixes supply eligibility later.
    player.start([], fix);
  };
  // A standalone open (not the authoring preview, which always starts in "simulate")
  // requests location immediately, same as the phone app asking for it at launch.
  useEffect(() => {
    if (initialMode === "gps") {
      setFollowing(true);
      player.start([], fix);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const changeRoute = (direction: string) => {
    manualStoryIdRef.current = null;
    resumeSimulationAfterStoryRef.current = false;
    player.reset();
    sim.reset();
    setMode("simulate");
    setFollowing(false);
    setRouteDirection(direction);
  };
  const toggleSimulation = () => {
    if (simulationTourRunning) {
      manualStoryIdRef.current = null;
      resumeSimulationAfterStoryRef.current = false;
      player.pause();
      sim.pause();
      return;
    }
    if (mode !== "simulate" || sim.distM >= sim.totalM) player.reset();
    setMode("simulate");
    setFollowing(true);
    player.start(mode === "simulate" && sim.distM < sim.totalM ? nearby : [], fix);
    sim.play();
  };
  const playStory = (item: NearbySpot) => {
    const interruptingTour = mode !== "explore" && (sim.playing || playback.running);
    if (interruptingTour) {
      manualStoryIdRef.current = item.spot.id;
      resumeSimulationAfterStoryRef.current = mode === "simulate";
      sim.pause();
      player.play(item, true);
      return;
    }
    manualStoryIdRef.current = null;
    resumeSimulationAfterStoryRef.current = false;
    sim.pause();
    setMode("explore");
    setFollowing(false);
    player.play(item, false);
  };
  const visitStop = (stop: NarrationStop | undefined) => {
    if (!stop) return;
    setMode("simulate");
    setFollowing(true);
    // Explicit navigation starts this stop, including a previously heard stop
    // when going back. It does not clear the rest of the listening history.
    sim.play();
    sim.seekTo(stop.distM);
    player.play(stop.item, true);
  };
  const toggleNarration = () => {
    if (playback.playing) {
      player.pause();
      sim.pause();
    } else {
      player.resume(mode !== "explore");
      if (mode === "simulate" && sim.distM < sim.totalM) sim.play();
    }
  };

  useEffect(() => {
    if (mode === "simulate" && playback.error) sim.pause();
  }, [mode, playback.error, sim.playing, sim.pause]);
  useEffect(() => {
    const manualStoryId = manualStoryIdRef.current;
    if (!manualStoryId || playback.item?.spot.id === manualStoryId) return;
    const resumeSimulation = resumeSimulationAfterStoryRef.current
      && playback.running && mode === "simulate";
    manualStoryIdRef.current = null;
    resumeSimulationAfterStoryRef.current = false;
    if (resumeSimulation) sim.play();
  }, [mode, playback.item, playback.running, sim.play]);
  useEffect(() => {
    // Decide on the current position, never retain passed arrivals.
    if (mode !== "explore") player.next(nearby, fix);
  }, [nearby, fix, mode, playback.running, playback.item, player]);

  return (
    <div className={`tour-app${reader ? " reader-open" : ""}`}>
      {onClose && <button className="back-to-tracks" onClick={onClose}>← Back to authoring</button>}
      <audio ref={player.attach} onPlay={player.onPlay} onPause={player.onPause}
        onEnded={player.onAudioEnded} onTimeUpdate={player.onTime} onError={player.onError} />
      {backHref && <a className="back-to-tracks" href={backHref}>← All tracks</a>}
      <ViewerMap spots={mapSpots} trackColor={track.color} selectedId={selectedId}
        onSelect={selectSpot} onExplore={exploreMap} onFollowLocation={followLocation}
        following={following} followingLocation={following && mode === "gps"}
        routePath={mode === "gps" ? null : activePath} traveler={traveler} />

      <div className="tour-panel" aria-label={settingsOpen ? "Tour settings" : "Tour controls"}>
        {settingsOpen ? <>
          <div className="tour-header">
            <h1>Tour settings</h1>
            <button className="settings-button ghost" onClick={() => setSettingsOpen(false)} aria-label="Close settings">✕</button>
          </div>
          <div className="settings-fields">
            <label>Units
              <select aria-label="Units" value={units} onChange={(e) => setUnits(e.target.value as Units)}>
                <option value="imperial">Imperial</option>
                <option value="metric">Metric</option>
              </select>
            </label>
            <label>Between stories
              <select aria-label="Pause between stories" value={gapSeconds} onChange={(e) => setGapSeconds(Number(e.target.value))}>
                {GAP_OPTIONS.map((seconds) => <option key={seconds} value={seconds}>{seconds} seconds</option>)}
              </select>
            </label>
            <label>Travel speed
              <select aria-label="Travel speed" value={sim.mph} onChange={(e) => sim.setMph(Number(e.target.value))}>
                {SPEED_PRESETS.map((p) => <option key={p.mph} value={p.mph}>
                  {p.mph <= 3 ? "Walk" : "Drive"} · {formatSpeed(p.mph, units)}
                </option>)}
              </select>
            </label>
          </div>
        </> : <>
          <div className="tour-header">
            <h1>{track.name}</h1>
            <span className="spot-count" aria-label={`${spots.length} spots`}>{spots.length.toLocaleString("en-US")}</span>
            <button className="settings-button ghost" onClick={() => setSettingsOpen(true)} aria-label="Tour settings" title="Tour settings">⚙</button>
          </div>
          <div className="route-controls">
            <select className="route-picker" aria-label="Route" value={routeDirection} onChange={(e) => changeRoute(e.target.value)}>
              <option value="forward">Full tour</option>
              <option value="reverse">Full tour · reverse</option>
            </select>
            <select className="speed-picker" aria-label="Travel speed" value={sim.mph}
              onChange={(e) => sim.setMph(Number(e.target.value))}>
              {SPEED_PRESETS.map((preset) => <option key={preset.mph} value={preset.mph}>
                {formatSpeed(preset.mph, units)}
              </option>)}
            </select>
            <button onClick={toggleSimulation} disabled={routeBuilding || activePath.length < 2}>
              {simulationTourRunning ? "■ Stop" : "▶ Go"}
            </button>
          </div>
          <div className="route-transport">
            <button className="ghost" onClick={() => visitStop(previousStop)} disabled={!previousStop || routeBuilding}
              title="Previous stop" aria-label="Previous stop">⏮</button>
            <div className="route-progress">
              <input aria-label="Route progress" type="range" min={0} max={Math.max(1, Math.round(sim.totalM))}
                disabled={routeBuilding || activePath.length < 2}
                aria-valuetext={`${formatDistance(sim.distM, units)} of ${formatDistance(sim.totalM, units)}`}
                value={Math.round(sim.distM)} onChange={(e) => {
                  setMode("simulate");
                  setFollowing(true);
                  sim.seekTo(Number(e.target.value));
                }} />
              <span className="route-distance">{formatDistance(sim.distM, units)} / {formatDistance(sim.totalM, units)}</span>
            </div>
            <button className="ghost" onClick={() => visitStop(nextStop)} disabled={!nextStop || routeBuilding}
              title="Next stop" aria-label="Next stop">⏭</button>
          </div>
          <NowPlayingCard item={selected ?? upNext ?? null}
            label={selected ? (playback.playing ? "Now playing" : "Selected story") : routeBuilding ? "Preparing routes…" : "Up next"}
            selected={!!selected} playing={playback.playing}
            currentMs={playback.currentMs} source={playback.source}
            error={playback.error ?? routeError ?? (mode === "gps" ? geo.error : null)}
            onOpen={() => {
              const item = selected ?? upNext;
              if (item) setReader({ stories: nearby, initialId: item.spot.id });
            }}
            onToggle={toggleNarration} />
        </>}
      </div>
      {reader && <StoryReader {...reader} selectedId={selectedId} playing={playback.playing}
        source={playback.source} currentMs={playback.currentMs} error={playback.error} units={units}
        onClose={() => setReader(null)} onToggle={toggleNarration} onPlay={playStory} />}
    </div>
  );
}
