/**
 * Replay a tour diagnostics session and explain missed triggers.
 *
 *   bun run diag            # newest session
 *   bun run diag <file>     # a specific tour-YYYY-MM-DD.jsonl
 *
 * Reads the JSONL written by POST /api/diag/logs and answers the question the
 * walk raised: for each place the traveler passed, did GPS see it, did the
 * server call it triggered, and if so why didn't it play?
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

type Event = Record<string, unknown> & { event: string; ts: string; session: string };

const DIAG_DIR = join(process.cwd(), "diag");

async function newestFile(): Promise<string> {
  const files = (await readdir(DIAG_DIR)).filter((f) => f.endsWith(".jsonl")).sort();
  if (!files.length) throw new Error(`No diagnostics in ${DIAG_DIR}. Walk with the tour on first.`);
  return join(DIAG_DIR, files[files.length - 1]!);
}

function num(e: Event, k: string): number | undefined {
  const v = e[k];
  return typeof v === "number" ? v : undefined;
}

const file = process.argv[2] ?? (await newestFile());
const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
const events: Event[] = lines.flatMap((l) => {
  try { return [JSON.parse(l) as Event]; } catch { return []; }
});

if (!events.length) {
  console.log("No parsable events.");
  process.exit(0);
}

// Analyze the most recent session only — earlier walks are separate stories.
const session = events[events.length - 1]!.session;
const ev = events.filter((e) => e.session === session);

console.log(`\n═══ Tour session ${session} — ${file}`);
console.log(`    ${ev.length} events, ${ev[0]!.ts} → ${ev[ev.length - 1]!.ts}\n`);

// ─── Signal quality ─────────────────────────────────────────────────────────
const fixes = ev.filter((e) => e.event === "gps_fix");
const accs = fixes.map((e) => num(e, "hAcc") ?? -1).filter((a) => a > 0);
if (accs.length) {
  accs.sort((a, b) => a - b);
  const med = accs[Math.floor(accs.length / 2)]!;
  const worst = accs[accs.length - 1]!;
  console.log("GPS");
  console.log(`  fixes: ${fixes.length}   accuracy median ${med.toFixed(0)}m, worst ${worst.toFixed(0)}m`);
  const bad = accs.filter((a) => a > 30).length;
  if (bad) {
    console.log(`  ⚠️  ${bad}/${accs.length} fixes worse than 30m — with 35m radii these can miss.`);
  }
  const stale = fixes.filter((e) => (num(e, "fixAgeS") ?? 0) > 30).length;
  if (stale) console.log(`  ⚠️  ${stale} fixes were >30s stale when used.`);
} else {
  console.log("GPS\n  ⚠️  NO FIXES AT ALL — location never reached the app.");
}

// ─── Fetch health ───────────────────────────────────────────────────────────
const ok = ev.filter((e) => e.event === "fetch_ok");
const failed = ev.filter((e) => e.event === "fetch_failed");
const skipped = ev.filter((e) => e.event === "fetch_skipped");
const unchanged = ev.filter((e) => e.event === "fetch_unchanged");
console.log("\nFETCHES");
// The filters the polls ran under. A whole session of 0-spot polls with a
// mode the enabled tracks weren't authored for is a settings problem, not GPS.
{
  const cfg = ev.filter((e) => e.event === "tour_config" || e.event === "mode_changed");
  for (const c of cfg) {
    const tracks = Array.isArray(c.tracks) ? (c.tracks as unknown[]).join(",") : "";
    if (c.event === "tour_config") console.log(`  config: mode=${c.mode} (${c.modePreference}) style=${c.style} tracks=${tracks || "(all)"}`);
    else console.log(`  mode changed ${c.from} → ${c.to} at ${c.ts}`);
  }
  const probes = ev.filter((e) => e.event === "empty_nearby_probe");
  const hidden = probes.filter((p) => (num(p, "hiddenByMode") ?? 0) > 0).length;
  if (hidden) console.log(`  ⚠️  ${hidden}/${probes.length} empty polls had stories hidden by the activity mode.`);
  else if (probes.length) console.log(`  ${probes.length} empty polls probed: nothing hidden by mode.`);
}
console.log(`  ok ${ok.length}   unchanged ${unchanged.length}   failed ${failed.length}   skipped ${skipped.length}`);
if (failed.length) {
  const why = new Map<string, number>();
  for (const f of failed) why.set(String(f.error), (why.get(String(f.error)) ?? 0) + 1);
  for (const [k, v] of why) console.log(`  ⚠️  ${v}× ${k}`);
}
const throttled = skipped.filter((e) => e.reason === "throttled").length;
if (throttled > ok.length) {
  console.log(`  ⚠️  ${throttled} throttled vs ${ok.length} served — throttle may be too slow for the walk.`);
}

// ─── The near-miss table: the heart of it ───────────────────────────────────
// Closest approach to any spot that never triggered.
type Near = { title: string; min: number; radius: number; audio: boolean };
const nearest = new Map<string, Near>();
for (const e of ok) {
  const t = String(e.nearestTitle ?? "");
  if (!t) continue;
  const d = num(e, "nearestM") ?? Infinity;
  const r = num(e, "nearestRadiusM") ?? 0;
  const prev = nearest.get(t);
  if (!prev || d < prev.min) {
    nearest.set(t, { title: t, min: d, radius: r, audio: e.nearestHasAudio === true });
  }
}

// "up_next" = the scheduler aimed at this spot at some point (the new
// planner's analogue of the old "entered the trigger").
const entered = new Set(ev.filter((e) => e.event === "up_next").map((e) => String(e.title)));
const played = ev.filter((e) => e.event === "play_start");
const playedTitles = new Set(played.map((e) => String(e.title)));

console.log("\nCLOSEST APPROACH (spots that were nearest at some point)");
const rows = [...nearest.values()].sort((a, b) => a.min - b.min);
for (const r of rows.slice(0, 20)) {
  const status = playedTitles.has(r.title)
    ? "PLAYED"
    : entered.has(r.title)
      ? "was up next, never played"
      : r.min <= r.radius
        ? "!! inside radius but never entered"
        : `missed by ${(r.min - r.radius).toFixed(0)}m`;
  const flag = !r.audio ? " (no audio)" : "";
  console.log(`  ${r.min.toFixed(0).padStart(5)}m  r=${String(r.radius).padStart(3)}  ${r.title.slice(0, 34).padEnd(36)} ${status}${flag}`);
}

// ─── Why targeted spots didn't play ─────────────────────────────────────────
const skippedSpots = ev.filter((e) => e.event === "spot_skipped");
const passed = ev.filter((e) => e.event === "spot_passed");
const replaced = ev.filter((e) => e.event === "target_replaced");
const fillinSkipped = ev.filter((e) => e.event === "fillin_skipped");

console.log("\nPLAYBACK");
console.log(`  played ${played.length}   targeted ${entered.size}`);
const roles = new Map<string, number>();
for (const p of played) roles.set(String(p.role ?? "?"), (roles.get(String(p.role ?? "?")) ?? 0) + 1);
if (roles.size) console.log(`  by role: ${[...roles].map(([k, v]) => `${v}× ${k}`).join(", ")}`);
if (passed.length) {
  const titles = [...new Set(passed.map((e) => String(e.title)))];
  console.log(`  passed before playing (${passed.length}×): ${titles.slice(0, 8).join(", ")}`);
}
if (replaced.length) console.log(`  target re-aimed ${replaced.length}× (a fresher/preferred spot came into view)`);
if (fillinSkipped.length) console.log(`  fill-ins held back ${fillinSkipped.length}× (no room before the next spot)`);
const noAudio = skippedSpots.filter((e) => e.reason === "no_audio");
if (noAudio.length) {
  const titles = [...new Set(noAudio.map((e) => String(e.title)))];
  console.log(`  ⚠️  triggered but NO PUBLISHED AUDIO: ${titles.join(", ")}`);
}

// ─── Audio route / session (what the car actually heard) ────────────────────
// Route, interruption and keepalive events were added after the CarPlay
// dropout drives of 2026-08-30..09-02, whose logs could not tell a car
// session from a speaker session. Older logs simply have none of these.
const routeStart = ev.find((e) => e.event === "audio_route");
const routeChanges = ev.filter((e) => e.event === "audio_route_change");
const interruptions = ev.filter((e) => e.event === "audio_interruption");
const keepalive = ev.filter((e) => e.event === "keepalive_start" || e.event === "keepalive_stop");
const playState = ev.filter((e) => ["play_stop", "play_parked", "play_resume", "play_pause"].includes(e.event));
const sessionErrors = ev.filter((e) => e.event === "audio_session_error" || e.event === "audio_media_reset");
const remote = ev.filter((e) => e.event === "remote_command");

console.log("\nAUDIO");
if (!routeStart && !routeChanges.length && !interruptions.length && !keepalive.length && !playState.length) {
  console.log("  no route/session events — app build predates audio diagnostics");
} else {
  if (routeStart) {
    console.log(`  route at start: ${JSON.stringify(routeStart.outputs)}  external=${String(routeStart.external)}`);
  }
  for (const r of routeChanges) {
    console.log(`  ${r.ts} route ${String(r.reason)}: ${JSON.stringify(r.from)} → ${JSON.stringify(r.to)}`);
  }
  for (const i of interruptions) {
    const extra = i.type === "ended" ? ` shouldResume=${String(i.shouldResume)}` : i.reason ? ` (${String(i.reason)})` : "";
    console.log(`  ${i.ts} interruption ${String(i.type)}${extra}`);
  }
  for (const k of keepalive) {
    console.log(`  ${k.ts} ${k.event} ${String(k.reason)}${k.ok === false ? "  ⚠️ FAILED" : ""}`);
  }
  for (const s of playState) console.log(`  ${s.ts} ${s.event} ${String(s.reason)}`);
  for (const s of sessionErrors) console.log(`  ⚠️  ${s.ts} ${s.event} ${String(s.error ?? "")}`);
  if (remote.length) console.log(`  remote commands: ${remote.map((r) => String(r.command)).join(", ")}`);
  const unfinished = ev.filter((e) => e.event === "play_source").length
    - ev.filter((e) => e.event === "play_finish").length
    - playState.filter((e) => e.event === "play_stop").length;
  if (unfinished > 0) console.log(`  ⚠️  ${unfinished} play(s) with neither play_finish nor play_stop`);
}

// ─── Verdict ────────────────────────────────────────────────────────────────
console.log("\nVERDICT");
const nearMisses = rows.filter((r) => !entered.has(r.title) && r.min > r.radius && r.min < r.radius + 30);
if (!fixes.length) {
  console.log("  Location never reached the app — check Always permission / background mode.");
} else if (ok.length === 0) {
  console.log("  No successful fetches — the phone could not reach the server on the walk.");
} else if (nearMisses.length) {
  console.log(`  ${nearMisses.length} spot(s) came close but stayed outside their radius:`);
  for (const n of nearMisses.slice(0, 8)) {
    console.log(`    ${n.title}: closest ${n.min.toFixed(0)}m vs radius ${n.radius}m`);
  }
  console.log("  → GPS error and/or radii too small. Widening these spots is the fix.");
} else {
  console.log("  No obvious trigger failure in this session; inspect the tables above.");
}
console.log("");
