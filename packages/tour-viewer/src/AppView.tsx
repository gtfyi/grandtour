// @refresh reset
// The stateful playback controller must be recreated when its code hot-reloads.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ActivityMode, Index, IndexTrack, LngLat, NearbySpot, TrackExport } from "@grandtour/shared";
import { ACTIVITY_MODES, ActivityModeDetector, areasAround, haversineM, mphToMps, resolveTrackUrl, tracksInAreas, triggerAnchor } from "@grandtour/shared";
import { ServerPicker } from "./ServerPicker";
import { ViewerMap } from "./ViewerMap";
import { computeNearby } from "./nearby";
import { useGeolocation } from "./useGeolocation";
import { loadBundle } from "./loadBundle";
import { NowPlayingCard } from "./NowPlayingCard";
import { StoryReader } from "./StoryReader";
import { TourPlayback, type Fix } from "./TourPlayback";
import { persistentHistory, type PersistentHistory } from "./playHistory";
import { sequenceReleased } from "./eligibility";
import { setMediaHandlers, setNowPlaying, setPlaybackState } from "./mediaSession";
import { useKeepAwake } from "./keepAwake";
import { useDriveSim } from "./useDriveSim";
import { demoLeadM, demoPace, demoStep, nextDemoStops, simulatedMode, syncDemoUrl, useSimulatedRoute, type Simulation } from "./simulate";
import { planNarrationStops } from "./narrationRoute";
import { AudioPrefetch } from "./prefetch";
import { trackCamera } from "./camera";
import { formatDistance, type Units } from "./units";
import { GAP_KEY, GAP_OPTIONS, loadGapSeconds } from "./gap";
import "maplibre-gl/dist/maplibre-gl.css";
import "./tour.css";
import "./app.css";

/**
 * The phone-browser app: what the iOS app does, in a tab.
 *
 * Several tracks at once, real GPS, stories that start themselves as you
 * enter their triggers, a live transcript, and a play history that survives
 * reloads. Everything it needs is a server's index and one bundle per track,
 * so it runs against a plain file host — this site, a GitHub repository, or
 * a machine running GrandTour — with no API behind it.
 *
 * Where the phone has a screen, this has the same screen: the Tracks sheet
 * below is `TrackSheet` in ios/Sources/ContentView.swift, section for section.
 *
 * Two things beyond the phone's screen: `?at=lat,lng` stands the page
 * somewhere without GPS, and a **demo** — the Tracks sheet's Demo button,
 * or `?simulate=<slug>` — travels a track's route as a simulated trip: the
 * same scheduler, the same stories, a car that moves by itself. The landing
 * page's phone frame is a demo. The phone has the same Demo button.
 */
interface Props {
  index: Index;
  indexUrl: string;
  server: string;
  /** `?at=lat,lng`: stand still here instead of reading GPS. */
  fixedPos?: LngLat | null;
  /** `?simulate=<slug>`: open in a demo of that track. */
  simulate?: Simulation | null;
}

/** Track choices are per server: slugs differ from one to the next, as on the phone. */
const enabledKey = (server: string) => `gt.app.enabledTracks:${server}`;
const NEARBY_RADIUS_M = 2000;
/** The phone's `ActivityModePreference`: "auto" (infer from speed), or an explicit mode. */
type ModePreference = "auto" | ActivityMode;
const MODE_KEY = "activityModePreference";
const MODE_PREFERENCES: readonly ModePreference[] = ["auto", ...ACTIVITY_MODES];
/** Between fixes the phone still polls; a standing traveler's clock moves (a pause runs out, a cooldown ends). */
const POLL_MS = 2000;
const NO_WAYPOINTS: number[] = [];

/** The stored choice of tracks, or null when the user has never made one. */
function loadEnabled(index: Index, server: string): Set<string> | null {
  try {
    const raw = localStorage.getItem(enabledKey(server));
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const known = new Set(index.tracks.map((t) => t.slug));
        return new Set(parsed.filter((s): s is string => typeof s === "string" && known.has(s)));
      }
    }
  } catch { /* private storage */ }
  return null;
}

/** Tracks whose footprint meets the cells around a position; every track if none does. */
function tracksNear(index: Index, pos: LngLat): Set<string> {
  const near = tracksInAreas(index, areasAround(pos));
  return new Set((near.length ? near : index.tracks).map((t) => t.slug));
}

function readSetting<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
  try {
    const v = localStorage.getItem(key);
    return allowed.includes(v as T) ? (v as T) : fallback;
  } catch { return fallback; }
}

