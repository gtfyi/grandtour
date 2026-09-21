import { useEffect, useRef, type MutableRefObject } from "react";
import maplibregl from "maplibre-gl";
import type { GeoTrigger, LngLat, PolygonRing, Spot } from "@grandtour/shared";
import { triggerAnchor } from "@grandtour/shared";

interface Props {
  spots: Spot[];
  selectedId: string | null;
  hoveredId: string | null;
  onHover: (id: string | null) => void;
  draft: { kind: "point" | "area"; center: LngLat; radiusM: number; region?: PolygonRing } | null;
  drawingPolygon: boolean;
  onMapClick: (p: LngLat) => void;
  onSelect: (id: string) => void;
  /** The draft's center pin was dragged to a new position. */
  onDraftMove: (p: LngLat) => void;
  /** Kept pointing at the map's current center, so "New spot" can drop there. */
  centerRef?: MutableRefObject<LngLat | null>;
  /**
   * Identifies the current track. When it changes and no spot is being edited,
   * the map frames this track's spots (their centroid + a fitting zoom).
   */
  frameKey?: string | null;
  /** Drive-simulator route polyline to draw, or null to hide it. */
  routePath?: LngLat[] | null;
  /** Live position of the simulated traveler, or null to hide the icon. */
  traveler?: { pos: LngLat; headingDeg: number } | null;
}

// Free demo raster style (no key). Swap for a vector style + key in production.
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

// Crosshair reticle for the draft trigger center: the exact coordinate is the
// middle of the cross (anchor: center), unlike a pin whose blob hides it.
// White casing under the accent lines keeps it visible on any map tile.
const CROSSHAIR_SVG = `
<svg width="28" height="28" viewBox="0 0 28 28" xmlns="http://www.w3.org/2000/svg" style="pointer-events:none;display:block">
  <g stroke="#ffffff" stroke-width="4" stroke-linecap="round">
    <line x1="14" y1="1.5" x2="14" y2="9"/><line x1="14" y1="19" x2="14" y2="26.5"/>
    <line x1="1.5" y1="14" x2="9" y2="14"/><line x1="19" y1="14" x2="26.5" y2="14"/>
  </g>
  <g stroke="#3c8b9b" stroke-width="2" stroke-linecap="round">
    <line x1="14" y1="1.5" x2="14" y2="9"/><line x1="14" y1="19" x2="14" y2="26.5"/>
    <line x1="1.5" y1="14" x2="9" y2="14"/><line x1="19" y1="14" x2="26.5" y2="14"/>
  </g>
  <circle cx="14" cy="14" r="2.4" fill="#3c8b9b" stroke="#ffffff" stroke-width="1.2"/>
</svg>`;

// Simulated traveler: a heading arrow (0° = pointing up/north; rotated by the
// marker to match course). White casing for contrast on any tile.
const TRAVELER_SVG = `
<svg width="30" height="30" viewBox="0 0 30 30" xmlns="http://www.w3.org/2000/svg" style="display:block">
  <circle cx="15" cy="15" r="13" fill="#3c8b9b" stroke="#ffffff" stroke-width="2.5"/>
  <path d="M15 5 L21 21 L15 17 L9 21 Z" fill="#ffffff"/>
</svg>`;

/** Approximate a circle as a GeoJSON polygon (meters radius). */
function circle(center: LngLat, radiusM: number, steps = 48): number[][] {
  const coords: number[][] = [];
  const lat = (center.lat * Math.PI) / 180;
  const dLat = radiusM / 111_320;
  const dLng = radiusM / (111_320 * Math.cos(lat));
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    coords.push([center.lng + dLng * Math.cos(a), center.lat + dLat * Math.sin(a)]);
  }
  return coords;
}

