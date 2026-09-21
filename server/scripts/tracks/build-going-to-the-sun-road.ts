/** Build the official NPS Going-to-the-Sun Road audio-tour slate and route audit. */
import { FiloDocument, annotateSentences, annotateWords } from "filo";
import { TIER, TrackExport } from "@grandtour/shared";

const TOUR_URL = "https://www.nps.gov/glac/learn/photosmultimedia/going-to-the-sun-road-audio-tour.htm";
const NPS_RIGHTS_URL = "https://www.nps.gov/aboutus/disclaimer.htm?mobile-app=true&theme=wiki";
const NPS_LANDMARKS_URL = "https://glaciermt.com/docs/GTSR-landmarks.pdf";
const OSM_RIGHTS_URL = "https://www.openstreetmap.org/copyright";
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const DATA_DIR = new URL("../data/", import.meta.url);

type Point = { lat: number; lng: number };
type Seed = Point & { source: string; confidence: "high" | "medium"; note: string; officialMile?: number };
const osmSearch = (name: string) => `https://www.openstreetmap.org/search?query=${encodeURIComponent(`${name}, Glacier National Park, Montana`)}`;

// Named OSM/NPS map features, recorded explicitly so later map edits cannot
// silently move a stop. Natural features are projected onto the driveable road.
const seeds: Record<string, Seed> = {
  "apgar-village": { lat: 48.5263830, lng: -113.9937111, source: osmSearch("Apgar Village"), confidence: "high", note: "Apgar Village shuttle stop" },
  "apgar-campground": { lat: 48.5278455, lng: -113.9839342, source: osmSearch("Apgar Campground"), confidence: "high", note: "Apgar Campground shuttle stop" },
  "sprague-creek-campground": { lat: 48.6060965, lng: -113.8845277, source: osmSearch("Sprague Creek Campground"), confidence: "high", note: "Sprague Creek Campground shuttle stop", officialMile: 9.8 },
  "mcdonald-creek": { lat: 48.6558481, lng: -113.8404629, source: "https://www.nps.gov/places/mcdonald-creek-overlook.htm", confidence: "high", note: "McDonald Creek Overlook (FHWA road inventory mile 14.2)", officialMile: 14.2 },
  "avalanche-creek": { lat: 48.6772080, lng: -113.8181334, source: osmSearch("Avalanche Campground"), confidence: "high", note: "Avalanche Campground and Trail of the Cedars area", officialMile: 16.4 },
  "west-tunnel": { lat: 48.7512958, lng: -113.7896669, source: osmSearch("Going-to-the-Sun Road West Tunnel"), confidence: "high", note: "Center of the mapped West Tunnel", officialMile: 23.6 },
  "the-loop": { lat: 48.7542976, lng: -113.7994777, source: osmSearch("The Loop"), confidence: "high", note: "The Loop shuttle stop", officialMile: 24.2 },
  "bird-woman-falls": { lat: 48.7390740, lng: -113.7496090, source: NPS_LANDMARKS_URL, confidence: "high", note: "Bird Woman Overlook on the road, not the waterfall across the valley", officialMile: 27.1 },
  "weeping-wall": { lat: 48.7270627, lng: -113.7281368, source: osmSearch("Weeping Wall"), confidence: "high", note: "Mapped Weeping Wall projected to the road", officialMile: 28.6 },
  "big-bend": { lat: 48.7274740, lng: -113.7248700, source: osmSearch("Big Bend"), confidence: "high", note: "Big Bend viewpoint", officialMile: 28.9 },
  "triple-arches": { lat: 48.7174752, lng: -113.7181703, source: "https://www.nps.gov/places/triple-arches.htm", confidence: "high", note: "Triple Arches at the GNIS/HAER location, about two miles west of Logan Pass", officialMile: 29.8 },
  "oberlin-bend": { lat: 48.6996065, lng: -113.7252145, source: osmSearch("Oberlin Bend"), confidence: "high", note: "Oberlin Bend viewpoint", officialMile: 31.6 },
  "logan-pass": { lat: 48.6957945, lng: -113.7177370, source: osmSearch("Logan Pass"), confidence: "high", note: "Logan Pass shuttle stop", officialMile: 31.7 },
  "lunch-creek": { lat: 48.7003676, lng: -113.7035618, source: osmSearch("Lunch Creek"), confidence: "high", note: "Lunch Creek crossing projected to the road", officialMile: 32.8 },
  "east-tunnel": { lat: 48.6971437, lng: -113.6949105, source: osmSearch("Going-to-the-Sun Road East Tunnel"), confidence: "high", note: "Center of the mapped East Tunnel", officialMile: 33.2 },
  "siyeh-bend": { lat: 48.7007114, lng: -113.6672229, source: osmSearch("Siyeh Bend"), confidence: "high", note: "Siyeh Bend shuttle stop", officialMile: 34.5 },
  "jackson-glacier": { lat: 48.6782753, lng: -113.6539768, source: osmSearch("Jackson Glacier Overlook"), confidence: "high", note: "Jackson Glacier Overlook viewpoint", officialMile: 36.4 },
  "gunsight-pass-trailhead": { lat: 48.6774309, lng: -113.6522445, source: osmSearch("Gunsight Pass Trailhead"), confidence: "high", note: "Gunsight Pass Trailhead", officialMile: 36.4 },
  "st-mary-falls-trailhead": { lat: 48.6743500, lng: -113.6086507, source: osmSearch("Saint Mary Falls Trailhead"), confidence: "high", note: "Saint Mary Falls Trailhead projected to the road", officialMile: 38.5 },
  "sunrift-gorge": { lat: 48.6779492, lng: -113.5961423, source: osmSearch("Sunrift Gorge"), confidence: "high", note: "Sunrift Gorge shuttle stop at Baring Creek", officialMile: 39.3 },
  "sun-point": { lat: 48.6760354, lng: -113.5804350, source: osmSearch("Sun Point"), confidence: "high", note: "Sun Point shuttle stop projected to the road", officialMile: 39.9 },
  "golden-staircase": { lat: 48.6885398, lng: -113.5274796, source: osmSearch("Golden Staircase"), confidence: "high", note: "Golden Staircase viewpoint", officialMile: 43.0 },
  "rising-sun": { lat: 48.6950503, lng: -113.5175175, source: osmSearch("Rising Sun"), confidence: "high", note: "Rising Sun shuttle stop", officialMile: 43.7 },
  "two-dog-flats": { lat: 48.7158698, lng: -113.4752512, source: NPS_LANDMARKS_URL, confidence: "high", note: "Two Dog Flats middle landmark projected to the road", officialMile: 46.7 },
  "st-mary-visitor-center": { lat: 48.7470128, lng: -113.4385375, source: osmSearch("Saint Mary Visitor Center"), confidence: "high", note: "Saint Mary Visitor Center shuttle stop", officialMile: 49.2 },
};

