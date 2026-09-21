import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import type { LngLat, Spot } from "@grandtour/shared";
import { haversineM, triggerAnchor } from "@grandtour/shared";
import { smoothHeading, smoothTravelerPosition, travelerFrameElapsed } from "./travelerMotion";
import { fitCamera, type Camera } from "./camera";

interface Props {
  spots: Spot[];
  trackColor: string | undefined;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onExplore: (p: LngLat) => void;
  onFollowLocation: () => void;
  /** Keep the traveler centered while the map scrolls, for GPS and demos alike. */
  following: boolean;
  followingLocation: boolean;
  /** Drive-mode route polyline, or null to hide it. */
  routePath: LngLat[] | null;
  /** Live traveler position (GPS or simulated), or null to hide the icon. */
  traveler: { pos: LngLat; headingDeg: number } | null;
  /** Per-spot pin colour, for maps that show several tracks at once. */
  spotColors?: Record<string, string>;
  /** Move the camera when `key` changes — the app centres on the first fix and on the locate button. */
  center?: { pos: LngLat; zoom?: number; key: number } | null;
  /**
   * Where the map opens when the app knows before any bundle has arrived —
   * a demo's track from its index entry, or where `?at=` stands. Read once,
   * at construction; without it the map fits the spots it mounts with.
   */
  initialView?: Camera | null;
  /**
   * The rectangle around these points, shown when `key` changes — at once,
   * no easing: a demo's whole tour, the car at its start. Present at
   * construction, it is the view the map is built with.
   */
  fit?: { points: LngLat[]; key: number } | null;
}

// Same free demo raster style as admin's MapView — no key required.
const STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "© OpenStreetMap",
    },
  },
  layers: [{ id: "osm", type: "raster", source: "osm" }],
};

const ACCENT = "#3c8b9b";
const ROUTE_COLOR = "#e0a33c";
/** Around a fitted rectangle, so its outermost pins sit inside the edge. */
const FIT_PADDING = 40;
/** A fitted rectangle never zooms closer than this — one spot is a neighbourhood, not a rooftop. */
const FIT_MAX_ZOOM = 16;
/** Retarget one continuous native animation; MapLibre paints the frames between fixes. */
const FOLLOW_INTERVAL_MS = 100;
const FOLLOW_DURATION_MS = 250;
const FOLLOW_EASE_ID = "traveler-follow";
const linear = (t: number) => t;

// White-cased heading arrow, matching admin's simulated-traveler marker.
const TRAVELER_SVG = `
<svg width="30" height="30" viewBox="0 0 30 30" xmlns="http://www.w3.org/2000/svg" style="display:block">
  <circle cx="15" cy="15" r="13" fill="${ACCENT}" stroke="#ffffff" stroke-width="2.5"/>
  <path d="M15 5 L21 21 L15 17 L9 21 Z" fill="#ffffff"/>
</svg>`;

/**
 * Bounding-box center + a zoom that roughly fits the spread, computed
 * synchronously so the map can be constructed already pointed at the right
 * place. Deliberately NOT done via a post-load fitBounds()/jumpTo() call:
 * in testing, a camera change made from inside (or shortly after) the map's
 * "load" event reliably got silently reverted to the constructor's initial
 * center on the next render — getCenter() looked right immediately after
 * the call, but the displayed camera (and every marker's projected screen
 * position) snapped back moments later, with no error and no "move" event
 * for the reverted state. Setting the real center/zoom at construction
 * sidesteps that entirely. Falls back to a low zoom over Null Island only
 * when there are truly no anchors (never in practice: a loaded bundle
 * always has spots by the time ViewerMap mounts).
 */
function initialCamera(spots: Spot[]): { center: [number, number]; zoom: number } {
  return constructorCamera(fitCamera(spots.map((s) => triggerAnchor(s.trigger)).filter((a): a is LngLat => a !== null)));
}

function constructorCamera(camera: Camera): { center: [number, number]; zoom: number } {
  return { center: [camera.center.lng, camera.center.lat], zoom: camera.zoom };
}

/** The box around some points, as MapLibre bounds. */
function boundsOf(points: LngLat[]): [[number, number], [number, number]] {
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const p of points) {
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
    minLng = Math.min(minLng, p.lng);
    maxLng = Math.max(maxLng, p.lng);
  }
  return [[minLng, minLat], [maxLng, maxLat]];
}

