/**
 * Watch a walkthrough in the iOS Simulator: streams a simulated journey into
 * the booted simulator via `simctl location start`, so the real app — real
 * CoreLocation pipeline, real /nearby polling, real scheduler and locator —
 * plays the tour while you watch.
 *
 *   bun scripts/walkthrough.ts                                  # list slates
 *   bun scripts/walkthrough.ts --slate server/scripts/data/fairfax-town-deep.spots.json
 *   bun scripts/walkthrough.ts --slate <file> --speed 13.4      # drive it
 *   bun scripts/walkthrough.ts --slate <file> --reverse         # walk it backwards
 *   bun scripts/walkthrough.ts --slate <file> --offset-m 12     # walk 12m right of
 *                                                               # the spots (hear
 *                                                               # "on your left")
 *   bun scripts/walkthrough.ts --waypoints "37.98,-122.59 37.99,-122.58"
 *   bun scripts/walkthrough.ts clear                            # stop the journey
 *
 * A slate is a spot slate JSON (server/scripts/data/*.spots.json); its spots
 * are threaded in file order, which is the authored route order. `--offset-m`
 * shifts the whole path perpendicular to the direction of travel (positive =
 * right), turning a through-the-centers path into a walk *past* the spots —
 * the way to eyeball left/right announcements in the live app.
 *
 * The simulator keeps playing the route after this script exits; use `clear`
 * to stop it. Launch the app (and start the server) first, or you'll walk in
 * silence.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface Point {
  lat: number;
  lng: number;
}

const DATA_DIR = join(import.meta.dir, "..", "server", "scripts", "data");

function usageAndSlates(): never {
  console.log("Usage: bun scripts/walkthrough.ts [--slate <file> | --waypoints \"lat,lng ...\"]");
  console.log("       [--speed m/s] [--interval s] [--offset-m m] [--reverse] [--udid id]");
  console.log("       bun scripts/walkthrough.ts clear\n");
  let slates: string[] = [];
  try {
    slates = readdirSync(DATA_DIR).filter((f) => f.endsWith(".spots.json"));
  } catch {
    // no data dir; nothing to list
  }
  if (slates.length) {
    console.log("Available slates:");
    for (const s of slates) console.log(`  server/scripts/data/${s}`);
  }
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const opts = {
    slate: null as string | null,
    waypoints: null as string | null,
    speed: 1.4,
    interval: 1,
    offsetM: 0,
    reverse: false,
    udid: "booted",
    clear: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v == null) usageAndSlates();
      return v;
    };
    if (a === "clear") opts.clear = true;
    else if (a === "--slate") opts.slate = next();
    else if (a === "--waypoints") opts.waypoints = next();
    else if (a === "--speed") opts.speed = Number(next());
    else if (a === "--interval") opts.interval = Number(next());
    else if (a === "--offset-m") opts.offsetM = Number(next());
    else if (a === "--reverse") opts.reverse = true;
    else if (a === "--udid") opts.udid = next();
    else usageAndSlates();
  }
  if (!opts.clear && !opts.slate && !opts.waypoints) usageAndSlates();
  if (!Number.isFinite(opts.speed) || opts.speed <= 0) usageAndSlates();
  return opts;
}

function slateWaypoints(path: string): { points: Point[]; titles: string[] } {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const spots =
    Array.isArray(raw) ? raw : (raw as { spots?: unknown[] }).spots;
  if (!Array.isArray(spots) || spots.length < 2) {
    console.error(`${path}: expected a slate with at least 2 spots`);
    process.exit(1);
  }
  const points: Point[] = [];
  const titles: string[] = [];
  for (const s of spots as Array<{
    title?: string;
    trigger?: { center?: { lat?: number; lng?: number } };
  }>) {
    const c = s.trigger?.center;
    if (typeof c?.lat !== "number" || typeof c?.lng !== "number") {
      console.error(`${path}: spot "${s.title ?? "?"}" has no trigger.center`);
      process.exit(1);
    }
    points.push({ lat: c.lat, lng: c.lng });
    titles.push(s.title ?? "?");
  }
  return { points, titles };
}

function parseWaypoints(arg: string): Point[] {
  const points = arg
    .trim()
    .split(/\s+/)
    .map((pair) => {
      const [lat, lng] = pair.split(",").map(Number);
      if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) {
        console.error(`Bad waypoint "${pair}" — expected lat,lng`);
        process.exit(1);
      }
      return { lat, lng };
    });
  if (points.length < 2) {
    console.error("Need at least 2 waypoints.");
    process.exit(1);
  }
  return points;
}

const R_EARTH = 6_371_000;
const rad = Math.PI / 180;

function distM(a: Point, b: Point): number {
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(s));
}

/**
 * Shift each vertex `offsetM` perpendicular to the local direction of travel
 * (positive = traveler's right). Uses the average heading of the segments
 * meeting at the vertex, so corners offset sensibly.
 */