export function AppView({ index, indexUrl, server, fixedPos = null, simulate = null }: Props) {
  // ── Position ───────────────────────────────────────────────────────────────
  // GPS, unless the page stands somewhere (`?at=`) or a demo is running: a
  // track's route travelled as a simulated trip — the bundle's authored
  // route, else roads through its spots — with the same scheduler playing
  // the stories as the car reaches them. `?simulate=<slug>` opens in a demo;
  // the Tracks sheet's Demo buttons start one in place.
  const [demo, setDemo] = useState<Simulation | null>(simulate);
  const simulated = demo ? index.tracks.find((t) => t.slug === demo.slug) ?? null : null;
  const geo = useGeolocation(!fixedPos && !demo);
  const [bundles, setBundles] = useState<Record<string, TrackExport>>({});
  const [bundleErrors, setBundleErrors] = useState<Record<string, string>>({});
  const route = useSimulatedRoute(simulated ? bundles[simulated.slug] : undefined);
  const sim = useDriveSim(route.path, NO_WAYPOINTS);
  const pos = demo ? sim.pos : fixedPos ?? geo.pos;
  const course = demo ? sim.headingDeg : fixedPos ? null : geo.courseDeg;
  /** Ground speed as the phone reports it: -1 when unknown, 0 while the demo's car is parked. */
  const speedMps = demo ? (sim.playing ? mphToMps(sim.mph) : 0) : fixedPos ? -1 : geo.speedMps ?? -1;
  const atEnd = !!demo && sim.totalM > 0 && sim.distM >= sim.totalM;

  // ── How you're moving: the phone's ActivityModePreference and detector ────
  const [modePreference, setModePreference] = useState<ModePreference>(() => readSetting(MODE_KEY, "auto", MODE_PREFERENCES));
  useEffect(() => { try { localStorage.setItem(MODE_KEY, modePreference); } catch { /* private storage */ } }, [modePreference]);
  const modeDetector = useRef(new ActivityModeDetector());
  const [inferredMode, setInferredMode] = useState(() => modeDetector.current.current);
  useEffect(() => {
    if (fixedPos || demo || !geo.pos) return;
    const next = modeDetector.current.observe(geo.speedMps ?? -1, geo.at / 1000);
    if (next) setInferredMode(next);
  }, [fixedPos, demo, geo.pos, geo.speedMps, geo.at]);
  // A demo declares its pace — `?mph=`, else the mode's, else by the track's
  // size — so there is nothing to infer.
  const pace = demo?.mph ?? demoPace(simulated, modePreference);
  useEffect(() => { sim.setMph(pace); }, [pace, sim.setMph]);
  const mode = modePreference !== "auto" ? modePreference : demo ? simulatedMode(pace) : inferredMode;

  // ── Tracks: which are on, and their loaded bundles ────────────────────────
  // Until the user chooses, the tracks near them are on — a first fix in Marin
  // should not pull Hawaii and Montana down over cellular. Every bundle carries
  // its full transcripts, so this is the difference between a few megabytes
  // and all of them.
  // A demo starts with its own track alone and never saves the choice: the
  // landing page's frame must not set up the visitor's real app, and ending
  // a demo restores the tracks that were on before it.
  const [chosen, setChosen] = useState<Set<string> | null>(() => (simulate ? null : loadEnabled(index, server)));
  const chosenBeforeDemo = useRef<Set<string> | null>(simulate ? loadEnabled(index, server) : null);
  const near = useMemo(() => (!demo && pos ? tracksNear(index, pos) : null), [demo, index, pos]);
  const enabled = useMemo(() => {
    const on = new Set(chosen ?? near ?? (simulated ? [simulated.slug] : []));
    if (simulated) on.add(simulated.slug); // the demo's own track stays on
    return on;
  }, [chosen, near, simulated]);
  const setEnabled = (next: Set<string>) => setChosen(next);
  useEffect(() => {
    if (!chosen || demo) return;
    try { localStorage.setItem(enabledKey(server), JSON.stringify([...chosen])); } catch { /* private storage */ }
  }, [chosen, demo, server]);
  // Each bundle is fetched once. Loads outlive re-renders and are only
  // discarded when the view unmounts; cancelling them on every state change
  // meant the largest track was downloaded three times.
  const mounted = useRef(true);
  const loading = useRef(new Set<string>());
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    for (const t of index.tracks) {
      if (!enabled.has(t.slug) || bundles[t.slug] || bundleErrors[t.slug] || loading.current.has(t.slug)) continue;
      loading.current.add(t.slug);
      loadBundle(resolveTrackUrl(t, indexUrl))
        .then((b) => { if (mounted.current) setBundles((prev) => (prev[t.slug] ? prev : { ...prev, [t.slug]: b })); })
        .catch((e) => {
          if (mounted.current) setBundleErrors((prev) => ({ ...prev, [t.slug]: e instanceof Error ? e.message : String(e) }));
        })
        .finally(() => loading.current.delete(t.slug));
    }
  }, [index, indexUrl, enabled, bundles, bundleErrors]);
  const active = useMemo(
    () => index.tracks.filter((t) => enabled.has(t.slug)).map((t) => bundles[t.slug]).filter((b): b is TrackExport => !!b),
    [index, enabled, bundles],
  );

  // ── Settings ───────────────────────────────────────────────────────────────
  const [units, setUnits] = useState<Units>(() => readSetting("tourUnits", "imperial", ["imperial", "metric"] as const));
  useEffect(() => { try { localStorage.setItem("tourUnits", units); } catch { /* private storage */ } }, [units]);
  const [gapSeconds, setGapSeconds] = useState(loadGapSeconds);
  const [sheetOpen, setSheetOpen] = useState(false);

  // ── Playback ───────────────────────────────────────────────────────────────
  // A demo's stories are heard for this page only: a visitor who drove
  // Going-to-the-Sun Road in the landing page's frame would otherwise find
  // them in cooldown on the real road. The real history waits underneath.
  const [persistent] = useState(() => persistentHistory());
  const [demoHistory] = useState(() => persistentHistory({ storage: null }));
  const history = demo ? demoHistory : persistent;
  const historyRef = useRef(history);
  historyRef.current = history;
  const [historyTick, setHistoryTick] = useState(0);
  // The sequence gate reads whatever bundles are loaded at decision time.
  const bundlesRef = useRef<Record<string, TrackExport>>({});
  // Recordings fetched ahead of their turn — up next, and a demo's next two stops — so a start is instant.
  const [prefetch] = useState(() => new AudioPrefetch());
  const [player] = useState(() => new TourPlayback(undefined, {
    history,
    released: (item) => sequenceReleased(item, bundlesRef.current[item.track.slug], (id) => historyRef.current.heard(id)),
    resolveAudio: (url) => prefetch.resolve(url),
  }));
  useEffect(() => { player.setHistory(history); }, [player, history]);
  useEffect(() => { bundlesRef.current = bundles; }, [bundles]);
  useEffect(() => {
    player.setGapSeconds(gapSeconds);
    try { localStorage.setItem(GAP_KEY, String(gapSeconds)); } catch { /* private storage */ }
  }, [player, gapSeconds]);
  const playback = useSyncExternalStore(player.subscribe, player.getSnapshot);
  const [running, setRunning] = useState(false);
  const [reader, setReader] = useState<{ stories: NearbySpot[]; initialId: string } | null>(null);

  // A demo opens on its whole tour with the car at the start; the map
  // follows the car only once the tour starts.
  const [following, setFollowing] = useState(!simulate);
  const [center, setCenter] = useState<{ pos: LngLat; zoom?: number; key: number } | null>(null);
  const [fit, setFit] = useState<{ points: LngLat[]; key: number } | null>(null);
  // The map is built already looking at the right place whenever that is
  // known before any bundle has arrived — a demo's track, from its index
  // entry, or where `?at=` stands — so nothing flies in from the world.
  const [initialView] = useState(() => {
    if (simulate) {
      const track = index.tracks.find((t) => t.slug === simulate.slug);
      return track ? trackCamera(track) : null;
    }
    return fixedPos ? { center: fixedPos, zoom: 14 } : null;
  });
  const centeredOnce = useRef(false);
  // Once its tour starts, a demo is watched from the car, close enough that
  // its pace shows — a walk closer than a drive — and the map scrolls under
  // the centered marker. Until then the map shows the
  // whole tour (`fit`, below), the car at its start.
  const demoZoom = simulatedMode(pace) === "driving" ? 15 : 17;
  useEffect(() => {
    if (!pos || demo || centeredOnce.current) return;
    centeredOnce.current = true;
    setCenter((c) => ({ pos, zoom: 14, key: (c?.key ?? 0) + 1 }));
  }, [pos, demo]);

  // ── What's nearby, across every enabled track ──────────────────────────────
  const mapSpots = useMemo(() => active.flatMap((b) => b.spots.map((s) => s.spot)), [active]);
  const spotColors = useMemo(() => {
    const colors: Record<string, string> = {};
    for (const b of active) for (const s of b.spots) colors[s.spot.id] = b.track.color ?? "#3c8b9b";
    return colors;
  }, [active]);
  const nearby: NearbySpot[] = useMemo(() => {
    if (!pos) return [];
    return active
      .flatMap((b) => computeNearby(b.track, b.spots, pos, course, Infinity))
      .sort((a, b) => a.distanceM - b.distanceM);
  }, [active, pos, course]);
  // The fix a decision runs on — what the phone's scheduler context reads.
  const trackIdToSlug = useMemo(() => Object.fromEntries(active.map((b) => [b.track.id, b.track.slug])), [active]);
  const fix = useMemo<Fix>(() => ({
    location: pos ? { lat: pos.lat, lng: pos.lng, speedMps } : null,
    courseDeg: course,
    mode,
    trackIdToSlug,
  }), [pos, speedMps, course, mode, trackIdToSlug]);
  // Decide on every fix; a passed arrival is never retained.
  useEffect(() => {
    if (running) player.next(nearby, fix);
  }, [nearby, fix, running, playback.item, player]);
  useEffect(() => {
    if (!running) return;
    const id = setInterval(player.decide, POLL_MS);
    return () => clearInterval(id);
  }, [running, player]);
  const carPending = useRef(false);
  // The demo's driver: story to story. The stops are every narratable spot
  // at the distance along the route where its trigger is entered (an
  // off-road one at the nearest road point); `demoStep` says what the car
  // does — wait at the next stop while a story plays, and once the player
  // has been idle for the story spacing, jump to just before the next
  // unheard stop, drive in, and play it if the scheduler did not.
  const demoBundle = simulated ? bundles[simulated.slug] : undefined;
  // A demo opens on the rectangle around its spots — at once, no flight in —
  // with the car at the start of the route, whether the page opened in it or
  // it was chosen from the Tracks sheet. Until the bundle is here the map
  // stands where it was (`initialView`, for a page opened in a demo).
  useEffect(() => {
    if (!demo || !demoBundle) return;
    const points = demoBundle.spots.map((s) => triggerAnchor(s.spot.trigger)).filter((p): p is LngLat => p !== null);
    if (points.length) setFit((f) => ({ points, key: (f?.key ?? 0) + 1 }));
  }, [demo, demoBundle]);
  const demoStops = useMemo(
    () => (demo && demoBundle && route.path.length >= 2 ? planNarrationStops(demoBundle.track, demoBundle.spots, route.path, true) : []),
    [demo, demoBundle, route.path],
  );
  // Upcoming recordings stay pending across arrivals and overlapping stops.
  const demoAhead = nextDemoStops(demoStops, player.isAvailable);
  const demoNext = demoAhead[0];
  // Reaching the route's end does not finish the demo while a story remains.
  // Several stories can share that endpoint (the visitor center, for example).
  const demoComplete = atEnd && !playback.item && !demoNext;
  useEffect(() => {
    if (!demoComplete || !running || sim.playing) return;
    setRunning(false);
    player.pause();
  }, [demoComplete, running, sim.playing, player]);
  // Start may be pressed before the bundle/route arrives. Begin narration
  // as soon as it is ready, using the audio output unlocked by that gesture.
  useEffect(() => {
    if (!carPending.current || !demo || !running || route.path.length < 2) return;
    carPending.current = false;
    if (demoNext && !player.getSnapshot().item) {
      sim.seekTo(demoNext.distM);
      player.play(demoNext.item, true);
    }
    if ((demoNext?.distM ?? sim.distM) < sim.totalM) sim.play();
  }, [demo, running, route.path, demoNext, player, sim.distM, sim.totalM, sim.seekTo, sim.play]);
  const idleSince = useRef<number | null>(null);
  const [demoTick, setDemoTick] = useState(0);
  useEffect(() => {
    if (!demo || !running) return;
    const id = setInterval(() => setDemoTick((t) => t + 1), 500); // the pause runs out while the car is parked
    return () => clearInterval(id);
  }, [demo, running]);
  useEffect(() => {
    if (!demo || !running || demoStops.length === 0) { idleSince.current = null; return; }
    const now = Date.now();
    if (playback.item) idleSince.current = null;
    else idleSince.current ??= now;
    const step = demoStep({
      item: !!playback.item, playing: playback.playing, moving: sim.playing, distM: sim.distM, totalM: sim.totalM,
      nextM: demoNext?.distM ?? null, idleMs: idleSince.current === null ? null : now - idleSince.current,
      gapMs: gapSeconds * 1000, leadM: demoLeadM(pace),
    });
    switch (step.kind) {
      case "park": sim.pause(); break;
      case "resume": sim.play(); break;
      case "seek": sim.seekTo(step.distM); if (!sim.playing) sim.play(); break;
      case "finish": sim.seekTo(sim.totalM); break;
      case "play": if (demoNext) player.play(demoNext.item, true); break;
      case "none": break;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo, running, demoStops, demoNext, playback.item, playback.playing, sim.playing, sim.distM, sim.totalM, gapSeconds, pace, demoTick]);

  const selected = playback.item;
  // A demo's up next is the next stop along the route when the scheduler has no target yet.
  const upNext = playback.upNext ?? (demo ? demoNext?.item ?? null : null);
  const warmUrls = [upNext?.content?.audioUrl ?? null, ...demoAhead.map((stop) => stop.item.content?.audioUrl ?? null)];
  const warmKey = warmUrls.join("|");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { prefetch.warm(warmUrls); }, [prefetch, warmKey]);
  const withinReach = nearby.filter((n) => n.distanceM <= NEARBY_RADIUS_M).length;

  // ── Tour on / off (the phone's start/stop) ────────────────────────────────
  const startTour = () => {
    // Driving the route again is a new demo: nothing heard yet, and the
    // stories at the end, where the car still stands, are not on offer —
    // the car is back at the start by the next frame.
    const again = demoComplete;
    if (again) {
      history.resetAll();
      player.reset();
      setHistoryTick((t) => t + 1);
    }
    setRunning(true);
    setFollowing(true);
    // The gesture that starts the tour is what unlocks audio output.
    player.start(demo ? [] : nearby, fix);
    if (demo) {
      // A demo starts with narration in this gesture, including when its
      // first stop is off-road. Resuming preserves the current recording.
      const next = again ? nextDemoStops(demoStops, player.isAvailable)[0] : demoNext;
      let startM = sim.distM;
      if (next && !player.getSnapshot().item) {
        startM = next.distM;
        sim.seekTo(startM);
        player.play(next.item, true);
      }
      // From here on the demo is watched from the car.
      if (pos) setCenter((c) => ({ pos, zoom: demoZoom, key: (c?.key ?? 0) + 1 }));
      if (route.path.length >= 2) { if (startM < sim.totalM) sim.play(); }
      else carPending.current = true;
    }
  };
  const stopTour = () => {
    setRunning(false);
    player.pause();
    if (demo) { carPending.current = false; sim.pause(); }
  };
  const skip = () => {
    if (demo && running) {
      // Next in a demo is the next stop, now: the car jumps there and its story starts.
      player.stop();
      const next = nextDemoStops(demoStops, player.isAvailable)[0];
      if (!next) return;
      sim.seekTo(next.distM);
      if (!sim.playing && next.distM < sim.totalM) sim.play();
      idleSince.current = null;
      player.play(next.item, true);
      return;
    }
    if (running || playback.item) player.stop();
  };
  const replay = () => { if (playback.item) player.play(playback.item, running); };
  // Pausing a demo's narration parks the car too, so nothing passes by unheard.
  const toggleNarration = () => {
    if (playback.playing) {
      player.pause();
      if (demo) sim.pause();
    } else {
      player.resume(running);
      if (demo && running && !atEnd) sim.play();
    }
  };
  const playStory = (item: NearbySpot) => {
    // A manual tap always plays, whatever the history says.
    player.play(item, running);
  };
  // Tapping a pin plays that story, as on the phone: it shows in the card
  // below the map with its transcript, and starts at once — a manual tap
  // always plays, whatever the history says. The full-screen reader is only
  // for reading, reached from the card itself.
  const selectSpot = (id: string) => {
    const item = nearby.find((n) => n.spot.id === id)
      ?? active.flatMap((b) => b.spots).filter((s) => s.spot.id === id).map(({ spot, content }) => ({
        spot, track: active.find((b) => b.spots.some((x) => x.spot.id === id))!.track,
        locating: null, distanceM: 0, triggered: false,
        content: content.find((c) => c.locale === "en") ?? content[0] ?? null, guide: null,
      } satisfies NearbySpot))[0];
    if (!item) return;
    setReader(null);
    player.play(item, running);
  };
  const followLocation = () => {
    setFollowing(true);
    if (pos) setCenter((c) => ({ pos, zoom: demo ? demoZoom : 15, key: (c?.key ?? 0) + 1 }));
  };
  const startOverAll = () => {
    history.resetAll();
    player.reset();
    setRunning(false);
    if (demo) sim.pause();
    setHistoryTick((t) => t + 1);
  };

  // ── Demo: a track's route as a simulated trip, from the Tracks sheet ──────
  const enterDemo = (slug: string) => {
    if (!index.tracks.some((t) => t.slug === slug)) return;
    if (!demo) chosenBeforeDemo.current = chosen;
    // Nothing heard yet, and nothing the real tour was doing carries over.
    // The demo's track alone is on, the map shows the whole tour with the
    // car at its start, and Start tour sets off — as when the page opens
    // in a demo.
    carPending.current = false;
    sim.reset();
    demoHistory.resetAll();
    player.pause();
    player.reset();
    player.setHistory(demoHistory);
    setChosen(null);
    setDemo({ slug, mph: null });
    setSheetOpen(false);
    setReader(null);
    setRunning(false);
    setFollowing(false);
    setHistoryTick((t) => t + 1);
    syncDemoUrl(slug);
  };
  const endDemo = () => {
    carPending.current = false;
    sim.pause();
    player.pause();
    player.reset();
    player.setHistory(persistent);
    setRunning(false);
    setDemo(null);
    setChosen(chosenBeforeDemo.current);
    setFollowing(true);
    centeredOnce.current = false;
    setHistoryTick((t) => t + 1);
    syncDemoUrl(null);
  };

  // ── System integration ─────────────────────────────────────────────────────
  const awake = useKeepAwake(running && !demo);
  const latest = useRef({ startTour, stopTour, skip, replay, toggleNarration });
  latest.current = { startTour, stopTour, skip, replay, toggleNarration };
  useEffect(() => {
    setMediaHandlers({
      play: () => latest.current.startTour(),
      pause: () => latest.current.stopTour(),
      nexttrack: () => latest.current.skip(),
      previoustrack: () => latest.current.replay(),
    });
    return () => setMediaHandlers({});
  }, []);
  useEffect(() => {
    setNowPlaying(selected ? { title: selected.spot.title, artist: selected.track.name } : null);
    setPlaybackState(playback.playing ? "playing" : selected ? "paused" : "none");
  }, [selected, playback.playing]);

  // ── Status line ────────────────────────────────────────────────────────────
  const insecure = typeof window !== "undefined" && !window.isSecureContext && !fixedPos && !demo;
  const reach = `${withinReach} ${withinReach === 1 ? "story" : "stories"} within ${formatDistance(NEARBY_RADIUS_M, units)}`;
  let status = "";
  let statusWarn = false;
  if (demo) {
    const trip = simulatedMode(pace) === "driving" ? "Simulated drive" : "Simulated walk";
    if (!simulated) { status = `There is no track "${demo.slug}" on this server.`; statusWarn = true; }
    else if (bundleErrors[simulated.slug]) { status = `Could not load ${simulated.name}: ${bundleErrors[simulated.slug]}`; statusWarn = true; }
    else if (route.error) { status = route.error; statusWarn = true; }
    else if (!pos) status = "Preparing the route…";
    else if (atEnd) status = `${trip} · end of the route`;
    else status = `${trip} · ${reach}`;
  }
  else if (fixedPos) status = `Simulated position · ${reach}`;
  else if (insecure) { status = "Location needs a secure (https) address on phones."; statusWarn = true; }
  else if (geo.denied) { status = "Location is off. Allow it for this site to hear stories as you move."; statusWarn = true; }
  else if (geo.error && !pos) { status = geo.error; statusWarn = true; }
  else if (!pos) status = "Finding your location…";
  else if (enabled.size === 0) status = "All tracks are off. Tap Tracks to choose what to hear.";
  else if (active.length === 0) status = "Loading tracks…";
  else if (active.length < enabled.size) status = `Loading tracks… (${active.length}/${enabled.size})`;
  else if (nearby.length === 0) status = "The tracks that are on have no stories.";
  else status = `${reach} · nearest ${formatDistance(nearby[0]!.distanceM, units)}`;

  const enabledCount = index.tracks.filter((t) => enabled.has(t.slug)).length;
  const label = selected
    ? (playback.playing ? "Now playing" : "Paused")
    : running ? (upNext ? "Up next" : "Listening for stories") : "Tour is off";

  return (
    <div className={`tour-app gt-app${reader ? " reader-open" : ""}${sheetOpen ? " sheet-open" : ""}`}>
      <audio ref={player.attach} onPlay={player.onPlay} onPause={player.onPause}
        onEnded={player.onAudioEnded} onTimeUpdate={player.onTime} onError={player.onError} playsInline />
      <ViewerMap spots={mapSpots} trackColor={undefined} spotColors={spotColors} selectedId={selected?.spot.id ?? null}
        onSelect={selectSpot} onExplore={() => setFollowing(false)} onFollowLocation={followLocation}
        following={following} followingLocation={following && !!pos} routePath={demo ? route.path : null}
        traveler={pos ? { pos, headingDeg: course ?? 0 } : null} center={center} initialView={initialView} fit={fit} />

      <div className="tour-panel" aria-label="Tour">
        <div className="tour-header">
          <h1>GrandTour</h1>
          <button className="tracks-button" onClick={() => setSheetOpen(true)} aria-label="Tracks">
            ▤ Tracks <span className="muted">{enabledCount}/{index.tracks.length}</span>
          </button>
        </div>
        {demo && <div className="demo-banner">
          <span>Demo{simulated ? ` · ${simulated.name}` : ""}</span>
          <button className="link-btn" onClick={endDemo}>End demo</button>
        </div>}
        <div className={`app-status${statusWarn ? " warn" : ""}`} role="status">{status}</div>
        <div className="app-controls">
          <button className="ghost" onClick={replay} disabled={!playback.item} title="Replay" aria-label="Replay this story">⏮</button>
          <button className={`tour-toggle${running ? " running" : ""}`} onClick={running ? stopTour : startTour}>
            {running ? "■ Stop tour" : "▶ Start tour"}
          </button>
          <button className="ghost" onClick={skip} disabled={!playback.item} title="Skip" aria-label="Skip this story">⏭</button>
        </div>
        <NowPlayingCard item={selected ?? upNext} label={label} selected={!!selected} playing={playback.playing}
          currentMs={playback.currentMs} source={playback.source} error={playback.error}
          onOpen={() => {
            const item = selected ?? upNext;
            if (item) setReader({ stories: nearby.length ? nearby : [item], initialId: item.spot.id });
          }}
          onToggle={toggleNarration} />
      </div>

      {sheetOpen && <TrackSheet index={index} server={server} enabled={enabled} bundles={bundles} errors={bundleErrors}
        history={history} historyTick={historyTick} pos={pos} units={units} gapSeconds={gapSeconds} modePreference={modePreference}
        demoSlug={demo?.slug ?? null} onDemo={enterDemo}
        screenNote={awake.supported
          ? `Screen stays on while the tour runs${awake.held ? " (on now)" : ""} — phones stop sharing location once the screen locks.`
          : "Keep the screen on while touring: phones stop sharing location once the screen locks."}
        onChange={setEnabled} onUnits={setUnits} onGap={setGapSeconds} onMode={setModePreference}
        onForget={(ids) => { history.forget(ids); setHistoryTick((t) => t + 1); }}
        onStartOverAll={startOverAll} onClose={() => setSheetOpen(false)} />}
      {reader && <StoryReader {...reader} selectedId={selected?.spot.id ?? null} playing={playback.playing}
        source={playback.source} currentMs={playback.currentMs} error={playback.error} units={units}
        onClose={() => setReader(null)} onToggle={toggleNarration} onPlay={playStory} />}
    </div>
  );
}