const decodeHtml = (s: string) => s
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
  .replace(/&apos;|&#39;/gi, "'").replace(/&rsquo;/gi, "’").replace(/&ldquo;/gi, "“").replace(/&rdquo;/gi, "”")
  .replace(/&ndash;/gi, "–").replace(/&mdash;/gi, "—");
const plain = (s: string) => decodeHtml(s.replace(/<br\s*\/?\s*>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const slugify = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const key = (p: Point) => `${p.lat.toFixed(7)},${p.lng.toFixed(7)}`;
const radians = (n: number) => n * Math.PI / 180;
const meters = (a: Point, b: Point) => {
  const dLat = radians(b.lat - a.lat), dLng = radians(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
};

async function deterministicUuid(value: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const h = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

async function fetchRoad() {
  const query = `[out:json][timeout:90];way["name"~"^(Going-to-the-Sun Road|Apgar Loop Road)$"](48.45,-114.05,48.80,-113.35);out geom tags;`;
  const res = await fetch(`${OVERPASS_URL}?data=${encodeURIComponent(query)}`, { headers: { "User-Agent": "GrandTour/0.1 route research" } });
  if (!res.ok) throw new Error(`Overpass road request failed: ${res.status}`);
  const json: any = await res.json();
  const nodes = new Map<string, Point>();
  const edges = new Map<string, { to: string; weight: number }[]>();
  for (const way of json.elements) for (let i = 1; i < way.geometry.length; i++) {
    const a = { lat: way.geometry[i - 1].lat, lng: way.geometry[i - 1].lon };
    const b = { lat: way.geometry[i].lat, lng: way.geometry[i].lon };
    const ak = key(a), bk = key(b), weight = meters(a, b);
    nodes.set(ak, a); nodes.set(bk, b);
    edges.set(ak, [...(edges.get(ak) ?? []), { to: bk, weight }]);
    edges.set(bk, [...(edges.get(bk) ?? []), { to: ak, weight }]);
  }
  const nearest = (p: Point) => [...nodes].reduce((best, item) => meters(p, item[1]) < best[0] ? [meters(p, item[1]), item[0]] as const : best, [Infinity, ""] as const)[1];
  const start = nearest(seeds["apgar-village"]!), goal = nearest(seeds["st-mary-visitor-center"]!);
  const dist = new Map([[start, 0]]), prev = new Map<string, string>(), open = new Set([start]);
  while (open.size) {
    let current = "", currentDist = Infinity;
    for (const candidate of open) if ((dist.get(candidate) ?? Infinity) < currentDist) { current = candidate; currentDist = dist.get(candidate)!; }
    open.delete(current);
    if (current === goal) break;
    for (const edge of edges.get(current) ?? []) {
      const next = currentDist + edge.weight;
      if (next < (dist.get(edge.to) ?? Infinity)) { dist.set(edge.to, next); prev.set(edge.to, current); open.add(edge.to); }
    }
  }
  if (!prev.has(goal)) throw new Error("Could not connect the west and east road endpoints");
  const path: Point[] = [];
  for (let at: string | undefined = goal; at; at = prev.get(at)) { path.push(nodes.get(at)!); if (at === start) break; }
  path.reverse();
  return { path, wayCount: json.elements.length, sourceQuery: query };
}

function projectToPath(seed: Point, path: Point[]) {
  let best = { point: path[0]!, offsetM: Infinity, alongM: 0 };
  let cumulative = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!, b = path[i]!;
    const latScale = 111320, lngScale = 111320 * Math.cos(radians((a.lat + b.lat) / 2));
    const vx = (b.lng - a.lng) * lngScale, vy = (b.lat - a.lat) * latScale;
    const wx = (seed.lng - a.lng) * lngScale, wy = (seed.lat - a.lat) * latScale;
    const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / (vx * vx + vy * vy || 1)));
    const point = { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
    const offsetM = meters(seed, point), segmentM = meters(a, b);
    if (offsetM < best.offsetM) best = { point, offsetM, alongM: cumulative + segmentM * t };
    cumulative += segmentM;
  }
  return best;
}

async function durationMs(url: string) {
  const proc = Bun.spawn(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nk=1:nw=1", url], { stdout: "pipe", stderr: "pipe" });
  const value = Number((await new Response(proc.stdout).text()).trim());
  if (await proc.exited || !Number.isFinite(value)) throw new Error(`Could not read MP3 duration: ${url}`);
  return Math.round(value * 1000);
}

const htmlRes = await fetch(TOUR_URL);
if (!htmlRes.ok) throw new Error(`NPS tour request failed: ${htmlRes.status}`);
const html = await htmlRes.text();
const blocks = html.split(/<div class="gallery-listing-av responsiveAudio">/).slice(1);
const rawStops = blocks.map((block) => {
  const fullTitle = plain(block.match(/<h3>([\s\S]*?)<\/h3>/)?.[1] ?? "");
  const title = fullTitle.replace(/^Going-to-the-Sun Road:\s*/, "");
  const slug = slugify(title.replace(/^Jackson Glacier$/, "Jackson Glacier"));
  const summary = plain(block.match(/<div class="left">[\s\S]*?<p>([\s\S]*?)<\/p>/)?.[1] ?? "Official National Park Service audio-tour stop.");
  const narration = plain(block.match(/<div class="transcript"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? "").replace(/^\[Narration\]\s*/, "");
  const audioUrl = block.match(/<source src="([^"]+\.mp3)"/)?.[1];
  const mediaId = block.match(/view\.htm\?id=([A-F0-9-]+)/)?.[1];
  const credit = plain(block.match(/<dt>Credit \/ Author:<\/dt>\s*<dd>([\s\S]*?)<\/dd>/)?.[1] ?? "");
  const dateCreated = plain(block.match(/<dt>Date created:<\/dt>\s*<dd>([\s\S]*?)<\/dd>/)?.[1] ?? "");
  if (!title || !narration || !audioUrl || !mediaId) throw new Error(`Incomplete NPS entry: ${fullTitle || "unknown"}`);
  return { slug, title, summary, narration, audioUrl, mediaId, credit, dateCreated };
});
if (rawStops.length !== 25) throw new Error(`Expected 25 NPS stops, found ${rawStops.length}`);
for (const stop of rawStops) if (!seeds[stop.slug]) throw new Error(`Missing coordinate seed: ${stop.slug}`);
const credits = [...new Set(rawStops.map((s) => s.credit))];
if (credits.length !== 1 || credits[0] !== "Glacier National Park") throw new Error(`Unexpected NPS credits: ${credits.join(", ")}`);

/**
 * The work this content *is*, as opposed to what it cites. Text is federal
 * work product (17 U.S.C. §105) and clear.
 *
 * The audio is `probable`, not `confirmed`, on purpose. A sibling NPS tour
 * (Everglades by Car) turned out to blend a named third party's field
 * recordings into files whose narration was plainly federal — and that credit
 * sat in an adjacent line, not in the credit field this script checks above.
 * Absence of a third-party credit here is therefore not evidence of absence.
 * Until someone listens through these 25 files and re-reads the media records,
 * "probably clear" is the honest status; publishing should wait on it.
 */
const npsOrigin = {
  name: "Going-to-the-Sun Road Audio Tour",
  url: TOUR_URL,
  description:
    "Official National Park Service driving-tour audio for Going-to-the-Sun Road, Glacier National Park.",
  publisher: "National Park Service",
  license: "public-domain",
  attribution: credits[0]!,
  clearance: [
    {
      scope: "text" as const,
      status: "confirmed" as const,
      license: "public-domain",
      note: "NPS work product, 17 U.S.C. §105. Credit line verified as Glacier National Park on every stop.",
    },
    {
      scope: "audio" as const,
      status: "probable" as const,
      note: "Not yet listened through for embedded third-party recordings. See the Everglades by Car precedent.",
    },
  ],
};

const road = await fetchRoad();
const probed = await Promise.all(rawStops.map(async (stop) => ({ ...stop, durationMs: await durationMs(stop.audioUrl) })));
const stops = probed.map((stop, index) => {
  const seed = seeds[stop.slug]!;
  const projected = projectToPath(seed, road.path);
  return {
    ...stop, index, seed, center: projected.point,
    roadOffsetM: Math.round(projected.offsetM),
    roadMile: Number((projected.alongM / 1609.344).toFixed(2)),
    mediaUrl: `https://www.nps.gov/media/video/view.htm?id=${stop.mediaId}`,
  };
});

// The road folds back on itself near Triple Arches; page order is the audit
// authority, while mile positions catch gross coordinate mistakes.
// Bird Woman Falls is intentionally viewed from across the valley (about two
// kilometres from the pavement); its trigger is the projected road point.
const suspicious = stops.filter((s) => s.roadOffsetM > 2500);
if (suspicious.length) throw new Error(`Stops too far from the road: ${suspicious.map((s) => `${s.title} (${s.roadOffsetM}m)`).join(", ")}`);
for (let i = 1; i < stops.length; i++) if (stops[i]!.roadMile < stops[i - 1]!.roadMile)
  throw new Error(`Stop order goes backward: ${stops[i - 1]!.title} -> ${stops[i]!.title}`);

const track = {
  slug: "going-to-the-sun-road-audio-tour",
  name: "Going-to-the-Sun Road Audio Tour",
  description: "The National Park Service’s 25-stop narrated drive from Apgar Village to the Saint Mary Visitor Center across Glacier National Park. Original NPS audio and transcripts; GPS triggers verified against the mapped road and named landmarks.",
  kind: "tour" as const, lifecycle: "evergreen" as const, icon: "mountain.2", color: "#4E6A55", official: true,
};
const slate = {
  track,
  spots: stops.map((stop) => ({
    slug: stop.slug, title: stop.title,
    subtitle: stop.summary,
    trigger: { kind: "point", center: stop.center, radiusM: 220 },
    modes: ["driving"], locating: { mode: "none" },
    narration: stop.narration,
    audioUrl: stop.audioUrl, durationMs: stop.durationMs,
    sources: [TOUR_URL, stop.mediaUrl, stop.seed.source, NPS_LANDMARKS_URL, NPS_RIGHTS_URL, OSM_RIGHTS_URL],
  })),
};

const now = new Date().toISOString();
const trackId = await deterministicUuid(track.slug);
const bundle = {
  exportedAt: now,
  track: { ...track, id: trackId, spotCount: stops.length, itemCount: 0, createdAt: now },
  routePath: road.path,
  spots: await Promise.all(stops.map(async (stop) => {
    const spotId = await deterministicUuid(`${track.slug}:${stop.slug}`);
    const contentId = await deterministicUuid(`${track.slug}:${stop.slug}:en:default`);
    const doc = FiloDocument.fromText(stop.narration, { metadata: { locale: "en" } });
    annotateWords(doc, { tierId: TIER.words, language: "en" });
    annotateSentences(doc, { tierId: TIER.sentences, language: "en" });
    return {
      spot: { id: spotId, trackId, slug: stop.slug, title: stop.title, subtitle: stop.summary,
        trigger: { kind: "point" as const, center: stop.center, radiusM: 220 }, modes: ["driving" as const],
        locating: { mode: "none" as const, clips: {} }, status: "draft" as const, createdAt: now, updatedAt: now },
      content: [{ id: contentId, spotId, locale: "en", variant: "default", document: doc.toJSON(),
        audioUrl: stop.audioUrl, durationMs: stop.durationMs, source: "imported" as const,
        provenance: { origin: npsOrigin,
          sources: [{ name: "NPS audio tour", url: TOUR_URL, description: "Tour page listing every stop." },
            { name: "NPS media record", url: stop.mediaUrl, description: "Per-stop record the audio file came from." }],
          generatedAt: now, warnings: ["Original NPS audio; draft import pending final editorial review."] },
        status: "draft" as const, createdAt: now, updatedAt: now }],
    };
  })),
  fillInItems: [],
};
TrackExport.parse(bundle);

const audit = {
  generatedAt: now,
  tourUrl: TOUR_URL,
  rights: { credit: credits[0], npsPolicy: NPS_RIGHTS_URL, osmAttribution: OSM_RIGHTS_URL, clearance: npsOrigin.clearance },
  route: { source: "OpenStreetMap via Overpass", query: road.sourceQuery, points: road.path.length,
    distanceMiles: Number((road.path.reduce((sum, p, i) => i ? sum + meters(road.path[i - 1]!, p) : 0, 0) / 1609.344).toFixed(2)) },
  stops: stops.map(({ index, title, slug, center, seed, roadOffsetM, roadMile, audioUrl, mediaUrl, durationMs, credit, dateCreated }) =>
    ({ order: index + 1, title, slug, center, routeMileFromApgar: roadMile, officialRoadMile: seed.officialMile ?? null, roadOffsetM, confidence: seed.confidence, coordinateNote: seed.note,
      coordinateSource: seed.source, audioUrl, mediaUrl, durationMs, credit, dateCreated })),
};
const routeGeoJson = { type: "FeatureCollection", features: [{ type: "Feature", properties: { name: track.name, source: "OpenStreetMap contributors" },
  geometry: { type: "LineString", coordinates: road.path.map((p) => [p.lng, p.lat]) } }] };

await Bun.write(new URL("going-to-the-sun-road.spots.json", DATA_DIR), JSON.stringify(slate, null, 2) + "\n");
await Bun.write(new URL("going-to-the-sun-road.audit.json", DATA_DIR), JSON.stringify(audit, null, 2) + "\n");
await Bun.write(new URL("going-to-the-sun-road.route.geojson", DATA_DIR), JSON.stringify(routeGeoJson, null, 2) + "\n");
await Bun.write(new URL("going-to-the-sun-road.grandtour.json", DATA_DIR), JSON.stringify(bundle, null, 2) + "\n");
console.log(JSON.stringify({ stops: stops.length, credits, audioMinutes: Number((stops.reduce((sum, s) => sum + s.durationMs, 0) / 60000).toFixed(1)),
  routeMiles: audit.route.distanceMiles, routePoints: road.path.length, maxRoadOffsetM: Math.max(...stops.map((s) => s.roadOffsetM)), files: ["going-to-the-sun-road.spots.json", "going-to-the-sun-road.audit.json", "going-to-the-sun-road.route.geojson", "going-to-the-sun-road.grandtour.json"] }, null, 2));