export function MapView(props: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const draftMarkerRef = useRef<maplibregl.Marker | null>(null);
  const travelerRef = useRef<maplibregl.Marker | null>(null);
  const cbRef = useRef(props);
  cbRef.current = props;

  // Initialize the map once.
  useEffect(() => {
    if (!ref.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: ref.current,
      style: STYLE,
      center: [-74.0059, 40.7128],
      zoom: 13,
    });
    mapRef.current = map;

    map.on("load", () => {
      map.addSource("draft", { type: "geojson", data: empty() });
      map.addLayer({
        id: "draft-line",
        type: "line",
        source: "draft",
        paint: { "line-color": "#3c8b9b", "line-width": 2 },
      });
      // Drive-simulator route line (under the draft layers so a spot's radius
      // still reads on top).
      map.addSource("route", { type: "geojson", data: empty() });
      map.addLayer(
        {
          id: "route-line",
          type: "line",
          source: "route",
          paint: { "line-color": "#e0a33c", "line-width": 4, "line-opacity": 0.85 },
          layout: { "line-cap": "round", "line-join": "round" },
        },
        "draft-line",
      );
      renderDraft(map, cbRef.current.draft);
      renderRoute(map, cbRef.current.routePath ?? null);
    });

    map.on("click", (e) => {
      cbRef.current.onMapClick({ lat: e.lngLat.lat, lng: e.lngLat.lng });
    });

    const syncCenter = () => {
      if (cbRef.current.centerRef) {
        const c = map.getCenter();
        cbRef.current.centerRef.current = { lat: c.lat, lng: c.lng };
      }
    };
    map.on("move", syncCenter);
    syncCenter();

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Render spot markers.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = props.spots.flatMap((s) => {
      // The draggable draft replaces its saved pin while editing.
      if (props.draft && s.id === props.selectedId) return [];
      // Area spots use their saved map pin, falling back to the fence centroid.
      const anchor = triggerAnchor(s.trigger);
      if (!anchor) return [];
      const el = document.createElement("div");
      el.className = "spot-map-marker";
      el.dataset.spotId = s.id;
      el.classList.toggle("is-selected", s.id === props.selectedId);
      el.title = s.title;
      el.onmouseenter = () => cbRef.current.onHover(s.id);
      el.onmouseleave = () => cbRef.current.onHover(null);
      el.onclick = (ev) => {
        ev.stopPropagation();
        cbRef.current.onSelect(s.id);
      };
      return [
        new maplibregl.Marker({ element: el })
          .setLngLat([anchor.lng, anchor.lat])
          .addTo(map),
      ];
    });
  }, [props.spots, props.selectedId, !!props.draft]);

  // Update existing elements: rebuilding markers on hover loses pointer state.
  useEffect(() => {
    for (const marker of markersRef.current) {
      const el = marker.getElement();
      el.classList.toggle("is-highlighted", el.dataset.spotId === props.hoveredId);
    }
  }, [props.hoveredId, props.spots, props.selectedId, !!props.draft]);

  // Render the draft's activation geometry (radius circle and/or polygon).
  useEffect(() => {
    const map = mapRef.current;
    if (map?.getSource("draft")) renderDraft(map, props.draft);
  }, [props.draft]);

  // Draw / clear the drive-simulator route line. Gated on the source, not on
  // `isStyleLoaded()`, which is false while any tile loads and left the line
  // undrawn when the route arrived mid-load.
  useEffect(() => {
    const map = mapRef.current;
    if (map?.getSource("route")) renderRoute(map, props.routePath ?? null);
  }, [props.routePath]);

  // Move the simulated traveler icon; heading rotates the arrow.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const t = props.traveler;
    if (!t) {
      travelerRef.current?.remove();
      travelerRef.current = null;
      return;
    }
    if (!travelerRef.current) {
      const el = document.createElement("div");
      el.className = "traveler-marker";
      el.innerHTML = TRAVELER_SVG;
      travelerRef.current = new maplibregl.Marker({ element: el, anchor: "center" })
        .setLngLat([t.pos.lng, t.pos.lat])
        .addTo(map);
    } else {
      travelerRef.current.setLngLat([t.pos.lng, t.pos.lat]);
    }
    const inner = travelerRef.current.getElement().firstElementChild as HTMLElement | null;
    if (inner) inner.style.transform = `rotate(${t.headingDeg}deg)`;
  }, [props.traveler?.pos.lat, props.traveler?.pos.lng, props.traveler?.headingDeg]);

  // Draggable pin for the draft's trigger center. The radius circle follows
  // live during the drag; the new position is committed on drag end.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!props.draft) {
      draftMarkerRef.current?.remove();
      draftMarkerRef.current = null;
      return;
    }
    const { lng, lat } = props.draft.center;
    if (!draftMarkerRef.current) {
      const el = document.createElement("div");
      el.className = "crosshair-marker";
      el.style.zIndex = "1";
      el.title = "Drag to move this spot’s pin, then Save spot";
      el.innerHTML = CROSSHAIR_SVG;
      const m = new maplibregl.Marker({ element: el, draggable: true, anchor: "center" })
        .setLngLat([lng, lat])
        .addTo(map);
      m.on("drag", () => {
        const p = m.getLngLat();
        const d = cbRef.current.draft;
        if (d) renderDraft(map, { ...d, center: { lat: p.lat, lng: p.lng } });
      });
      m.on("dragend", () => {
        const p = m.getLngLat();
        cbRef.current.onDraftMove({ lat: p.lat, lng: p.lng });
      });
      draftMarkerRef.current = m;
    } else {
      draftMarkerRef.current.setLngLat([lng, lat]);
    }
  }, [props.draft?.center.lng, props.draft?.center.lat, !!props.draft]);

  // Center on the selected/draft spot — spots can be anywhere on Earth.
  // Deliberately no animation (jumpTo, never flyTo): loading /track/spot
  // lands on the right place immediately. Opening a spot always centers it;
  // small center edits to the already-open spot (pin drag, coordinate nudge)
  // don't re-center unless they moved far.
  const centeredForRef = useRef<string | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !props.draft) {
      centeredForRef.current = null;
      return;
    }
    const { lng, lat } = props.draft.center;
    const cur = map.getCenter();
    const far = Math.abs(cur.lng - lng) > 0.02 || Math.abs(cur.lat - lat) > 0.02;
    const newSelection = props.selectedId !== null && centeredForRef.current !== props.selectedId;
    if (newSelection || far) {
      map.jumpTo({ center: [lng, lat], zoom: Math.max(map.getZoom(), 13) });
    }
    centeredForRef.current = props.selectedId;
  }, [props.selectedId, props.draft?.center.lng, props.draft?.center.lat]);

  // Frame the track's spots when entering a track (no spot open). Uses
  // fitBounds so the centroid is centered and the zoom fits them all; a
  // single spot just centers at a sensible zoom. Instant (no animation).
  const framedForRef = useRef<string | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    const key = props.frameKey ?? null;
    // Don't fight the spot editor; wait until we're at the track level.
    if (!map || !key || props.draft) return;
    if (framedForRef.current === key) return; // already framed this track
    // Spots may not have loaded yet on first entry; wait for them rather than
    // claiming the track as framed (which would skip framing once they arrive).
    if (props.spots.length === 0) return;
    // Camera moves don't need the style; call directly. (Gating on the "load"
    // event is unsafe for a persisted map — it already fired and won't again.)
    const anchors = props.spots
      .map((s) => triggerAnchor(s.trigger))
      .filter((a): a is NonNullable<typeof a> => a !== null);
    if (anchors.length === 0) return;
    if (anchors.length === 1) {
      const c = anchors[0]!;
      map.jumpTo({ center: [c.lng, c.lat], zoom: Math.max(map.getZoom(), 14) });
    } else {
      const bounds = new maplibregl.LngLatBounds();
      for (const a of anchors) bounds.extend([a.lng, a.lat]);
      map.fitBounds(bounds, { padding: 64, maxZoom: 16, animate: false });
    }
    framedForRef.current = key;
  }, [props.frameKey, props.spots, props.draft]);

  // When a drive route appears, frame the whole route once.
  const framedRouteRef = useRef(false);
  useEffect(() => {
    const map = mapRef.current;
    const path = props.routePath;
    if (!map || !path || path.length < 2) {
      framedRouteRef.current = false;
      return;
    }
    if (framedRouteRef.current) return;
    const bounds = new maplibregl.LngLatBounds();
    for (const p of path) bounds.extend([p.lng, p.lat]);
    map.fitBounds(bounds, { padding: 72, maxZoom: 16, animate: false });
    framedRouteRef.current = true;
  }, [props.routePath]);

  const locate = () => {
    navigator.geolocation?.getCurrentPosition(
      (pos) => {
        mapRef.current?.jumpTo({
          center: [pos.coords.longitude, pos.coords.latitude],
          zoom: Math.max(mapRef.current.getZoom(), 14),
        });
      },
      (err) => console.warn("geolocation unavailable:", err.message),
      { enableHighAccuracy: true, timeout: 8000 },
    );
  };

  return (
    <div className="map-wrap">
      <div id="map" ref={ref} />
      <button className="locate-btn" title="Go to my location" onClick={locate}>
        ⌖
      </button>
    </div>
  );
}

function empty(): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

function activationFeatures(trigger: GeoTrigger): GeoJSON.Feature<GeoJSON.Polygon>[] {
  if (trigger.kind === "anywhere") return [];
  const features: GeoJSON.Feature<GeoJSON.Polygon>[] = [];
  if (trigger.kind !== "area" && trigger.center) {
    features.push({
      type: "Feature",
      properties: {},
      geometry: { type: "Polygon", coordinates: [circle(trigger.center, trigger.radiusM)] },
    });
  }
  if (trigger.region && trigger.region.length >= 3) {
    const ring = trigger.region.map((p) => [p.lng, p.lat]);
    ring.push(ring[0]!);
    features.push({
      type: "Feature",
      properties: { region: true },
      geometry: { type: "Polygon", coordinates: [ring] },
    });
  }
  return features;
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

function renderDraft(
  map: maplibregl.Map,
  draft: Props["draft"],
): void {
  const src = map.getSource("draft") as maplibregl.GeoJSONSource | undefined;
  if (!src) return;
  if (!draft) {
    src.setData(empty());
    return;
  }

  src.setData({ type: "FeatureCollection", features: activationFeatures(draft) });
}