interface TrackSheetProps {
  index: Index;
  server: string;
  enabled: Set<string>;
  bundles: Record<string, TrackExport>;
  errors: Record<string, string>;
  history: PersistentHistory;
  /** Bumped when the history changes underneath, so progress re-renders. */
  historyTick: number;
  pos: LngLat | null;
  units: Units;
  gapSeconds: number;
  modePreference: ModePreference;
  screenNote: string;
  /** The track whose demo is running, if any. */
  demoSlug: string | null;
  onDemo: (slug: string) => void;
  onChange: (next: Set<string>) => void;
  onUnits: (units: Units) => void;
  onGap: (seconds: number) => void;
  onMode: (mode: ModePreference) => void;
  onForget: (ids: string[]) => void;
  onStartOverAll: () => void;
  onClose: () => void;
}

/**
 * The phone's Tracks sheet (`TrackSheet` in ContentView.swift): full screen,
 * "N of M tracks on" with All on / All off, a switch per track with Only this
 * track, then story spacing and the rest. Catalog order, as on the phone.
 */
function TrackSheet({ index, server, enabled, bundles, errors, history, historyTick, pos, units, gapSeconds, modePreference, screenNote,
  demoSlug, onDemo, onChange, onUnits, onGap, onMode, onForget, onStartOverAll, onClose }: TrackSheetProps) {
  const sheet = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    sheet.current?.focus();
    return () => previous?.focus();
  }, []);
  const toggle = (slug: string) => {
    const next = new Set(enabled);
    if (next.has(slug)) next.delete(slug); else next.add(slug);
    onChange(next);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const heardIds = useMemo(() => new Set(history.ids()), [history, historyTick]);

  return <div className="track-sheet" role="dialog" aria-modal="true" aria-label="Tracks" tabIndex={-1} ref={sheet}
    onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}>
    <header className="sheet-bar">
      <span className="bar-spacer" />
      <h1>Tracks</h1>
      <button className="done" onClick={onClose}>Done</button>
    </header>
    <div className="sheet-body">
      <section className="sheet-section">
        <h2>{enabled.size} of {index.tracks.length} tracks on</h2>
        <div className="sheet-group">
          <div className="sheet-row split">
            <button className="link-btn" onClick={() => onChange(new Set(index.tracks.map((t) => t.slug)))}>All on</button>
            <button className="link-btn" onClick={() => onChange(new Set())}>All off</button>
          </div>
        </div>
        <p className="sheet-footer">Use a switch to mix tracks, or tap Only this track to listen to one. Demo plays a track as a simulated trip along its route.</p>
      </section>

      <section className="sheet-section">
        <h2>Tracks</h2>
        <div className="sheet-group">
          {index.tracks.map((t) => {
            const ids = bundles[t.slug]?.spots.map((s) => s.spot.id) ?? [];
            const played = ids.filter((id) => heardIds.has(id)).length;
            return <TrackItem key={t.slug} track={t} on={enabled.has(t.slug)} played={played} pos={pos} units={units}
              error={errors[t.slug]} demo={demoSlug === t.slug} onToggle={() => toggle(t.slug)} onOnly={() => onChange(new Set([t.slug]))}
              onDemo={() => onDemo(t.slug)} onStartOver={() => onForget(ids)} />;
          })}
        </div>
        <p className="sheet-footer">
          When several stories are in range at once, the one you're heading toward plays first.
          A finished series stays finished until you tap Start over to hear it fresh.
        </p>
      </section>

      <section className="sheet-section">
        <h2>Server</h2>
        <ServerPicker server={server} />
        <p className="sheet-footer">Where the tracks come from. Switching reloads the list and stops the tour.</p>
      </section>

      <section className="sheet-section">
        <h2>Story spacing</h2>
        <div className="sheet-group">
          <label className="sheet-row split">Pause between stories
            <select aria-label="Pause between stories" value={gapSeconds} onChange={(e) => onGap(Number(e.target.value))}>
              {GAP_OPTIONS.map((s) => <option key={s} value={s}>{s} seconds</option>)}
            </select>
          </label>
        </div>
        <p className="sheet-footer">The pause starts when a story finishes.</p>
      </section>

      <section className="sheet-section">
        <h2>Travel</h2>
        <div className="sheet-group">
          <label className="sheet-row split">How you're moving
            <select aria-label="How you're moving" value={modePreference} onChange={(e) => onMode(e.target.value as ModePreference)}>
              <option value="auto">Automatic</option>
              {ACTIVITY_MODES.map((m) => <option key={m} value={m}>{m[0]!.toUpperCase() + m.slice(1)}</option>)}
            </select>
          </label>
        </div>
        <p className="sheet-footer">Automatic tells walking from driving by your speed. A story starts early enough to finish as you arrive.</p>
      </section>

      <section className="sheet-section">
        <h2>Units</h2>
        <div className="sheet-group">
          <label className="sheet-row split">Distances
            <select aria-label="Units" value={units} onChange={(e) => onUnits(e.target.value as Units)}>
              <option value="imperial">Imperial</option>
              <option value="metric">Metric</option>
            </select>
          </label>
        </div>
      </section>

      <section className="sheet-section">
        <h2>Screen</h2>
        <p className="sheet-footer">{screenNote}</p>
      </section>

      <section className="sheet-section">
        <h2>History</h2>
        <div className="sheet-group">
          <div className="sheet-row">
            <button className="link-btn" disabled={heardIds.size === 0} onClick={() => {
              if (window.confirm("Forget every story you've heard, so all of them can play again?")) onStartOverAll();
            }}>Start over{heardIds.size ? ` · ${heardIds.size} heard` : ""}</button>
          </div>
        </div>
      </section>
    </div>
  </div>;
}