export function ViewerMap(props: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const travelerOverlayRef = useRef<HTMLDivElement | null>(null);
  const travelerHeadingRef = useRef<HTMLDivElement | null>(null);
  const travelerTargetRef = useRef(props.traveler);
  const displayedTravelerRef = useRef(props.traveler);
  const followingCameraRef = useRef(false);
  const interactingRef = useRef(false);
  const cbRef = useRef(props);
  cbRef.current = props;
  travelerTargetRef.current = props.traveler;
  // Read once, synchronously, for the map constructor below — later spot
  // updates don't re-frame (see the module comment); this only needs the
  // set of spots as they are the moment the map is first created.
  const initialSpotsRef = useRef(props.spots);
  const initialViewRef = useRef(props.initialView);
  const initialFitRef = useRef(props.fit);

  useEffect(() => {
    if (!ref.current || mapRef.current) return;
    const fit = initialFitRef.current?.points.length ? initialFitRef.current : null;
    const known = initialViewRef.current;
    const { center, zoom } = fit ? constructorCamera(fitCamera(fit.points))
      : known ? constructorCamera(known)
      : initialCamera(initialSpotsRef.current);
    const map = new maplibregl.Map({
      container: ref.current,
      style: STYLE,
      center,
      zoom,
      // The rectangle itself, fitted to the container as it is at construction; center/zoom above stand in
      // should the container have no size yet.
      ...(fit ? { bounds: boundsOf(fit.points), fitBoundsOptions: { padding: FIT_PADDING, maxZoom: FIT_MAX_ZOOM } } : {}),
    });
    mapRef.current = map;

    // A press stops MapLibre's easing before its drag events start. Don't
    // restart follow in that gap and cancel the gesture the user just began.
    const pointers = new Set<number>();
    const pointerDown = (event: PointerEvent) => {
      pointers.add(event.pointerId);
      interactingRef.current = true;
    };
    const pointerUp = (event: PointerEvent) => {
      pointers.delete(event.pointerId);
      interactingRef.current = pointers.size > 0;
    };
    const canvasContainer = map.getCanvasContainer();
    canvasContainer.addEventListener("pointerdown", pointerDown);
    window.addEventListener("pointerup", pointerUp);
    window.addEventListener("pointercancel", pointerUp);

    map.on("load", () => {
      map.addSource("route", { type: "geojson", data: empty() });
      map.addLayer({
        id: "route-line",
        type: "line",
        source: "route",
        paint: {
          "line-color": ROUTE_COLOR,
          "line-width": 5,
          "line-opacity": 0.9,
          "line-blur": 0.65,
        },
        layout: { "line-cap": "round", "line-join": "round" },
      });
      map.addSource("spots", { type: "geojson", data: empty() });
      map.addLayer({
        id: "spot-halo",
        type: "circle",
        source: "spots",
        paint: {
          "circle-radius": 10,
          "circle-color": "rgba(0, 0, 0, 0.3)",
        },
      });
      map.addLayer({
        id: "spot-points",
        type: "circle",
        source: "spots",
        paint: {
          "circle-radius": 8,
          "circle-color": [
            "case",
            ["boolean", ["get", "selected"], false],
            "#8B5E3C",
            ["get", "color"],
          ],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 2,
        },
      });
      renderRoute(map, cbRef.current.routePath);
      renderSpots(
        map,
        cbRef.current.spots,
        cbRef.current.trackColor,
        cbRef.current.selectedId,
        cbRef.current.spotColors,
      );
    });

    map.on("click", (e) => {
      if (map.getLayer("spot-points")) {
        const hit = map.queryRenderedFeatures(e.point, { layers: ["spot-points"] })[0];
        const id = hit?.properties?.id;
        if (typeof id === "string") {
          cbRef.current.onSelect(id);
          return;
        }
      }
      cbRef.current.onExplore({ lat: e.lngLat.lat, lng: e.lngLat.lng });
    });
    map.on("mouseenter", "spot-points", () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", "spot-points", () => { map.getCanvas().style.cursor = ""; });
    let exploring = false;
    const exploreCenter = () => {
      const center = map.getCenter();
      cbRef.current.onExplore({ lat: center.lat, lng: center.lng });
    };
    // A drag reports a possible exploration center. The parent accepts it
    // only while idle, so manipulating the map cannot interrupt playback.
    const manualMove = (event: { originalEvent?: unknown }) => {
      if (!event.originalEvent) return;
      exploring = true;
      exploreCenter();
    };
    // Zooming and rotating are purely visual and must never alter playback.
    // A drag can update the exploration center when the parent is idle; the
    // parent deliberately ignores it while any playback is active.
    map.on("dragstart", manualMove);
    map.on("movestart", (event) => {
      followingCameraRef.current = "followingTraveler" in event && event.followingTraveler === true;
    });
    map.on("moveend", () => {
      followingCameraRef.current = false;
      if (exploring) { exploring = false; exploreCenter(); }
    });
    map.on("render", () => {
      renderTraveler(
        map,
        travelerOverlayRef.current,
        travelerHeadingRef.current,
        displayedTravelerRef.current,
        cbRef.current.following && followingCameraRef.current,
      );
    });

    // The viewer's panel/layout can settle its final size after maplibre's
    // own container measurement (e.g. the bottom panel's content loading in),
    // which otherwise leaves the canvas stuck at its initial size.
    const resize = new ResizeObserver(() => map.resize());
    resize.observe(ref.current);

    return () => {
      resize.disconnect();
      canvasContainer.removeEventListener("pointerdown", pointerDown);
      window.removeEventListener("pointerup", pointerUp);
      window.removeEventListener("pointercancel", pointerUp);
      interactingRef.current = false;
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Spots are a native MapLibre circle layer, so they are composited in the
  // same frame as the basemap. DOM markers visibly lag behind a moving WebGL
  // canvas by a frame and appear to jiggle against streets while following.
  // Not gated on `isStyleLoaded()`: that is false whenever a tile is still
  // loading, which is exactly when the bundles arrive — the first fix moves
  // the camera and starts the downloads — and spots skipped then stayed
  // hidden until a story changed the selection. `renderSpots` needs only the
  // source, which exists from the load event on; before it, the load handler
  // draws the latest props.
  useEffect(() => {
    const map = mapRef.current;
    if (map) renderSpots(map, props.spots, props.trackColor, props.selectedId, props.spotColors);
  }, [props.spots, props.selectedId, props.trackColor, props.spotColors]);

  // An explicit camera move, never a continuous follow: a fix arriving every
  // second must not fight the user's own panning.
  useEffect(() => {
    const map = mapRef.current;
    const target = props.center;
    if (!map || !target) return;
    map.easeTo({ center: [target.pos.lng, target.pos.lat], zoom: target.zoom ?? map.getZoom(), duration: 600 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.center?.key]);

  // The rectangle around some points — a demo's whole tour — shown at once.
  useEffect(() => {
    const map = mapRef.current;
    const fit = props.fit;
    if (!map || !fit || fit.points.length === 0) return;
    map.fitBounds(boundsOf(fit.points), { padding: FIT_PADDING, maxZoom: FIT_MAX_ZOOM, duration: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.fit?.key]);

  // Drive-mode route line — same rule as the spots.
  useEffect(() => {
    const map = mapRef.current;
    if (map) renderRoute(map, props.routePath);
  }, [props.routePath]);

  useEffect(() => {
    if (!props.following && followingCameraRef.current) mapRef.current?.stop();
  }, [props.following]);

  // Keep one native camera animation running while following. `jumpTo` on
  // every frame tells MapLibre the map is stationary, so raster tiles snap
  // to whole pixels and judder against the route. Retargeting an ease with
  // the same ID preserves its moving state and subpixel raster rendering.
  // The marker stays at the camera center during that animation. When the
  // user pans away, only the marker is interpolated across the stationary map.
  useEffect(() => {
    const map = mapRef.current;
    const initialTarget = travelerTargetRef.current;
    if (!map || !initialTarget) {
      displayedTravelerRef.current = null;
      return;
    }

    if (!displayedTravelerRef.current) displayedTravelerRef.current = initialTarget;
    renderTraveler(map, travelerOverlayRef.current, travelerHeadingRef.current, displayedTravelerRef.current);

    let frame: number | null = null;
    let lastMs: number | null = null;
    let lastFollowMs = -Infinity;
    let lastFollowTarget: LngLat | null = null;
    const follow = (nowMs: number) => {
      const target = travelerTargetRef.current;
      const displayed = displayedTravelerRef.current;
      if (target && displayed && lastMs !== null) {
        const elapsedMs = travelerFrameElapsed(nowMs - lastMs);
        const teleport = haversineM(displayed.pos, target.pos) > TELEPORT_M;
        const next = teleport ? target : {
          pos: smoothTravelerPosition(displayed.pos, target.pos, elapsedMs),
          headingDeg: smoothHeading(displayed.headingDeg, target.headingDeg, elapsedMs),
        };
        displayedTravelerRef.current = next;
        if (!cbRef.current.following) lastFollowTarget = null;
        // Explicit recenter/zoom animations and gestures keep control until
        // they finish. A Next-stop teleport still moves the map at once.
        if (cbRef.current.following && !interactingRef.current
          && (teleport || followingCameraRef.current || !map.isMoving())) {
          if (teleport) {
            map.jumpTo({ center: [target.pos.lng, target.pos.lat] });
            lastFollowTarget = target.pos;
            lastFollowMs = nowMs;
          } else if (nowMs - lastFollowMs >= FOLLOW_INTERVAL_MS
            && (lastFollowTarget?.lng !== target.pos.lng || lastFollowTarget?.lat !== target.pos.lat)) {
            map.easeTo({
              center: [target.pos.lng, target.pos.lat],
              duration: FOLLOW_DURATION_MS,
              easing: linear,
              easeId: FOLLOW_EASE_ID,
              essential: true,
            }, { followingTraveler: true });
            lastFollowTarget = target.pos;
            lastFollowMs = nowMs;
          }
        }
        renderTraveler(map, travelerOverlayRef.current, travelerHeadingRef.current, next,
          cbRef.current.following && followingCameraRef.current);
      }
      lastMs = nowMs;
      frame = requestAnimationFrame(follow);
    };
    frame = requestAnimationFrame(follow);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      if (followingCameraRef.current) map.stop();
    };
  }, [props.traveler !== null]);

  return (
    <div className="map-wrap">
      <div id="map" ref={ref} />
      {props.traveler && (
        <div className="traveler-overlay" role="img" aria-label="Current location" ref={travelerOverlayRef}>
          <div
            className="traveler-heading"
            ref={travelerHeadingRef}
            dangerouslySetInnerHTML={{ __html: TRAVELER_SVG }}
          />
        </div>
      )}
      <button className="locate-btn" title="Track my location on the map" aria-label="Track my location"
        aria-pressed={props.followingLocation} onClick={props.onFollowLocation}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="6.5" />
          <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
        </svg>
      </button>
    </div>
  );
}

/** Farther than this between two targets is a teleport: the marker snaps and the camera jumps. */
const TELEPORT_M = 500;

function renderTraveler(
  map: maplibregl.Map,
  overlay: HTMLDivElement | null,
  heading: HTMLDivElement | null,
  traveler: { pos: LngLat; headingDeg: number } | null,
  centered = false,
): void {
  if (!overlay || !traveler) return;
  const point = map.project(centered ? map.getCenter() : [traveler.pos.lng, traveler.pos.lat]);
  overlay.style.transform = `translate3d(${point.x - 15}px, ${point.y - 15}px, 0)`;
  if (heading) heading.style.transform = `rotate(${traveler.headingDeg - map.getBearing()}deg)`;
}

function empty(): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

function renderRoute(map: maplibregl.Map, path: LngLat[] | null): void {
  const src = map.getSource("route") as maplibregl.GeoJSONSource | undefined;
  if (!src) return;
  if (!path || path.length < 2) {
    src.setData(empty());
    return;
  }
  src.setData({
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: { type: "LineString", coordinates: path.map((p) => [p.lng, p.lat]) },
      },
    ],
  });
}

function renderSpots(
  map: maplibregl.Map,
  spots: Spot[],
  trackColor: string | undefined,
  selectedId: string | null,
  spotColors?: Record<string, string>,
): void {
  const src = map.getSource("spots") as maplibregl.GeoJSONSource | undefined;
  if (!src) return;
  const color = trackColor ?? ACCENT;
  src.setData({
    type: "FeatureCollection",
    features: spots.flatMap((spot) => {
      const anchor = triggerAnchor(spot.trigger);
      if (!anchor) return [];
      return [{
        type: "Feature" as const,
        properties: {
          id: spot.id,
          title: spot.title,
          color: spotColors?.[spot.id] ?? color,
          selected: spot.id === selectedId,
        },
        geometry: {
          type: "Point" as const,
          coordinates: [anchor.lng, anchor.lat],
        },
      }];
    }),
  });
}