function offsetPath(points: Point[], offsetM: number): Point[] {
  if (offsetM === 0) return points;
  const headings = points.slice(0, -1).map((p, i) => {
    const q = points[i + 1]!;
    return Math.atan2(
      (q.lng - p.lng) * Math.cos(p.lat * rad),
      q.lat - p.lat,
    );
  });
  return points.map((p, i) => {
    const before = headings[i - 1];
    const after = headings[i < headings.length ? i : headings.length - 1];
    let h: number;
    if (before == null) h = after!;
    else if (i >= headings.length) h = before;
    else h = Math.atan2(Math.sin(before) + Math.sin(after!), Math.cos(before) + Math.cos(after!));
    const normal = h + Math.PI / 2; // traveler's right
    return {
      lat: p.lat + (offsetM * Math.cos(normal)) / 111_320,
      lng: p.lng + (offsetM * Math.sin(normal)) / (111_320 * Math.cos(p.lat * rad)),
    };
  });
}

async function simctl(args: string[]): Promise<void> {
  const proc = Bun.spawn(["xcrun", "simctl", ...args], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) {
    console.error(`\nxcrun simctl exited ${code} — is a simulator booted? (xcrun simctl list devices booted)`);
    process.exit(code);
  }
}

const opts = parseArgs(process.argv.slice(2));

if (opts.clear) {
  await simctl(["location", opts.udid, "clear"]);
  console.log("Simulated journey cleared.");
  process.exit(0);
}

let points: Point[];
let titles: string[] = [];
if (opts.slate) {
  ({ points, titles } = slateWaypoints(opts.slate));
} else {
  points = parseWaypoints(opts.waypoints!);
}
if (opts.reverse) {
  points = [...points].reverse();
  titles = [...titles].reverse();
}
points = offsetPath(points, opts.offsetM);

const totalM = points.slice(0, -1).reduce((acc, p, i) => acc + distM(p, points[i + 1]!), 0);
const totalS = totalM / opts.speed;
const mins = Math.floor(totalS / 60);

console.log(
  `Journey: ${points.length} waypoints, ${(totalM / 1000).toFixed(1)} km at ` +
    `${opts.speed} m/s ≈ ${mins}m${Math.round(totalS % 60)}s` +
    (opts.offsetM ? `, offset ${opts.offsetM}m ${opts.offsetM > 0 ? "right" : "left"} of the spots` : ""),
);
if (titles.length) {
  console.log(`Route: ${titles[0]} → … → ${titles[titles.length - 1]}`);
}

await simctl([
  "location",
  opts.udid,
  "start",
  `--speed=${opts.speed}`,
  `--interval=${opts.interval}`,
  ...points.map((p) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`),
]);

console.log(
  "\nStreaming. The simulator follows the route on its own — launch the app to watch.\n" +
    "Stop early with: bun scripts/walkthrough.ts clear",
);