function TrackItem({ track, on, played, pos, units, error, demo, onToggle, onOnly, onDemo, onStartOver }: {
  track: IndexTrack; on: boolean; played: number; pos: LngLat | null; units: Units; error?: string; demo: boolean;
  onToggle: () => void; onOnly: () => void; onDemo: () => void; onStartOver: () => void;
}) {
  const total = track.voicedCount;
  const finished = track.lifecycle === "series" && total > 0 && played >= total;
  const km = pos ? haversineM(pos, track.center) / 1000 : null;
  const away = km === null || km <= track.spanKm / 2 ? "" : ` · ${formatDistance(km * 1000, units)} away`;
  return <div className="track-item">
    <label className="track-toggle">
      <input type="checkbox" className="switch" checked={on} onChange={onToggle} aria-label={`${track.name}${on ? ", on" : ", off"}`} />
      <span className="track-text">
        <span className="track-title">
          <span className="track-swatch" style={{ background: track.color ?? "#3c8b9b" }} aria-hidden="true" />
          {track.name}
          {finished && <span className="badge-done">✓ Finished</span>}
        </span>
        <span className="muted">
          {total} {total === 1 ? "spot" : "spots"}{track.minutes >= 1 ? ` · ${Math.round(track.minutes)} min` : ""}{away}
        </span>
        {track.description && <span className="track-desc">{track.description}</span>}
        {played > 0 && !finished && <span className="muted">{played} of {total} heard</span>}
        {error && <span className="warn">Could not load: {error}</span>}
      </span>
    </label>
    <div className="track-actions">
      <button className="link-btn" onClick={onOnly} aria-label={`Only ${track.name}`}>Only this track</button>
      {track.spotCount > 0 && <button className="link-btn" onClick={onDemo} disabled={demo} aria-label={`Demo ${track.name}`}>{demo ? "Demo on" : "Demo"}</button>}
      {played > 0 && <button className="link-btn" onClick={onStartOver} aria-label={`Start ${track.name} over`}>Start over</button>}
    </div>
  </div>;
}
